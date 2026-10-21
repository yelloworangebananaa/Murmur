// Room wire handshake and message catalog over an in-memory socket pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accept, connect, deny, memPair, session, newNonce, peerMsg, hubMsg, agentName, type Sock } from '../src/room/wire.ts';

const KEY = 'room-key-secret';
const tick = () => new Promise(r => setTimeout(r, 5));
const closed = (s: Sock) => new Promise<void>(r => s.readyState === 3 ? r() : s.on('close', () => r()));
// Record what a socket sends; `raw` sends past the recorder.
const spy = (s: Sock) => { const sent: (string | Buffer)[] = [], raw = s.send.bind(s); s.send = d => { sent.push(d); raw(d); }; return { sent, raw }; };
const me = { peerId: 'p1', name: ' sam‮  x ', folder: '/tmp/x', os: 'plan9' };

test('wire: right key gets a channel both ways; messages are validated', async () => {
  const [h, p] = memPair(), { sent } = spy(p);
  const hub = accept(h, id => id === 'r1' ? KEY : undefined), peer = connect(p, 'r1', KEY, me);
  const a = await hub;
  assert.ok(a && a !== 'denied');
  assert.deepEqual(a.hello, { peerId: 'p1', name: 'sam x', folder: '/tmp/x', os: '' });
  a.ch.send({ t: 'welcome', room: { id: 'r1', name: 'demo' }, color: '#fff' });
  a.ch.send({ t: 'history', feed: 'nope' }); // invalid: dropped, not fatal
  a.ch.send({ t: 'wake', agentId: 'x', from: 'a\u0000b', text: 'hi', hops: '2' });
  const c = await peer;
  assert.ok(c && !('denied' in c));
  assert.equal(c.welcome.room.name, 'demo');
  const got: any[] = [], hubGot: any[] = [];
  c.ch.on(m => got.push(m)); a.ch.on(m => hubGot.push(m));
  c.ch.send({ t: 'agents', list: 'x' }); // invalid
  c.ch.send({ t: 'say', text: 'hello' });
  await tick();
  assert.deepEqual(got, [{ t: 'wake', agentId: 'x', from: 'ab', text: 'hi', hops: 2 }]);
  assert.deepEqual(hubGot.map(m => [m.t, m.text]), [['say', 'hello']]);
  assert.ok(sent.every(f => !String(f).includes(KEY)), 'the room key never travels');
});

test('wire: wrong key or unknown room is denied', async () => {
  for (const [room, key] of [['r1', 'wrong'], ['r2', KEY]]) {
    const [h, p] = memPair();
    const peer = connect(p, room, key, me);
    assert.equal(await accept(h, id => id === 'r1' ? KEY : undefined), 'denied');
    deny(h, 'room not found or wrong link');
    assert.deepEqual(await peer, { denied: 'room not found or wrong link' });
  }
});

test('wire: hub drops a second hello, a binary hello and a replayed frame', async () => {
  // second hello (plaintext after the handshake)
  let [h, p] = memPair(), s = spy(p);
  let hub = accept(h, () => KEY);
  void connect(p, 'r1', KEY, me);
  assert.ok(await hub && h.readyState === 1);
  s.raw(s.sent.find(f => typeof f === 'string')!);
  await closed(h);

  // replay: the same sealed frame twice
  [h, p] = memPair(); s = spy(p);
  hub = accept(h, () => KEY);
  const peer = connect(p, 'r1', KEY, me);
  const a = await hub;
  assert.ok(a && a !== 'denied');
  a.ch.send({ t: 'welcome', room: { id: 'r1', name: 'x' }, color: '' });
  const c = await peer;
  assert.ok(c && !('denied' in c));
  const got: any[] = [];
  a.ch.on(m => got.push(m));
  c.ch.send({ t: 'say', text: 'once' });
  s.raw(s.sent.at(-1)!);
  await closed(h);
  assert.deepEqual(got.map(m => m.text), ['once']);

  // binary before hello
  [h, p] = memPair();
  hub = accept(h, () => KEY);
  p.send(Buffer.from('x'));
  assert.equal(await hub, null);
});

test('wire: peer refuses a sealed frame before the welcome, and times out a silent peer', async () => {
  const [h, p] = memPair();
  const peer = connect(p, 'r1', KEY, me);
  // A fake hub that knows the key but sends something other than welcome first.
  const nonce = newNonce();
  h.on('message', (raw: Buffer) => {
    const m = JSON.parse(String(raw)), s = session(KEY, nonce, m.nonce, true);
    s.open(Buffer.from(m.box, 'base64'));
    h.send(s.seal({ t: 'file', path: 'a', deleted: true }));
  });
  h.send(JSON.stringify({ t: 'challenge', nonce }));
  assert.equal(await peer, null);

  const [h2] = memPair();
  assert.equal(await accept(h2, () => KEY, 20), null);
  assert.equal(h2.readyState, 3);
});

test('catalog: agent names and peer messages are cleaned in one place', () => {
  assert.equal(agentName(' Ann <b>!'), 'Annb');
  const m = peerMsg({ t: 'agents', list: [{ id: 'a1', name: '!!', cli: 'claude', claims: ['x'] }, { id: 'bad id' }] });
  assert.deepEqual(m, { t: 'agents', list: [{ id: 'a1', name: 'agent', cli: 'claude', model: undefined, effort: undefined, status: '', doing: '', claims: ['x'] }] });
  assert.equal(peerMsg({ t: 'file', path: 1 }), null);
  assert.equal(peerMsg({ t: 'nope' }), null);
  assert.equal(hubMsg({ t: 'file', path: 'a', b64: 'x' }), null); // no hash
  assert.ok(hubMsg({ t: 'file', path: 'a', deleted: true }));
  assert.equal(hubMsg({ t: 'presence', peers: [] }), null);
});
