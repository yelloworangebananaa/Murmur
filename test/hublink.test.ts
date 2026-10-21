import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { hubLink, type Dial } from '../src/node/hublink.ts';

// In-memory socket: the test opens it, reads what the node sent, sends frames down, drops the connection.
function fakeHub() {
  const socks: any[] = [];
  const dial: Dial = (url, headers) => {
    const s: any = Object.assign(new EventEmitter(), { url, headers, readyState: 0, sent: [] as any[] });
    s.send = (x: string) => s.sent.push(JSON.parse(x));
    s.close = () => { s.readyState = 3; s.emit('close'); };
    s.open = () => { s.readyState = 1; s.emit('open'); };
    s.down = (f: object) => s.emit('message', JSON.stringify(f));
    socks.push(s);
    return s;
  };
  return { socks, dial };
}

test('hub link: hello first, outbox replays until acked, reconnects with backoff, ping answered', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { socks, dial } = fakeHub(), got: any[] = [];
    const link = hubLink({ url: 'http://hub:1', token: 'devtok', hello: () => ({ deviceId: 'D1' }), onFrame: f => got.push(f), dial });
    link.up('lane.status', { n: 1 }); // offline: queued
    link.connect();
    assert.equal(socks[0].url, 'ws://hub:1/ws/node');
    assert.equal(socks[0].headers.authorization, 'Bearer devtok');
    socks[0].open();
    assert.equal(link.online(), true);
    link.up('lane.events', { n: 2 });
    assert.deepEqual(socks[0].sent.map((f: any) => [f.t, f.seq]), [['hello', undefined], ['lane.status', 1], ['lane.events', 2]]);
    socks[0].down({ t: 'ping', d: {} });
    assert.equal(socks[0].sent.at(-1).t, 'pong');
    socks[0].down({ t: 'lane.prompt', d: { text: 'hi' } });
    socks[0].emit('message', 'not json');
    assert.deepEqual(got.map(f => f.t), ['lane.prompt']);

    // Unacked frames come back after a reconnect, same seqs.
    socks[0].close();
    assert.equal(socks.length, 1, 'waits before redialing');
    mock.timers.tick(1000);
    socks[1].open();
    assert.deepEqual(socks[1].sent.map((f: any) => f.seq), [undefined, 1, 2]);
    // Acked frames do not.
    socks[1].down({ t: 'ack', d: { seq: 1 } });
    socks[1].close();
    mock.timers.tick(1000);
    socks[2].open();
    assert.deepEqual(socks[2].sent.map((f: any) => f.seq), [undefined, 2]);

    link.close();
    mock.timers.tick(60_000);
    assert.equal(socks.length, 3, 'no redial after close');
  } finally { mock.timers.reset(); }
});
