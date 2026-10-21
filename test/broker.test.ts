import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createBroker, hookOutput, HOOK_TIMEOUT_S, HOOK_FETCH_MS, HUB_MS, APPROVAL_MS, type HubPost } from '../src/node/broker.ts';
import { argsHash } from '../src/shared.ts';

const lane = { id: 'L1', mode: 'request' as const, worktree: '/wt', failMode: {} };
const write = { tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'x' }, tool_use_id: 't1' };
const push = { tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 't2' };
const httpErr = (status: number) => Object.assign(new Error(`hub HTTP ${status}`), { status });
const pending = (asked: any[] = []): HubPost => async (path, body) => { asked.push({ path, body }); return { decision: 'pending', approvalId: 'A1' }; };
const tick = () => new Promise(r => setImmediate(r));

test('timeouts nest: approval wait + hub call < hook fetch < claude hook timeout', () => {
  assert.ok(APPROVAL_MS + HUB_MS < HOOK_FETCH_MS && HOOK_FETCH_MS < HOOK_TIMEOUT_S * 1000);
  assert.deepEqual([HOOK_TIMEOUT_S, HOOK_FETCH_MS, APPROVAL_MS], [600, 590_000, 120_000]);
});

test('read-only tools: no opinion, hub never asked', async () => {
  const asked: any[] = [];
  assert.equal(await createBroker(pending(asked)).pretool(lane, { tool_name: 'Read', tool_input: {} }), null);
  assert.equal(asked.length, 0);
});

test('no hub: gated calls denied, ungated pass', async () => {
  const b = createBroker();
  assert.equal((await b.pretool(lane, write))?.decision, 'deny');
  assert.equal(await b.pretool({ ...lane, mode: 'allow' }, write), null);
});

test('hub 4xx denies with its message; 5xx and unreachable follow failMode', async () => {
  assert.deepEqual(await createBroker(async () => { throw Object.assign(new Error('lane revoked'), { status: 403 }); }).pretool(lane, write), { decision: 'deny', reason: 'Murmur: lane revoked' });
  const down = createBroker(async () => { throw httpErr(503); });
  assert.equal((await down.pretool(lane, write))?.decision, 'allow'); // files fail open
  assert.equal((await down.pretool(lane, push))?.decision, 'deny'); // push fails closed
  assert.equal((await down.pretool({ ...lane, failMode: { files: 'closed' } }, write))?.decision, 'deny');
  const gone = createBroker(async () => { throw new TypeError('fetch failed'); });
  assert.match((await gone.pretool(lane, push))!.reason, /unreachable; failing closed for push/);
  assert.equal(await gone.pretool({ ...lane, mode: 'allow' }, write), null, 'ungated call: no opinion');
});

test('hub decides directly; payload carries capabilities and paths', async () => {
  const asked: any[] = [];
  const b = createBroker(async (path, body) => { asked.push({ path, body }); return { decision: 'deny', reason: 'no‮' }; });
  assert.deepEqual(await b.pretool(lane, write), { decision: 'deny', reason: 'no' });
  assert.equal(asked[0].path, '/api/lanes/L1/pretool');
  assert.deepEqual([asked[0].body.capabilities, asked[0].body.paths, asked[0].body.gated], [['files'], ['a.txt'], true]);
  assert.deepEqual(hookOutput(null), {});
  assert.equal(JSON.parse(hookOutput({ decision: 'allow', reason: 'r' }).stdout!).hookSpecificOutput.permissionDecision, 'allow');
});

test('pending → teammate allows with matching hash; decision is single use', async () => {
  const b = createBroker(pending());
  const p = b.pretool(lane, write);
  await tick();
  b.decided({ approvalId: 'A1', laneId: 'OTHER', decision: 'allow', argsHash: argsHash(write.tool_name, write.tool_input) }); // wrong lane: ignored
  b.decided({ approvalId: 'A1', laneId: 'L1', decision: 'allow', argsHash: argsHash(write.tool_name, write.tool_input) });
  b.decided({ approvalId: 'A1', laneId: 'L1', decision: 'deny', argsHash: argsHash(write.tool_name, write.tool_input) });
  assert.deepEqual(await p, { decision: 'allow', reason: 'Murmur: approved by a teammate' });
});

test('pending → approval for other arguments is a deny', async () => {
  const b = createBroker(pending());
  const p = b.pretool(lane, write);
  await tick();
  b.decided({ approvalId: 'A1', laneId: 'L1', decision: 'allow', argsHash: 'not-the-hash' });
  assert.deepEqual(await p, { decision: 'deny', reason: 'Murmur: approval does not match these arguments' });
});

test('pending → nobody decides in time: deny', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const b = createBroker(pending());
    const p = b.pretool(lane, write);
    await tick();
    mock.timers.tick(APPROVAL_MS);
    assert.deepEqual(await p, { decision: 'deny', reason: 'Murmur: approval timed out after 120 s' });
  } finally { mock.timers.reset(); }
});

test('pending → node shuts down: deny', async () => {
  const b = createBroker(pending());
  const p = b.pretool(lane, write);
  await tick();
  b.close();
  assert.deepEqual(await p, { decision: 'deny', reason: 'Murmur node shutting down' });
});
