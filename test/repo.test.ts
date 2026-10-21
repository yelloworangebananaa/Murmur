// LaneRepo and the push/resolve plumbing against a real bare "team remote".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pushRef, snapshot, resolveConflict } from '../src/node/git.ts';
import { openLaneRepo, takePathFrom } from '../src/node/repo.ts';

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@x', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
const has = (bare: string, ref: string) => { try { return g(bare, 'rev-parse', '--verify', '-q', ref); } catch { return null; } };
function team() {
  const root = mkdtempSync(join(tmpdir(), 'murmur-repo-')), bare = join(root, 'team.git'), clone = join(root, 'clone');
  g(root, 'init', '-q', '--bare', '-b', 'main', bare);
  g(root, 'clone', '-q', bare, clone);
  writeFileSync(join(clone, 'a.txt'), 'base\n');
  writeFileSync(join(clone, '.gitignore'), 'out/\n');
  g(clone, 'add', '.'); g(clone, 'commit', '-qm', 'init'); g(clone, 'push', '-q', 'origin', 'HEAD:main');
  return { bare, clone };
}

test('pushRef: custom ref, lease on the expected old commit, murmur-snap/ fallback when refs/murmur is refused', async () => {
  const { bare, clone } = team();
  writeFileSync(join(clone, 'a.txt'), 'one\n');
  const s1 = await snapshot(clone, 'refs/murmur/S/L', undefined);
  assert.equal(await pushRef(clone, 'origin', 'refs/murmur/S/L'), 'refs/murmur/S/L');
  assert.equal(has(bare, 'refs/murmur/S/L'), s1.commit);
  writeFileSync(join(clone, 'a.txt'), 'two\n');
  const s2 = await snapshot(clone, 'refs/murmur/S/L', s1.commit!);
  assert.equal(await pushRef(clone, 'origin', 'refs/murmur/S/L', 'f'.repeat(40)), null, 'stale lease refused');
  assert.equal(has(bare, 'refs/murmur/S/L'), s1.commit);
  assert.equal(await pushRef(clone, 'origin', 'refs/murmur/S/L', s1.commit!), 'refs/murmur/S/L');
  assert.equal(has(bare, 'refs/murmur/S/L'), s2.commit);

  // A host that only accepts branches gets the snapshot as refs/heads/murmur-snap/…
  const hook = join(bare, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nwhile read o n r; do case "$r" in refs/heads/*) ;; *) exit 1;; esac; done\n');
  chmodSync(hook, 0o755);
  g(clone, 'update-ref', 'refs/murmur/S/M', s2.commit!);
  assert.equal(await pushRef(clone, 'origin', 'refs/murmur/S/M'), 'refs/heads/murmur-snap/S/M');
  assert.equal(has(bare, 'refs/heads/murmur-snap/S/M'), s2.commit);
  assert.equal(has(bare, 'refs/murmur/S/M'), null);
});

test('resolveConflict / takePathFrom: take one path (or its deletion) from a ref onto the session branch', async () => {
  const { bare, clone } = team();
  g(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/murmur/S');
  g(clone, 'checkout', '-q', '-b', 'bob');
  writeFileSync(join(clone, 'a.txt'), 'bob\n'); writeFileSync(join(clone, 'b.txt'), 'other\n');
  g(clone, 'add', '.'); g(clone, 'commit', '-qm', 'bob');
  g(clone, 'push', '-q', 'origin', 'HEAD:refs/murmur/S/B');
  g(clone, 'update-ref', '-d', 'refs/murmur/S/B'); // only the remote has it: takePathFrom must fetch
  const tip = has(bare, 'refs/heads/murmur/S');
  const c = await takePathFrom(clone, 'murmur/S', 'a.txt', 'refs/murmur/S/B');
  assert.equal(has(bare, 'refs/heads/murmur/S'), c);
  assert.equal(g(bare, 'show', 'murmur/S:a.txt'), 'bob');
  assert.equal(g(bare, 'rev-parse', `${c}^`), tip);
  assert.throws(() => g(bare, 'show', 'murmur/S:b.txt'), 'only the named path moves');
  g(clone, 'rm', '-q', 'a.txt'); g(clone, 'commit', '-qm', 'rm');
  const del = await resolveConflict(clone, 'murmur/S', 'a.txt', 'HEAD', 'origin');
  assert.throws(() => g(bare, 'show', `${del}:a.txt`), 'deletion taken');
  await assert.rejects(resolveConflict(clone, 'nope', 'a.txt', 'HEAD', 'origin'), /no origin\/nope/);
});

const events = () => { const e = { diffs: [] as any[], snaps: [] as any[], errors: [] as string[] }; return { e, on: { diff: (f: any) => e.diffs.push(f), snapshot: (ref: string, commit: string) => e.snaps.push({ ref, commit }), error: (t: string) => e.errors.push(t) } }; };

test('LaneRepo: snapshot pushes to the lane ref; dispose removes the worktree only when nothing would be lost', async () => {
  const { bare, clone } = team();
  const { e, on } = events();
  const r = await openLaneRepo({ clone, laneId: 'L1', sessionId: 'S1' }, on);
  assert.equal(r.worktree, join(clone, '.murmur', 'wt', 'L1'));
  writeFileSync(join(r.worktree, 'new.txt'), 'hi\n');
  await r.snapshot();
  assert.deepEqual(e.snaps.map(s => s.ref), ['refs/murmur/S1/L1']);
  assert.equal(has(bare, 'refs/murmur/S1/L1'), e.snaps[0].commit);
  await r.snapshot();
  assert.equal(e.snaps.length, 1, 'unchanged worktree is not pushed again');
  assert.equal(await r.dispose(), true);
  assert.ok(!existsSync(r.worktree));
  assert.deepEqual(e.errors, []);

  // Secrets and ignored files never reach a snapshot, so their worktree stays.
  for (const [name, file] of [['L2', '.env'], ['L3', 'out/build.log']] as const) {
    const k = await openLaneRepo({ clone, laneId: name, sessionId: 'S1' }, events().on);
    execFileSync('mkdir', ['-p', join(k.worktree, 'out')]);
    writeFileSync(join(k.worktree, file), 'SECRET=1\n');
    assert.equal(await k.dispose(), false, file);
    assert.ok(existsSync(join(k.worktree, file)));
  }
  // A revoked lane never pushes or disposes.
  const v = await openLaneRepo({ clone, laneId: 'L4', sessionId: 'S1' }, on);
  v.revoke();
  writeFileSync(join(v.worktree, 'x.txt'), 'x\n');
  await v.snapshot();
  assert.equal(has(bare, 'refs/murmur/S1/L4'), null);
  assert.equal(await v.dispose(), false);
});

test('LaneRepo: resume from a pushed snapshot keeps the lease; integrate merges onto the session branch', async () => {
  const { bare, clone } = team();
  const a = await openLaneRepo({ clone, laneId: 'L1', sessionId: 'S1', base: 'main' }, events().on);
  writeFileSync(join(a.worktree, 'feat.txt'), 'v1\n');
  await a.stop(true);
  const first = has(bare, 'refs/murmur/S1/L1');
  assert.ok(first);
  g(clone, 'update-ref', '-d', 'refs/murmur/S1/L1');
  // Taken over elsewhere: start from the remote snapshot; the next push leases on it.
  const other = join(clone, '..', 'other');
  g(join(clone, '..'), 'clone', '-q', bare, other);
  const { e, on } = events();
  const b = await openLaneRepo({ clone: other, laneId: 'L1', sessionId: 'S1', base: 'main', fromRef: 'refs/murmur/S1/L1' }, on);
  assert.ok(existsSync(join(b.worktree, 'feat.txt')));
  writeFileSync(join(b.worktree, 'feat.txt'), 'v2\n');
  await b.snapshot();
  assert.equal(g(bare, 'rev-parse', 'refs/murmur/S1/L1^'), first);
  assert.deepEqual(e.errors, []);
  const i = await b.integrateInto('murmur/S1');
  assert.equal(i.ok, true);
  assert.equal(g(bare, 'show', 'murmur/S1:feat.txt'), 'v2');
  await b.stop(false);
});
