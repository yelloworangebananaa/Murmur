// Authorization over HTTP: every route × every principal → status. Characterizes the pre-refactor policy
// (CSRF, device allow-list, roles, lane ownership, resource-before-auth ordering). Fixtures are plain SQL.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub/server.ts';
import { sha256 } from '../src/shared.ts';

const hub = await createHub({ dataDir: mkdtempSync(join(tmpdir(), 'murmur-authz-')), port: 0 });
after(() => hub.close());
const run = (sql: string, ...a: any[]) => hub.db.prepare(sql).run(...a);

const W = 'ws1', S = 'sess1', S2 = 'sess2', LE = 'laneE', LH = 'laneH', ST = 'step1', T = 'task1', A = 'appr1', K = 'conf1';
const USERS: [string, string | null][] = [['alice', 'owner'], ['vic', 'viewer'], ['cam', 'commenter'], ['eddie', 'editor'], ['ed2', 'editor'], ['zed', null]];
run(`INSERT INTO workspace (id, name, git_remote, created_at) VALUES (?, 'w', 'https://x/y', 0)`, W);
for (const [u, role] of USERS) {
  run('INSERT INTO user (id, name, created_at) VALUES (?,?,0)', u, u);
  run('INSERT INTO web_session (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256('sid-' + u), u, Date.now() + 3_600_000);
  if (role) run('INSERT INTO member (workspace_id, user_id, role) VALUES (?,?,?)', W, u, role);
}
for (const [d, u] of [['devE', 'eddie'], ['devD2', 'ed2']]) run('INSERT INTO device (id, user_id, name, token_hash) VALUES (?,?,?,?)', d, u, d, sha256('tok-' + d));
run(`INSERT INTO session (id, workspace_id, title, branch, created_by, created_at) VALUES (?,?,'s','murmur/s','eddie',0)`, S, W);
run(`INSERT INTO session (id, workspace_id, title, branch, status, created_by, created_at) VALUES (?,?,'s2','murmur/s2','finished','eddie',0)`, S2, W);
for (const l of [LE, LH]) run(`INSERT INTO lane (id, session_id, owner_user_id, device_id, mode, status, created_at) VALUES (?,?,'eddie','devE','request','running',0)`, l, S);
run(`INSERT INTO plan_step (id, session_id, ord, text) VALUES (?,?,0,'x')`, ST, S);
run(`INSERT INTO task (id, workspace_id, title, created_at) VALUES (?,?,'t',0)`, T, W);
run(`INSERT INTO approval (id, lane_id, tool, target, capabilities_json, args_hash, idem_key, created_at, expires_at) VALUES (?,?,'Bash','ls','["files"]','h','k',0,?)`, A, LE, Date.now() + 3_600_000);
run(`INSERT INTO memory (workspace_id, body, created_at) VALUES (?, 'm', 0)`, W);
run(`INSERT INTO conflict (id, session_id, path, lane_a, lane_b, created_at) VALUES (?,?,'p',?,?,0)`, K, S, LE, LE);

type P = { cookie?: string; bearer?: string };
const PRINCIPALS: [string, P][] = [['anon', {}], ...USERS.map(([u]) => [u, { cookie: `murmur_sid=sid-${u}` }] as [string, P]), ['devE', { bearer: 'tok-devE' }], ['devD2', { bearer: 'tok-devD2' }]];
async function call(p: P, method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-murmur-csrf': '1', 'content-type': 'application/json' }) {
  const r = await fetch(hub.url + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...headers, ...(p.cookie ? { cookie: p.cookie } : {}), ...(p.bearer ? { authorization: `Bearer ${p.bearer}` } : {}) },
  });
  await r.arrayBuffer();
  return r.status;
}

// [method, path, body] → statuses for anon alice vic cam eddie ed2 zed devE devD2. Allowed calls fail validation (400/409) so nothing mutates.
const MATRIX: [string, string, unknown, string][] = [
  ['GET', '/api/setup', undefined, '200 200 200 200 200 200 200 403 403'],
  ['POST', '/api/setup', {}, '409 409 409 409 409 409 409 403 403'],
  ['POST', '/api/login', {}, '401 401 401 401 401 401 401 403 403'],
  ['GET', '/api/me', undefined, '401 200 200 200 200 200 200 403 403'],
  ['POST', '/api/workspaces', {}, '401 400 400 400 400 400 400 403 403'],
  ['GET', `/api/workspaces/${W}`, undefined, '401 200 200 200 200 200 403 403 403'],
  ['GET', '/api/workspaces/nope', undefined, '404 404 404 404 404 404 404 403 403'],
  ['PATCH', `/api/workspaces/${W}`, {}, '401 200 403 403 403 403 403 403 403'],
  ['POST', `/api/workspaces/${W}/invites`, { role: 'bogus' }, '401 400 403 403 403 403 403 403 403'],
  ['GET', '/api/invites/bogus', undefined, '404 404 404 404 404 404 404 403 403'],
  ['POST', '/api/invites/bogus/accept', {}, '404 404 404 404 404 404 404 403 403'],
  ['POST', '/api/device/start', {}, '400 400 400 400 400 400 400 403 403'],
  ['POST', '/api/device/approve', {}, '401 404 404 404 404 404 404 403 403'],
  ['GET', '/api/device/lookup/XXXX', undefined, '401 404 404 404 404 404 404 403 403'],
  ['POST', '/api/device/poll', {}, '410 410 410 410 410 410 410 403 403'],
  ['GET', '/api/devices', undefined, '401 200 200 200 200 200 200 403 403'],
  ['DELETE', '/api/devices/nope', undefined, '401 404 404 404 404 404 404 403 403'],
  ['POST', `/api/workspaces/${W}/bind`, {}, '401 401 401 401 401 401 401 400 400'],
  ['POST', '/api/workspaces/nope/bind', {}, '401 401 401 401 401 401 401 404 404'],
  ['GET', `/api/workspaces/${W}/computers`, undefined, '401 200 200 200 200 200 403 403 403'],
  ['POST', `/api/workspaces/${W}/link`, {}, '401 409 403 403 409 409 403 403 403'],
  ['POST', `/api/workspaces/${W}/sessions`, {}, '401 400 403 403 400 400 403 403 403'],
  ['GET', `/api/workspaces/${W}/sessions`, undefined, '401 200 200 200 200 200 403 403 403'],
  ['GET', `/api/sessions/${S}`, undefined, '401 200 200 200 200 200 403 403 403'],
  ['GET', '/api/sessions/nope', undefined, '404 404 404 404 404 404 404 403 403'],
  ['POST', `/api/sessions/${S}/join`, { mode: 'bogus' }, '401 400 403 403 400 400 403 403 403'],
  ['POST', `/api/sessions/${S2}/finish`, {}, '401 409 403 403 409 403 403 403 403'],
  ['POST', `/api/lanes/${LE}/prompt`, {}, '401 403 403 403 400 403 403 403 403'],
  ['POST', '/api/lanes/nope/prompt', {}, '404 404 404 404 404 404 404 403 403'],
  ['POST', `/api/lanes/${LE}/interrupt`, {}, '401 409 403 403 409 403 403 403 403'],
  ['POST', `/api/lanes/${LE}/stop`, {}, '401 409 403 403 409 403 403 403 403'],
  ['POST', `/api/lanes/${LE}/mode`, { mode: 'bogus' }, '401 400 403 403 400 403 403 403 403'],
  ['POST', `/api/lanes/${LH}/handoff`, {}, '401 403 403 403 200 403 403 403 403'],
  ['POST', `/api/lanes/${LE}/takeover`, {}, '401 400 403 403 400 400 403 403 403'],
  // was 401 for anon (takeover alone checked login before the lane); now resource-first like every other route
  ['POST', '/api/lanes/nope/takeover', {}, '404 404 404 404 404 404 404 403 403'],
  ['GET', `/api/lanes/${LE}/events`, undefined, '401 200 200 200 200 200 403 403 403'],
  ['POST', `/api/sessions/${S}/plan`, { steps: 'x' }, '401 400 403 403 400 400 403 403 403'],
  ['PATCH', `/api/steps/${ST}`, { status: 'bogus' }, '401 400 403 403 400 400 403 403 403'],
  ['PATCH', '/api/steps/nope', {}, '404 404 404 404 404 404 404 403 403'],
  ['GET', `/api/workspaces/${W}/tasks`, undefined, '401 200 200 200 200 200 403 403 403'],
  ['POST', `/api/workspaces/${W}/tasks`, {}, '401 400 403 403 400 400 403 403 403'],
  ['PATCH', `/api/tasks/${T}`, { col: 'bogus' }, '401 400 403 403 400 400 403 403 403'],
  ['POST', `/api/tasks/${T}/claim`, { laneId: LE }, '401 403 403 403 400 403 403 403 403'],
  ['POST', '/api/tasks/nope/claim', {}, '404 404 404 404 404 404 404 403 403'],
  ['POST', '/api/messages', { workspaceId: W }, '401 400 403 400 400 400 403 403 403'],
  ['GET', `/api/workspaces/${W}/messages`, undefined, '401 200 200 200 200 200 403 403 403'],
  ['GET', `/api/workspaces/${W}/approvals`, undefined, '401 200 200 200 200 200 403 403 403'],
  ['POST', `/api/approvals/${A}/decide`, { decision: 'bogus' }, '401 400 403 403 400 400 403 403 403'],
  ['POST', '/api/approvals/nope/decide', {}, '404 404 404 404 404 404 404 403 403'],
  ['GET', `/api/workspaces/${W}/memory`, undefined, '401 200 200 200 200 200 403 403 403'],
  ['POST', `/api/workspaces/${W}/memory`, {}, '401 400 403 403 400 400 403 403 403'],
  ['PATCH', '/api/memory/1', { body: 5 }, '401 400 403 403 400 400 403 403 403'],
  ['PATCH', '/api/memory/999', {}, '404 404 404 404 404 404 404 403 403'],
  ['POST', `/api/conflicts/${K}/resolve`, { choice: 'z' }, '401 400 403 403 400 400 403 403 403'],
  ['POST', '/api/conflicts/nope/resolve', {}, '404 404 404 404 404 404 404 403 403'],
  ['GET', `/api/lanes/${LE}/digest`, undefined, '401 401 401 401 401 401 401 200 403'],
  ['GET', '/api/lanes/nope/digest', undefined, '401 401 401 401 401 401 401 404 404'],
  ['POST', `/api/lanes/${LE}/pretool`, {}, '401 401 401 401 401 401 401 400 403'],
  ['GET', `/api/lanes/${LE}/pretool`, undefined, '404 404 404 404 404 404 404 404 404'],
  ['POST', `/api/lanes/${LE}/tool/nope`, {}, '401 401 401 401 401 401 401 404 403'],
  ['GET', '/api/nothing', undefined, '404 404 404 404 404 404 404 403 403'],
];

test('authorization matrix: route × principal → status', async () => {
  const bad: string[] = [];
  for (const [m, path, body, want] of MATRIX) {
    const got = (await Promise.all(PRINCIPALS.map(([, p]) => call(p, m, path, body)))).join(' ');
    if (got !== want) bad.push(`${m} ${path}: want ${want} got ${got}`);
  }
  assert.deepEqual(bad, []);
});

test('CSRF header and JSON content type on cookie/anon mutations; device-flow and bearer exempt', async () => {
  const eddie = PRINCIPALS.find(([n]) => n === 'eddie')![1];
  assert.equal(await call(eddie, 'POST', '/api/workspaces', {}, { 'content-type': 'application/json' }), 403);
  assert.equal(await call({}, 'POST', '/api/login', {}, { 'content-type': 'application/json' }), 403);
  assert.equal(await call(eddie, 'POST', '/api/workspaces', {}, { 'x-murmur-csrf': '1', 'content-type': 'text/plain' }), 415);
  assert.equal(await call(eddie, 'GET', `/api/workspaces/${W}`, undefined, {}), 200);
  assert.equal(await call({}, 'POST', '/api/device/start', {}, {}), 400);
  assert.equal(await call({}, 'POST', '/api/device/poll', {}, {}), 410);
  assert.equal(await call({ bearer: 'tok-devE' }, 'POST', `/api/lanes/${LE}/pretool`, {}, {}), 400);
  assert.equal(await call({ bearer: 'nope' }, 'GET', '/api/setup'), 401);
});
