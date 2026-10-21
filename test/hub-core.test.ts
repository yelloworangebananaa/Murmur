// Hub domain in-process: in-memory sqlite, recording send/emit ports, injected clock. No sockets, no HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q } from '../src/hub/db.ts';
import { coord } from '../src/hub/coord.ts';
import { STALE_MS } from '../src/hub/lanes.ts';
import { authorize, type Rule } from '../src/hub/policy.ts';

const alice = { id: 'alice', name: 'alice' }, bob = { id: 'bob', name: 'bob' }, carol = { id: 'carol', name: 'carol' };

function harness() {
  const db = openDb(':memory:'), { get, all, run } = q(db);
  let t = 1_000_000;
  const sent: { dev: string; t: string; d: any }[] = [], events: { ws: string; type: string; d: any }[] = [], online = new Set(['dA', 'dB', 'dC']);
  const make = () => coord({ db, get, all, run, online, now: () => t,
    emit: (ws, type, d) => void events.push({ ws, type, d: d as any }),
    send: (dev, type, d) => online.has(dev) && !!sent.push({ dev, t: type, d }) });
  run(`INSERT INTO workspace (id, name, git_remote, created_at) VALUES ('w', 'w', 'https://x/y', 0)`);
  for (const [u, role, dev] of [['alice', 'owner', 'dA'], ['bob', 'editor', 'dB'], ['carol', 'editor', 'dC'], ['vic', 'viewer', 'dV'], ['zed', null, 'dZ']]) {
    run('INSERT INTO user (id, name, created_at) VALUES (?,?,0)', u, u);
    if (role) run('INSERT INTO member (workspace_id, user_id, role) VALUES (?,?,?)', 'w', u, role);
    run(`INSERT INTO device (id, user_id, name, token_hash) VALUES (?,?,?,?)`, dev, u, dev, 'h' + dev);
    run(`INSERT INTO binding (workspace_id, device_id, clone_path, verified_at) VALUES ('w',?,'/x',0)`, dev);
  }
  return { db, run, get, sent, events, online, make, co: make(), tick: (ms: number) => (t += ms), frames: (type: string) => sent.filter(f => f.t === type) };
}
type Hx = ReturnType<typeof harness>;
async function twoLanes(h: Hx) {
  const s = await h.co.lanes.open('w', alice, 'owner', { title: 'Add OAuth' });
  h.tick(1);
  const b = await h.co.lanes.join(h.co.scope('session', s.session.id).row, bob, 'editor', {});
  return { sid: s.session.id as string, A: s.lane.id as string, B: b.lane.id as string };
}
const status = async (p: Promise<unknown> | (() => unknown)) => { try { await (typeof p === 'function' ? p() : p); return 200; } catch (e: any) { return e.status ?? e.message; } };

test('open sends lane.start with the plan-less payload; full mode needs a workspace owner', async () => {
  const h = harness();
  const { sid, A } = await twoLanes(h);
  const st = h.frames('lane.start').find(f => f.d.laneId === A)!;
  assert.deepEqual([st.dev, st.d.sessionId, st.d.workspaceId, st.d.branch, st.d.mode, st.d.failMode.push], ['dA', sid, 'w', `murmur/${sid}`, 'request', 'closed']);
  assert.equal(await status(h.co.lanes.open('w', bob, 'editor', { title: 'x', mode: 'full' })), 403);
  assert.equal(await status(h.co.lanes.open('w', bob, 'editor', { title: 'x', base: '-evil' })), 400);
  assert.equal(await status(h.co.lanes.open('w', bob, 'editor', { title: 'x', deviceId: 'nope' })), 409);
});

test('two racing takeovers: exactly one wins, old device revoked, winner gets start with brief and snapshot ref', async () => {
  const h = harness();
  const { sid, A } = await twoLanes(h);
  h.co.onSnapshot(h.co.lane(A), { ref: `refs/murmur/${sid}/${A}`, commit: 'a'.repeat(40) });
  h.co.lanes.handOff(h.co.lane(A), 'lunch', 'USER: do it');
  const L = h.co.lane(A);
  const rs = await Promise.allSettled([bob, carol].map(u => h.co.lanes.takeover(L, u, { version: L.version, expectedOwner: 'alice' })));
  const won = rs.filter(r => r.status === 'fulfilled'), lost = rs.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
  assert.deepEqual([won.length, lost.length], [1, 1]);
  assert.equal(lost[0].reason.status, 409);
  assert.ok(lost[0].reason.current.ownerName);
  assert.deepEqual(h.frames('lane.revoke').map(f => [f.dev, f.d.laneId]), [['dA', A]]);
  const winner = h.co.lane(A), st = h.frames('lane.start').filter(f => f.d.laneId === A).at(-1)!;
  assert.equal(st.dev, winner.device_id);
  assert.equal(st.d.fromRef, `refs/murmur/${sid}/${A}`);
  assert.match(st.d.resumeBrief, /Reason: lunch/);
  assert.equal(await status(() => h.co.lanes.own('dA', A)), 403, 'old device can no longer report');
});

test('a running lane cannot be taken over by another user; its owner may reclaim it', async () => {
  const h = harness();
  const { B } = await twoLanes(h);
  h.co.lanes.report('dB', { laneId: B, status: 'running' });
  const L = h.co.lane(B);
  assert.equal(await status(h.co.lanes.takeover(L, alice, { version: L.version, expectedOwner: 'bob' })), 409);
  assert.equal(await status(h.co.lanes.takeover(L, bob, { version: L.version, expectedOwner: 'bob' })), 200);
});

test('staleness follows the injected clock and the last heartbeat', async () => {
  const h = harness();
  const { A, B } = await twoLanes(h);
  h.co.lanes.seen('dA'); h.co.lanes.seen('dB');
  h.tick(STALE_MS);
  h.co.lanes.seen('dB');
  h.co.sweep();
  assert.equal(h.co.lane(A).status, 'starting', 'exactly STALE_MS is not stale yet');
  h.tick(1);
  h.co.sweep();
  assert.deepEqual([h.co.lane(A).status, h.co.lane(A).status_reason, h.co.lane(B).status], ['stale', 'node heartbeat lost', 'starting']);
});

test('finish integrates lanes one at a time; offline lanes are skipped; queue survives a restart', async () => {
  const h = harness();
  const { sid, A, B } = await twoLanes(h);
  const s = () => h.co.scope('session', sid).row;
  assert.equal(await status(() => h.co.lanes.finish(s(), carol, 'editor')), 403, 'not creator, not owner');
  h.co.lanes.finish(s(), alice, 'owner');
  assert.equal(await status(() => h.co.lanes.finish(s(), alice, 'owner')), 409);
  assert.deepEqual(h.frames('lane.integrate').map(f => f.d.laneId), [A]);
  h.co.lanes.hello('dA', []);
  assert.equal(h.frames('lane.integrate').length, 1, 'no resend while in flight');
  const rebooted = h.make();
  rebooted.lanes.hello('dA', []);
  assert.deepEqual(h.frames('lane.integrate').map(f => f.d.laneId), [A, A], 'restarted hub resends the head lane');
  h.online.delete('dB');
  rebooted.lanes.integrated('dA', { laneId: A, ok: true, commit: 'c1' });
  rebooted.lanes.integrated('dA', { laneId: A, ok: true, commit: 'c1' });
  assert.equal(h.frames('lane.integrate').length, 2, 'B offline: skipped, duplicate report does not advance');
  assert.equal(h.get('SELECT count(*) n FROM lane WHERE integrate_pending=1').n, 0);
  assert.ok(h.events.some(e => e.type === 'session.updated' && e.d.laneId === A && e.d.integrated));
  assert.ok(B);
});

test('interrupt, stop, prompt need the node online; mode change persists, tells the node, publishes', async () => {
  const h = harness();
  const { A } = await twoLanes(h);
  const L = () => h.co.lane(A);
  for (const t of ['interrupt', 'stop'] as const) { h.co.lanes.signal(L(), t); assert.equal(h.frames(`lane.${t}`).at(-1)!.d.laneId, A); }
  h.co.lanes.prompt(L(), alice, 'go');
  assert.deepEqual(h.frames('lane.prompt').at(-1)!.d, { laneId: A, text: 'go', from: 'alice' });
  assert.equal(await status(() => h.co.lanes.setMode(L(), 'editor', 'full')), 403);
  assert.equal(await status(() => h.co.lanes.setMode(L(), 'owner', 'bogus')), 400);
  const v = L().version, out = h.co.lanes.setMode(L(), 'owner', 'plan');
  assert.deepEqual([out.lane.mode, out.lane.version, L().mode], ['plan', v + 1, 'plan']);
  assert.deepEqual(h.frames('lane.setMode').at(-1)!.d, { laneId: A, mode: 'plan' });
  assert.equal(h.events.filter(e => e.type === 'lane.status').at(-1)!.d.mode, 'plan');
  h.online.delete('dA');
  for (const f of [() => h.co.lanes.signal(L(), 'interrupt'), () => h.co.lanes.signal(L(), 'stop'), () => h.co.lanes.prompt(L(), alice, 'x')]) assert.equal(await status(f), 409);
});

test('every lane.status event has one shape', async () => {
  const h = harness();
  const { A, B } = await twoLanes(h);
  h.co.lanes.report('dA', { laneId: A, status: 'running' });
  h.co.lanes.setMode(h.co.lane(A), 'owner', 'allow');
  h.co.lanes.handOff(h.co.lane(A), 'bye', '');
  const L = h.co.lane(A);
  await h.co.lanes.takeover(L, carol, { version: L.version, expectedOwner: 'alice' });
  h.co.lanes.hello('dB', [{ laneId: B, status: 'idle' }]);
  h.tick(STALE_MS + 1); h.co.sweep();
  const st = h.events.filter(e => e.type === 'lane.status');
  assert.ok(st.length >= 6);
  for (const e of st) assert.deepEqual(Object.keys(e.d).sort(), ['laneId', 'mode', 'ownerUserId', 'reason', 'status']);
  assert.ok(st.some(e => e.d.reason === 'taken over by carol' && e.d.ownerUserId === 'carol'));
});

test('awaiting_takeover from the node writes a handoff brief once', async () => {
  const h = harness();
  const { A } = await twoLanes(h);
  h.co.lanes.report('dA', { laneId: A, status: 'awaiting_takeover', reason: 'crashed' });
  assert.match(h.co.lane(A).handoff_brief!, /Reason: crashed/);
  assert.equal(await status(() => h.co.lanes.report('dA', { laneId: A, status: 'bogus' })), 400);
});

test('snapshot ref must be this lane\'s own murmur ref; conflict resolve needs an open conflict and an online node', async () => {
  const h = harness();
  const { sid, A, B } = await twoLanes(h);
  assert.equal(await status(() => h.co.onSnapshot(h.co.lane(B), { ref: 'refs/heads/release', commit: 'abcdef1' })), 400);
  assert.equal(await status(() => h.co.onSnapshot(h.co.lane(B), { ref: `refs/murmur/${sid}/${A}`, commit: 'abcdef1' })), 400);
  h.run(`INSERT INTO conflict (id, session_id, path, lane_a, lane_b, ref_a, ref_b, created_at) VALUES ('k', ?, 'p', ?, ?, 'ra', 'rb', 0)`, sid, A, B);
  const k = () => h.co.scope('conflict', 'k').row;
  assert.equal(await status(() => h.co.resolveConflict(k(), 'z')), 400);
  h.co.resolveConflict(k(), 'b');
  assert.deepEqual(h.frames('conflict.resolve')[0], { dev: 'dB', t: 'conflict.resolve', d: { conflictId: 'k', sessionId: sid, branch: `murmur/${sid}`, path: 'p', fromRef: 'rb' } });
  assert.equal(k().resolution, 'keep b (bob)');
  assert.equal(await status(() => h.co.conflictResolved('dC', { conflictId: 'k' })), 403);
  h.co.conflictResolved('dB', { conflictId: 'k', commit: 'c' });
  assert.equal(await status(() => h.co.resolveConflict(k(), 'a')), 409);
});

test('listApprovals expires overdue approvals itself', async () => {
  const h = harness();
  const { A } = await twoLanes(h);
  const p = h.co.pretool(h.co.lane(A), { tool: 'Bash', toolUseId: 't', input: { command: 'curl x' }, capabilities: ['network'], gated: true });
  assert.equal(h.co.listApprovals('w', 'pending').length, 1);
  h.tick(120_001);
  assert.equal(h.co.listApprovals('w', 'pending').length, 0);
  assert.deepEqual(h.frames('approval.decided').map(f => [f.d.approvalId, f.d.decision]), [[p.approvalId, 'deny']]);
});

test('in-memory overlap, merge-check and wake state is pruned once lanes stop', async () => {
  const h = harness();
  const { sid, A, B } = await twoLanes(h);
  for (const [L, c] of [[A, 'a'], [B, 'b']]) h.co.onSnapshot(h.co.lane(L), { ref: `refs/murmur/${sid}/${L}`, commit: c.repeat(40) });
  for (const L of [A, B]) h.co.onDiff(h.co.lane(L), [{ path: 'x.ts', added: 1, removed: 0 }]);
  h.co.tool(h.co.lane(A), 'send_message', { to: `lane:${B}`, body: 'hi' });
  h.co.bufferEvents(h.co.lane(A), [{ k: 'assistant.delta', text: 'x' }]);
  const { wakes, lastOverlap, checked, ring } = h.co.mem;
  assert.ok(wakes.size && lastOverlap.size && checked.size && ring.size);
  assert.equal(h.frames('merge.check').length, 1);
  h.co.onDiff(h.co.lane(B), [{ path: 'x.ts', added: 2, removed: 0 }]);
  assert.equal(h.frames('merge.check').length, 1, 'same snapshot pair is checked once');
  h.co.sweep();
  assert.ok(lastOverlap.size && checked.size, 'live lanes keep their state');
  for (const [L, d] of [[A, 'dA'], [B, 'dB']]) h.co.lanes.report(d, { laneId: L, status: 'stopped' });
  h.tick(300_001);
  h.co.sweep();
  assert.deepEqual([wakes.size, lastOverlap.size, checked.size, ring.size], [0, 0, 0, 0]);
});

// ---- policy, table-driven, no HTTP ----
test('authorize: rule × principal → allow or status', async () => {
  const h = harness();
  const { B } = await twoLanes(h); // lane B: owner bob, device dB
  const P: [string, any][] = [['anon', {}], ...['alice', 'bob', 'carol', 'vic', 'zed'].map(u => [u, { user: { id: u, name: u } }] as [string, any]),
    ['devB', { device: { id: 'dB', user_id: 'bob' }, user: bob }], ['devA', { device: { id: 'dA', user_id: 'alice' }, user: alice }]];
  const U = (role: string, on: any, lane?: any): Rule => ({ who: 'user', role, on, lane });
  //            rule                                         id       anon alice bob carol vic zed devB devA
  const T: [Rule, string, string][] = [
    [{ who: 'anyone' }, '', 'ok ok ok ok ok ok ok ok'],
    [{ who: 'user' }, '', '401 ok ok ok ok ok ok ok'],
    [U('viewer', 'ws'), 'w', '401 ok ok ok ok 403 ok ok'],
    [U('viewer', 'ws'), 'nope', '404 404 404 404 404 404 404 404'],
    [U('commenter', 'ws'), 'w', '401 ok ok ok 403 403 ok ok'],
    [U('editor', 'ws'), 'w', '401 ok ok ok 403 403 ok ok'],
    [U('owner', 'ws'), 'w', '401 ok 403 403 403 403 403 ok'],
    [U('editor', 'lane'), B, '401 ok ok ok 403 403 ok ok'],
    [U('viewer', 'lane', 'owner'), B, '401 403 ok 403 403 403 ok 403'],
    [U('viewer', 'lane', 'owner+ws'), B, '401 ok ok 403 403 403 ok 403'],
    [{ who: 'device', on: 'lane', lane: 'device' }, B, '401 401 401 401 401 401 ok 403'],
    [{ who: 'device', on: 'lane', lane: 'device' }, 'nope', '401 401 401 401 401 401 404 404'],
    [{ who: 'device', role: 'viewer', on: 'ws' }, 'w', '401 401 401 401 401 401 ok ok'],
  ];
  for (const [rule, id, want] of T) {
    const got = P.map(([, p]) => { try { authorize(h.co, rule, p, id); return 'ok'; } catch (e: any) { return String(e.status); } }).join(' ');
    assert.equal(got, want, JSON.stringify(rule) + ' ' + id);
  }
});
