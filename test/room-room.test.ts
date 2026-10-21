// Room domain (no sockets) plus the hub's per-IP lockout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { Room, MAX_HOPS, type Member, type Out } from '../src/room/room.ts';
import { createRoomHub } from '../src/room/hub.ts';
import { connect } from '../src/room/wire.ts';
import { sha256 } from '../src/shared.ts';

function setup() {
  const room = new Room({ id: 'r', name: 'demo', key: 'k' });
  const join = (id: string, agent: string) => {
    const [p] = room.join({ peerId: id, name: id, folder: '', os: '' });
    room.receive(p, { t: 'agents', list: [{ id: `${id}-ag`, name: agent, cli: 'claude', status: 'idle' }] });
    return p;
  };
  return { room, A: join('a', 'Ann'), B: join('b', 'Bob'), C: join('c', 'Cy') };
}
const wakes = (out: Out[]) => out.filter(o => o.m.t === 'wake').map(o => [o.to!.id, (o.m as any).hops]);
const notes = (out: Out[]) => out.flatMap(o => o.m.t === 'feed' && o.m.ev.kind === 'note' ? [o.m.ev.text] : []);
const file = (path: string, s: string, base?: string) => ({ t: 'file' as const, path, b64: Buffer.from(s).toString('base64'), base });

test('room: joining sends welcome, snapshot, synced, history to the joiner; presence and a note to all', () => {
  const room = new Room({ id: 'r', name: 'demo', key: 'k', files: { 'a.txt': { b64: 'eA==', hash: 'h', by: 'x', at: 0 } } });
  const [p, out] = room.join({ peerId: 'p', name: 'sam', folder: '/f', os: 'linux' });
  assert.deepEqual(out.filter(o => o.to === p).map(o => o.m.t), ['welcome', 'file', 'synced', 'history']);
  assert.deepEqual(out.filter(o => !o.to).map(o => o.m.t), ['presence', 'feed']);
  assert.deepEqual(notes(out), ['sam joined']);
  // A stale member (replaced by a reconnect of the same computer) leaving changes nothing.
  room.join({ peerId: 'p', name: 'sam', folder: '/f', os: 'linux' });
  assert.deepEqual(room.leave(p), []);
});

test('room: @all wakes every agent except the sender; @Name wakes one', () => {
  const { room, A, B, C } = setup();
  assert.deepEqual(wakes(room.receive(A, { t: 'feed', agentId: 'a-ag', text: '@all go', hops: 0 })), [['b', 1], ['c', 1]]);
  assert.deepEqual(wakes(room.receive(B, { t: 'say', text: '@all go' })), [['a', 0], ['b', 0], ['c', 0]]); // a human wakes their own agent too
  assert.deepEqual(wakes(room.receive(C, { t: 'say', text: 'hi @bob' })), [['b', 0]]);
  assert.deepEqual(wakes(room.receive(C, { t: 'feed', agentId: 'not-mine', text: '@all' })), []); // agent ids are per owner
});

test(`room: the ${MAX_HOPS + 1}th agent-to-agent hop pauses with a note`, () => {
  const { room, A } = setup();
  assert.deepEqual(wakes(room.receive(A, { t: 'feed', agentId: 'a-ag', text: '@Bob more', hops: MAX_HOPS - 1 })), [['b', MAX_HOPS]]);
  const out = room.receive(A, { t: 'feed', agentId: 'a-ag', text: '@Bob more', hops: MAX_HOPS });
  assert.deepEqual(wakes(out), []);
  assert.match(notes(out)[0], /Paused the agent back-and-forth/);
  assert.deepEqual(room.feed.at(-2)!.to, ['Bob']); // the message itself is still shown
});

test('room: a stale-base edit is merged and sent back to the sender too', () => {
  const { room, A, B } = setup();
  const v1 = 'a\nb\nc\n';
  let out = room.receive(A, file('x.txt', v1));
  assert.ok(out.every(o => o.except === A)); // the author already has it
  room.receive(B, file('x.txt', 'B\nb\nc\n', sha256(v1)));
  out = room.receive(A, file('x.txt', 'a\nb\nA\n', sha256(v1))); // A had not seen B's edit
  assert.deepEqual(notes(out), ['Merged simultaneous edits to x.txt (b + a).']);
  const f = out.find(o => o.m.t === 'file')!;
  assert.equal(f.except, undefined);
  assert.equal(Buffer.from((f.m as any).b64, 'base64').toString(), 'B\nb\nA\n');
  // Blocked or unsafe paths never enter the room.
  for (const path of ['.git/config', '../x', '.env']) assert.deepEqual(room.receive(A, file(path, 'x')), []);
});

test('room: chat is capped per 10 s; file sync is not', () => {
  const { room, A } = setup(); // setup already spent 1 post (agents)
  let fed = 0;
  for (let i = 0; i < 130; i++) fed += room.receive(A, { t: 'say', text: `m${i}` }).length ? 1 : 0;
  assert.equal(fed, 119);
  assert.equal(room.receive(A, file('late.txt', 'x')).length, 1);
});

test('hub: an address with too many wrong links is locked out', async () => {
  const hub = await createRoomHub({ dataDir: mkdtempSync(join(tmpdir(), 'murmur-room-')), port: 0, host: '127.0.0.1' });
  const { id } = hub.createRoom('r');
  const tryKey = () => connect(new WebSocket(`ws://127.0.0.1:${hub.port}/ws`), id, 'wrong', { peerId: 'p', name: 'x', folder: '' });
  try {
    for (let i = 0; i < 10; i++) assert.deepEqual(await tryKey(), { denied: 'room not found or wrong link' });
    assert.deepEqual(await tryKey(), { denied: 'too many wrong links from your address; try again later' });
  } finally { await hub.close(); }
});

test('room: host sets the agent reply limit; null means unlimited; it persists and is announced', () => {
  const { room, A } = setup();
  const out = room.setMaxHops(2);
  assert.deepEqual(notes(out), ['Agent reply limit set to 2 by the host.']);
  assert.equal((out.find(o => o.m.t === 'presence')!.m as any).maxHops, 2);
  assert.deepEqual(wakes(room.receive(A, { t: 'feed', agentId: 'a-ag', text: '@Bob more', hops: 1 })), [['b', 2]]);
  assert.deepEqual(wakes(room.receive(A, { t: 'feed', agentId: 'a-ag', text: '@Bob more', hops: 2 })), []);
  assert.deepEqual(notes(room.setMaxHops(null)), ['Agent reply limit set to unlimited by the host.']);
  assert.deepEqual(wakes(room.receive(A, { t: 'feed', agentId: 'a-ag', text: '@Bob more', hops: 500 })), [['b', 501]]);
  assert.equal(new Room(JSON.parse(JSON.stringify(room))).maxHops, null);
  assert.equal(new Room({ id: 'r', name: 'old', key: 'k' }).maxHops, MAX_HOPS); // rooms saved before the setting
});

test('okHops: whole numbers 0-1000 or null (unlimited); anything else is invalid', async () => {
  const { okHops } = await import('../src/room/wire.ts');
  assert.equal(okHops(0), 0); assert.equal(okHops(1000), 1000); assert.equal(okHops(null), null);
  for (const bad of [-1, 1001, 2.5, '4', undefined, NaN, Infinity]) assert.equal(okHops(bad), undefined, String(bad));
});
