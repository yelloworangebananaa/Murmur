// Folder sync decisions against an in-memory disk, plus the real-folder adapter's refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { folderSync, memDisk, fsDisk } from '../src/room/sync.ts';
import { MAX_FILE } from '../src/room/room.ts';
import { sha256 } from '../src/shared.ts';

const h = (s: string) => sha256(Buffer.from(s));
const b64 = (s: string) => Buffer.from(s).toString('base64');
function make(disk: Record<string, string>, known: Record<string, string>) {
  const d = memDisk(disk, known), sent: any[] = [], ui: any[] = [];
  const s = folderSync(d, { send: m => sent.push(m), emit: m => ui.push(m), who: () => ({ name: 'me', color: '#fff' }) });
  const text = (p: string) => d.read(p)?.toString() ?? null;
  const out = () => sent.map(m => m.deleted ? ['delete', m.path] : ['put', m.path, Buffer.from(m.b64, 'base64').toString(), m.base === undefined ? '-' : m.base === h('v1') ? 'v1' : '?']);
  return { d, s, sent, ui, text, out };
}
async function reconnect(x: ReturnType<typeof make>, room: Record<string, string>) {
  x.s.welcome();
  for (const [path, v] of Object.entries(room)) x.s.remote({ t: 'file', path, hash: h(v), b64: b64(v), snapshot: true });
  await x.s.synced();
}

// [case, room, disk, known] -> [disk after, messages sent, known after]
const TABLE: [string, string | null, string | null, string | null, string | null, any[], string | null][] = [
  ['same everywhere', 'v1', 'v1', null, 'v1', [], 'v1'],
  ['room changed, untouched here: take it', 'v2', 'v1', 'v1', 'v2', [], 'v2'],
  ['new to us: download', 'v1', null, null, 'v1', [], 'v1'],
  ['new on both sides: the room copy wins', 'v2', 'mine', null, 'v2', [], 'v2'],
  ['edited offline, room unchanged: send with base', 'v1', 'v2', 'v1', 'v2', [['put', 'f', 'v2', 'v1']], 'v2'],
  ['edited offline and in the room: send, hub merges', 'v3', 'v2', 'v1', 'v2', [['put', 'f', 'v2', 'v1']], 'v2'],
  ['deleted offline: send the delete', 'v1', null, 'v1', null, [['delete', 'f']], null],
  ['deleted offline while the room edited it: delete still wins', 'v2', null, 'v1', null, [['delete', 'f']], null],
  ['room deleted it, untouched here: delete', null, 'v1', 'v1', null, [], null],
  ['room deleted it, edited here: send as new', null, 'v2', 'v1', 'v2', [['put', 'f', 'v2', '-']], 'v2'],
  ['new here: send', null, 'v1', null, 'v1', [['put', 'f', 'v1', '-']], 'v1'],
  ['gone everywhere: forget', null, null, 'v1', null, [], null],
];
for (const [name, room, disk, known, diskAfter, sends, knownAfter] of TABLE) {
  test(`sync reconcile: ${name}`, async () => {
    const x = make(disk ? { f: disk } : {}, known ? { f: h(known) } : {});
    await reconnect(x, room ? { f: room } : {});
    assert.equal(x.text('f'), diskAfter);
    assert.deepEqual(x.out(), sends);
    assert.equal(x.d.known().get('f'), knownAfter === null ? undefined : h(knownAfter));
    assert.deepEqual(x.ui.at(-1), { t: 'files', paths: knownAfter ? ['f'] : [] });
  });
}

test('sync live: remote files apply unless an unsent local edit is on disk', async () => {
  const x = make({ a: 'v1', b: 'v1', c: 'v1' }, {});
  await reconnect(x, { a: 'v1', b: 'v1', c: 'v1' });
  x.s.remote({ t: 'file', path: 'a', hash: h('v2'), b64: b64('v2'), by: 'sam', color: '#0f0' });
  assert.equal(x.text('a'), 'v2');
  assert.deepEqual(x.ui.at(-1), { t: 'file', path: 'a', by: 'sam', color: '#0f0', deleted: false });
  x.d.write('b', Buffer.from('mine')); // edited, watcher not yet flushed
  x.s.remote({ t: 'file', path: 'b', hash: h('v3'), b64: b64('v3') });
  assert.equal(x.text('b'), 'mine');
  assert.deepEqual(x.out(), [['put', 'b', 'mine', 'v1']]);
  x.s.remote({ t: 'file', path: 'c', deleted: true });
  assert.equal(x.text('c'), null);
  x.s.remote({ t: 'file', path: '.git/config', hash: h('x'), b64: b64('x') });
  assert.equal(x.text('.git/config'), null);
  assert.deepEqual(x.s.paths().sort(), ['a', 'b']);
});

test('sync live: local edits and deletes are sent once, only while online', async () => {
  const x = make({ a: 'v1' }, {});
  await x.s.local(['a']);
  assert.deepEqual(x.out(), []); // offline: left for reconcile
  await reconnect(x, { a: 'v1' });
  x.d.write('a', Buffer.from('v2'));
  await x.s.local(['a']); await x.s.local(['a']);
  x.d.write('a', null);
  await x.s.local(['a']);
  x.d.write('dir/n', Buffer.from('n'));
  await x.s.local(['dir']);
  assert.deepEqual(x.out(), [['put', 'a', 'v2', 'v1'], ['delete', 'a'], ['put', 'dir/n', 'n', '-']]);
  assert.deepEqual(x.ui.find(m => m.t === 'file'), { t: 'file', path: 'a', by: 'me', color: '#fff' });
  x.s.offline();
  await x.s.synced(); // no snapshot in progress: ignored, nothing deleted
  assert.equal(x.text('dir/n'), 'n');
});

test('sync fs adapter: no symlinks out, no huge files, .gitignore respected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'murmur-sync-')), outside = mkdtempSync(join(tmpdir(), 'murmur-out-'));
  writeFileSync(join(outside, 'secret'), 'S');
  symlinkSync(join(outside, 'secret'), join(root, 'link'));
  symlinkSync(outside, join(root, 'linkdir'));
  writeFileSync(join(root, 'big'), Buffer.alloc(MAX_FILE + 1));
  writeFileSync(join(root, 'ok.txt'), 'ok');
  writeFileSync(join(root, 'ignored.txt'), 'i');
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'x'), 'x');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const d = fsDisk(root);
  try {
    assert.equal(d.read('link'), null);
    assert.equal(d.read('linkdir/secret'), null);
    assert.equal(d.read('big'), null);
    assert.equal(String(d.read('ok.txt')), 'ok');
    assert.equal(d.write('link', Buffer.from('x')), false);
    assert.equal(d.write('linkdir/new', Buffer.from('x')), false);
    assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'S');
    assert.equal(existsSync(join(outside, 'new')), false);
    assert.ok(d.write('sub/new.txt', Buffer.from('n')));
    assert.deepEqual((await d.files()).sort(), ['.gitignore', 'big', 'ok.txt', 'sub/new.txt']);
    assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /\.murmur\//);
    d.saveKnown(new Map([['ok.txt', 'h']]));
  } finally { d.close(); }
  assert.deepEqual(fsDisk(root).known(), new Map([['ok.txt', 'h']]));
});
