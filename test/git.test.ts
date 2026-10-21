import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addWorktree, removeWorktree, snapshot, diff, mergeCheck, integrate } from '../src/node/git.ts';

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@x', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'murmur-git-'));
  g(d, 'init', '-q', '-b', 'main');
  writeFileSync(join(d, 'a.txt'), 'one\n');
  writeFileSync(join(d, '.gitignore'), 'ignored.log\n');
  g(d, 'add', '.'); g(d, 'commit', '-qm', 'init');
  return d;
}

test('worktree add/remove; dirty removal refused', async () => {
  const r = repo();
  const wt = await addWorktree(r, 'L1', 'murmur/S/L1', 'HEAD');
  assert.equal(wt, join(r, '.murmur', 'wt', 'L1'));
  assert.ok(existsSync(join(wt, 'a.txt')));
  assert.match(readFileSync(join(r, '.git/info/exclude'), 'utf8'), /^\.murmur\/$/m);
  assert.equal(g(r, 'status', '--porcelain'), '');
  writeFileSync(join(wt, 'new.txt'), 'x');
  await assert.rejects(removeWorktree(r, wt));
  assert.ok(existsSync(wt));
  await removeWorktree(r, wt, true);
  assert.ok(!existsSync(wt));
});

test('snapshot never touches index/HEAD/worktree, excludes .env, skips unchanged', async () => {
  const r = repo();
  writeFileSync(join(r, 'a.txt'), 'two\n');
  writeFileSync(join(r, 'b.txt'), 'new\n');
  writeFileSync(join(r, '.env'), 'SECRET=1\n');
  writeFileSync(join(r, 'ignored.log'), 'x\n');
  g(r, 'add', 'b.txt');
  const status = g(r, 'status', '--porcelain=v2');
  const head = g(r, 'rev-parse', 'HEAD');
  const mtime = statSync(join(r, '.git/index')).mtimeMs;
  const s1 = await snapshot(r, 'refs/murmur/S/L', undefined);
  assert.equal(s1.changed, true);
  assert.equal(statSync(join(r, '.git/index')).mtimeMs, mtime); // before status, which may refresh the index itself
  assert.equal(g(r, 'status', '--porcelain=v2'), status);
  assert.equal(g(r, 'rev-parse', 'HEAD'), head);
  assert.equal(g(r, 'rev-parse', 'refs/murmur/S/L'), s1.commit);
  const files = g(r, 'ls-tree', '--name-only', s1.commit!).split('\n');
  assert.deepEqual(files.sort(), ['.gitignore', 'a.txt', 'b.txt']);
  assert.equal(g(r, 'show', `${s1.commit}:a.txt`), 'two');
  const s2 = await snapshot(r, 'refs/murmur/S/L', s1.commit!);
  assert.deepEqual([s2.changed, s2.commit], [false, s1.commit]);
  writeFileSync(join(r, 'a.txt'), 'three\n');
  const s3 = await snapshot(r, 'refs/murmur/S/L', s1.commit!);
  assert.equal(s3.changed, true);
  assert.equal(g(r, 'rev-parse', `${s3.commit}^`), s1.commit);
});

test('diff redacts secrets and skips denylisted files', async () => {
  const r = repo();
  const base = g(r, 'rev-parse', 'HEAD');
  writeFileSync(join(r, 'a.txt'), 'one\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123\n');
  writeFileSync(join(r, 'c.txt'), 'c\n');
  writeFileSync(join(r, '.env.local'), 'X=1\n');
  writeFileSync(join(r, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
  const files = await diff(r, base);
  const by = Object.fromEntries(files.map(f => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['a.txt', 'bin.dat', 'c.txt']);
  assert.ok(!by['a.txt'].patch.includes('ghp_abc'));
  assert.match(by['a.txt'].patch, /\[REDACTED\]/);
  assert.deepEqual([by['a.txt'].added, by['a.txt'].removed], [1, 0]);
  assert.deepEqual([by['c.txt'].added, by['c.txt'].patch.includes('+c')], [1, true]);
  assert.equal(by['bin.dat'].patch, '');
  assert.equal(by['c.txt'].blobSha, g(r, 'hash-object', 'c.txt'));
});

test('mergeCheck reports conflicting path; integrate merges clean refs', async () => {
  const r = repo();
  const bare = mkdtempSync(join(tmpdir(), 'murmur-bare-'));
  g(bare, 'init', '-q', '--bare', '-b', 'main');
  g(r, 'remote', 'add', 'origin', bare); g(r, 'push', '-q', 'origin', 'main');
  const mk = (name: string, file: string, body: string) => {
    g(r, 'checkout', '-q', '-b', name, 'main'); writeFileSync(join(r, file), body); g(r, 'commit', '-qam', name, '--allow-empty');
    if (!g(r, 'ls-files', file)) { g(r, 'add', file); g(r, 'commit', '-qm', name); }
    return g(r, 'rev-parse', 'HEAD');
  };
  const A = mk('A', 'a.txt', 'alice\n'), B = mk('B', 'a.txt', 'bob\n'), C = mk('C', 'c.txt', 'carol\n');
  g(r, 'checkout', '-q', 'main');
  assert.deepEqual(await mergeCheck(r, A, B), { clean: false, conflictPaths: ['a.txt'] });
  assert.deepEqual(await mergeCheck(r, A, C), { clean: true, conflictPaths: [] });
  const i1 = await integrate(r, A, 'murmur/S', 'origin', 'main');
  assert.equal(i1.ok, true);
  const i2 = await integrate(r, C, 'murmur/S', 'origin', 'main');
  assert.equal(i2.ok, true);
  assert.equal(g(bare, 'show', 'murmur/S:a.txt'), 'alice');
  assert.equal(g(bare, 'show', 'murmur/S:c.txt'), 'carol');
  const i3 = await integrate(r, B, 'murmur/S', 'origin', 'main');
  assert.deepEqual([i3.ok, i3.conflictPaths], [false, ['a.txt']]);
});

test('snapshot keeps tracked denylisted files at their HEAD version', async () => {
  const r = repo();
  writeFileSync(join(r, '.env.example'), 'KEY=placeholder\n');
  g(r, 'add', '.env.example'); g(r, 'commit', '-qm', 'example');
  writeFileSync(join(r, '.env.example'), 'KEY=real-secret-value\n');
  writeFileSync(join(r, 'a.txt'), 'changed\n');
  const s = await snapshot(r, 'refs/murmur/S/L2', undefined);
  assert.equal(g(r, 'show', `${s.commit}:.env.example`), 'KEY=placeholder');
});
