// A lane's git side: its worktree, the dirty-set watcher, snapshot → push to the team remote, integrate, cleanup.
// Owns fetch policy (best effort before reading a remote ref), the push lease (expected old = what we last pushed)
// and per-lane serialization. Callers never touch git ordering.
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { denied } from '../shared.ts';
import { addWorktree, removeWorktree, DiffWatcher, snapshot, pushRef, fetchRef, mergeCheck, integrate, resolveConflict, git, type DiffFile } from './git.ts';

const REMOTE = 'origin';
const SNAP_EVERY_MS = 5000;
// A ref the remote lacks (or an offline remote) leaves whatever copy we already have.
const fetchQuiet = (clone: string, ref: string) => fetchRef(clone, REMOTE, ref).catch(() => {});

export const checkMerge = async (clone: string, refA: string, refB: string) => {
  for (const r of [refA, refB]) await fetchQuiet(clone, r);
  return mergeCheck(clone, refA, refB);
};
// Take `path` as it is in fromRef onto the session branch; returns the new commit.
export const takePathFrom = async (clone: string, branch: string, path: string, fromRef: string) => {
  await fetchQuiet(clone, fromRef);
  return resolveConflict(clone, branch, path, fromRef, REMOTE);
};

export type LaneRepo = Awaited<ReturnType<typeof openLaneRepo>>;

export async function openLaneRepo(o: { clone: string; laneId: string; sessionId: string; base?: string; fromRef?: string },
  on: { diff(files: DiffFile[]): void; snapshot(ref: string, commit: string): void; error(text: string): void }) {
  const ref = `refs/murmur/${o.sessionId}/${o.laneId}`;
  if (o.fromRef) await fetchQuiet(o.clone, o.fromRef);
  const worktree = await addWorktree(o.clone, o.laneId, `murmur/${o.sessionId}/${o.laneId}`, o.fromRef ?? o.base ?? 'HEAD');
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).out.trim();
  const base = o.fromRef ? await git(o.clone, ['rev-parse', `${o.base ?? 'HEAD'}^{commit}`]).then(r => r.out.trim(), () => head) : head;
  let lastCommit = o.fromRef ? head : undefined, pushed = o.fromRef && o.fromRef === ref ? head : undefined;
  let snapAt = 0, timer: NodeJS.Timeout | undefined, chain = Promise.resolve(), frozen = false, lastDiff = '';

  // Serialized: snapshot → push (lease on what we last pushed) → report.
  const snap = (): Promise<void> => chain = chain.then(async () => {
    if (frozen) return;
    snapAt = Date.now();
    const r = await snapshot(worktree, ref, lastCommit);
    if (!r.commit || (!r.changed && pushed === r.commit)) return;
    lastCommit = r.commit;
    const at = await pushRef(worktree, REMOTE, ref, pushed);
    if (!at) return;
    pushed = r.commit;
    on.snapshot(at, r.commit);
  }).catch(e => on.error('snapshot: ' + e.message));
  const schedule = () => {
    if (timer || frozen) return;
    timer = setTimeout(() => { timer = undefined; snap(); }, Math.max(0, snapAt + SNAP_EVERY_MS - Date.now()));
  };
  const watcher = DiffWatcher(worktree, base, files => {
    const j = JSON.stringify(files);
    if (j === lastDiff) return;
    lastDiff = j;
    on.diff(files);
    schedule();
  });
  const quiet = () => { watcher.close(); clearTimeout(timer); timer = undefined; };

  // Everything in the worktree is on the remote: the last snapshot was pushed and nothing sits outside snapshots
  // (ignored files, denylisted secrets, files too big to snapshot).
  async function safeToRemove() {
    if (lastCommit !== pushed) return false;
    const st = (await git(worktree, ['status', '--porcelain', '--ignored', '--untracked-files=all', '-z'])).out.split('\0').filter(Boolean);
    return !st.some(e => e.startsWith('!!') || denied(e.slice(3)) || (statSync(join(worktree, e.slice(3)), { throwIfNoEntry: false })?.size ?? 0) > 1 << 20);
  }

  return {
    worktree, base, ref,
    nudge: () => watcher.nudge(),
    snapshot: snap,
    async integrateInto(branch: string) {
      await snap();
      return integrate(o.clone, lastCommit ?? base, branch, REMOTE, base);
    },
    // Stop watching; with final, take one last snapshot first.
    async stop(final: boolean) { quiet(); if (final) await snap(); },
    // The lane moved elsewhere: never snapshot or push again, keep the files.
    revoke() { quiet(); frozen = true; },
    // Remove the worktree if nothing in it would be lost. Returns whether it was removed.
    async dispose(): Promise<boolean> {
      quiet();
      await snap();
      if (frozen || !(await safeToRemove().catch(() => false))) return false;
      frozen = true;
      await removeWorktree(o.clone, worktree, true);
      return true;
    },
  };
}
