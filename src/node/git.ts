// Git plumbing for lanes. Every call is execFile('git', …), never a shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, readFileSync, statSync, mkdtempSync, rmSync, watch, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redact, denied } from '../shared.ts';

const pexec = promisify(execFile);
const IDENT = { GIT_AUTHOR_NAME: 'murmur', GIT_AUTHOR_EMAIL: 'murmur@localhost', GIT_COMMITTER_NAME: 'murmur', GIT_COMMITTER_EMAIL: 'murmur@localhost' };

// Resolves {out, code}; throws only when exit code is not in `ok`.
export async function git(cwd: string, args: string[], env?: Record<string, string>, ok = [0]): Promise<{ out: string; code: number }> {
  try {
    const { stdout } = await pexec('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 << 20 });
    return { out: stdout, code: 0 };
  } catch (e: any) {
    if (typeof e.code === 'number' && ok.includes(e.code)) return { out: e.stdout ?? '', code: e.code };
    throw new Error(`git ${args[0]} failed: ${String(e.stderr || e.message).trim()}`);
  }
}
const out = async (cwd: string, args: string[], env?: Record<string, string>) => (await git(cwd, args, env)).out.trim();

const tooBig = (abs: string) => { try { return statSync(abs).size > 1 << 20; } catch { return false; } };

export async function addWorktree(clone: string, laneId: string, branch: string, startPoint: string): Promise<string> {
  const path = join(clone, '.murmur', 'wt', laneId);
  const exclude = join(await out(clone, ['rev-parse', '--git-common-dir']).then(d => join(clone, d)), 'info', 'exclude');
  if (!(existsSync(exclude) && readFileSync(exclude, 'utf8').split('\n').includes('.murmur/'))) appendFileSync(exclude, '\n.murmur/\n');
  if (!existsSync(path)) await git(clone, ['worktree', 'add', '-q', '-B', branch, path, startPoint]);
  return path;
}

export async function removeWorktree(clone: string, path: string, force = false) {
  await git(clone, ['worktree', 'remove', ...(force ? ['--force'] : []), path]); // git itself refuses a dirty tree without --force
}

export type DiffFile = { path: string; added: number; removed: number; blobSha: string | null; patch: string };

export async function diff(wt: string, base: string): Promise<DiffFile[]> {
  const tracked = (await out(wt, ['diff', '--name-only', '-z', base])).split('\0');
  const untracked = (await out(wt, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0');
  const files: DiffFile[] = [];
  for (const [path, isNew] of [...tracked.map(p => [p, false] as const), ...untracked.map(p => [p, true] as const)]) {
    if (!path || denied(path) || tooBig(join(wt, path))) continue;
    const args = isNew ? ['--no-index', '--', '/dev/null', path] : [base, '--', path];
    const [a, r] = (await git(wt, ['diff', '--numstat', ...args], undefined, [0, 1])).out.split('\t');
    const binary = a === '-';
    const [added, removed] = binary ? [0, 0] : [Number(a) || 0, Number(r) || 0];
    const patch = binary ? '' : redact((await git(wt, ['diff', ...args], undefined, [0, 1])).out.slice(0, 256 << 10));
    files.push({ path, added, removed, blobSha: await blobSha(wt, path), patch });
  }
  return files;
}

export async function blobSha(wt: string, path: string): Promise<string | null> {
  try { return await out(wt, ['hash-object', '--', path]); } catch { return null; }
}

// Commit the worktree's current state to `ref` through a throwaway index; the real index, HEAD and files are untouched.
export async function snapshot(wt: string, ref: string, lastCommit?: string): Promise<{ commit: string | null; tree: string; changed: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-idx-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index'), ...IDENT };
  try {
    await git(wt, ['read-tree', 'HEAD'], env);
    await git(wt, ['add', '-A'], env);
    const drop = (await out(wt, ['ls-files', '-z'], env)).split('\0').filter(p => p && (denied(p) || tooBig(join(wt, p))));
    // Denylisted paths keep their HEAD version (absent if untracked); new content never enters the snapshot.
    if (drop.length) await git(wt, ['reset', '-q', 'HEAD', '--', ...drop], env);
    const tree = await out(wt, ['write-tree'], env);
    const parent = lastCommit ?? 'HEAD';
    if (tree === await out(wt, ['rev-parse', `${parent}^{tree}`])) return { commit: lastCommit ?? null, tree, changed: false };
    const commit = await out(wt, ['commit-tree', tree, '-p', parent, '-m', `murmur snapshot ${new Date().toISOString()}`], env);
    await git(wt, ['update-ref', ref, commit]);
    return { commit, tree, changed: true };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Returns the ref actually pushed (custom ref, or the branch fallback), or null if both were refused.
export async function pushRef(wt: string, remote: string, ref: string, expectedOld?: string): Promise<string | null> {
  for (const dst of [ref, ref.replace(/^refs\/murmur\//, 'refs/heads/murmur-snap/')]) {
    try { await git(wt, ['push', '-q', `--force-with-lease=${dst}:${expectedOld ?? ''}`, remote, `${ref}:${dst}`]); return dst; } catch {}
  }
  return null;
}

export const fetchRef = (clone: string, remote: string, ref: string) => git(clone, ['fetch', '-q', remote, `+${ref}:${ref}`]);

export async function mergeCheck(clone: string, refA: string, refB: string): Promise<{ clean: boolean; conflictPaths: string[] }> {
  const r = await git(clone, ['merge-tree', '--write-tree', '--name-only', '--no-messages', refA, refB], undefined, [0, 1]);
  return { clean: r.code === 0, conflictPaths: [...new Set(r.out.split('\n').slice(1).filter(Boolean))] };
}

const remoteTip = async (clone: string, remote: string, branch: string) => {
  try { await git(clone, ['fetch', '-q', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]); return await out(clone, ['rev-parse', `refs/remotes/${remote}/${branch}`]); } catch { return null; }
};

// Merge the lane's snapshot onto the session branch without a working tree; CAS push, retry once.
export async function integrate(clone: string, laneRef: string, branch: string, remote: string, base = 'HEAD'): Promise<{ ok: boolean; commit?: string; error?: string; conflictPaths?: string[] }> {
  let error = '';
  for (let i = 0; i < 2; i++) {
    const tip = await remoteTip(clone, remote, branch);
    const onto = tip ?? await out(clone, ['rev-parse', base]);
    const r = await git(clone, ['merge-tree', '--write-tree', '--name-only', '--no-messages', onto, laneRef], undefined, [0, 1]);
    const [tree, ...paths] = r.out.split('\n').filter(Boolean);
    if (r.code) return { ok: false, error: 'conflicts', conflictPaths: [...new Set(paths)] };
    const commit = await out(clone, ['commit-tree', tree, '-p', onto, '-p', laneRef, '-m', `murmur: integrate ${laneRef}`], IDENT);
    try { await git(clone, ['push', '-q', `--force-with-lease=refs/heads/${branch}:${tip ?? ''}`, remote, `${commit}:refs/heads/${branch}`]); return { ok: true, commit }; }
    catch (e: any) { error = e.message; }
  }
  return { ok: false, error };
}

// Take `path` from fromRef onto the session branch (plumbing on a temp index, no worktree), CAS push.
export async function resolveConflict(clone: string, branch: string, path: string, fromRef: string, remote: string): Promise<string> {
  const tip = await remoteTip(clone, remote, branch);
  if (!tip) throw new Error(`no ${remote}/${branch}`);
  const dir = mkdtempSync(join(tmpdir(), 'murmur-idx-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index'), ...IDENT };
  try {
    await git(clone, ['read-tree', tip], env);
    const entry = await out(clone, ['ls-tree', fromRef, '--', path]); // "<mode> blob <sha>\t<path>"
    if (entry) { const [mode, , sha] = entry.split(/\s+/); await git(clone, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`], env); }
    else await git(clone, ['update-index', '--force-remove', '--', path], env);
    const tree = await out(clone, ['write-tree'], env);
    const commit = await out(clone, ['commit-tree', tree, '-p', tip, '-m', `murmur: resolve ${path} from ${fromRef}`], env);
    await git(clone, ['push', '-q', `--force-with-lease=refs/heads/${branch}:${tip}`, remote, `${commit}:refs/heads/${branch}`]);
    return commit;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// fs.watch the worktree, recompute the dirty set 300 ms after the last change (or on nudge()).
export function DiffWatcher(wt: string, base: string, onDiff: (files: DiffFile[]) => void) {
  let timer: NodeJS.Timeout | undefined, busy = false, again = false;
  const run = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try { onDiff(await diff(wt, base)); } catch {}
    busy = false;
    if (again) { again = false; nudge(); }
  };
  const nudge = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  const w = watch(wt, { recursive: true }, (_e, f) => { if (!f || !/(^|[\\/])\.git([\\/]|$)/.test(String(f))) nudge(); });
  w.on('error', () => {});
  return { nudge, close: () => { clearTimeout(timer); w.close(); } };
}
