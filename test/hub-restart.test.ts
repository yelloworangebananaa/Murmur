// A hub restart mid-finish must not lose the integrate queue.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createHub } from '../src/hub/server.ts';
import { sha256 } from '../src/shared.ts';

const dir = mkdtempSync(join(tmpdir(), 'murmur-restart-'));
const socks: WebSocket[] = [];
after(() => socks.forEach(s => s.terminate()));

async function node(url: string) {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws/node', { headers: { authorization: 'Bearer tok-a' } });
  socks.push(ws);
  const frames: any[] = [];
  ws.on('message', m => frames.push(JSON.parse(String(m))));
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'hello', d: { boot: Math.random(), lanes: [] } }));
  const wait = async (t: string, laneId: string) => {
    for (const end = Date.now() + 3000; Date.now() < end; await new Promise(r => setTimeout(r, 10))) { const f = frames.find(f => f.t === t && f.d.laneId === laneId); if (f) return f; }
    throw new Error(`no ${t} for ${laneId}`);
  };
  return { ws, frames, wait, up: (t: string, d: unknown) => ws.send(JSON.stringify({ t, d })) };
}

test('integrate queue survives a hub restart', async () => {
  let hub = await createHub({ dataDir: dir, port: 0 });
  const run = (sql: string, ...a: any[]) => hub.db.prepare(sql).run(...a);
  run(`INSERT INTO workspace (id, name, git_remote, created_at) VALUES ('w', 'w', 'https://x/y', 0)`);
  run(`INSERT INTO user (id, name, created_at) VALUES ('alice', 'alice', 0)`);
  run(`INSERT INTO member (workspace_id, user_id, role) VALUES ('w', 'alice', 'owner')`);
  run('INSERT INTO web_session (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256('sid'), 'alice', Date.now() + 3_600_000);
  run(`INSERT INTO device (id, user_id, name, token_hash) VALUES ('devA', 'alice', 'a', ?)`, sha256('tok-a'));
  run(`INSERT INTO session (id, workspace_id, title, branch, created_by, created_at) VALUES ('s', 'w', 't', 'murmur/s', 'alice', 0)`);
  for (const [l, at] of [['l1', 1], ['l2', 2]]) run(`INSERT INTO lane (id, session_id, owner_user_id, device_id, mode, status, created_at) VALUES (?, 's', 'alice', 'devA', 'request', 'idle', ?)`, l, at);

  let n = await node(hub.url);
  await new Promise(r => setTimeout(r, 50));
  const fin = await fetch(hub.url + '/api/sessions/s/finish', { method: 'POST', headers: { cookie: 'murmur_sid=sid', 'x-murmur-csrf': '1' } });
  assert.equal(fin.status, 200);
  await n.wait('lane.integrate', 'l1');
  await hub.close();
  n.ws.terminate();

  hub = await createHub({ dataDir: dir, port: 0 });
  after(() => hub.close());
  n = await node(hub.url);
  await n.wait('lane.integrate', 'l1');
  n.up('lane.integrated', { laneId: 'l1', ok: true, commit: 'abc' });
  await n.wait('lane.integrate', 'l2');
  n.up('lane.integrated', { laneId: 'l2', ok: true, commit: 'def' });
  for (const end = Date.now() + 3000; hub.db.prepare(`SELECT count(*) n FROM event WHERE type='session.updated' AND lane_id='l2'`).get()!.n === 0;) {
    assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(n.frames.filter(f => f.t === 'lane.integrate').length, 2, 'each lane integrated once after restart');
});
