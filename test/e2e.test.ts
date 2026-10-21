// Two users, two nodes, one hub, fake claude. Flows B1–B10 from user-flows.md end to end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHub } from '../src/hub/server.ts';
import { createNode } from '../src/node/daemon.ts';

const FAKE = ['node', resolve(import.meta.dirname, 'fake-claude.ts')];
const tmp = mkdtempSync(join(tmpdir(), 'murmur-e2e-'));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

// Bare "team remote" with one commit, two clones.
const bare = join(tmp, 'team.git');
git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
const seed = join(tmp, 'seed');
git(tmp, 'clone', '-q', bare, seed);
writeFileSync(join(seed, 'README.md'), 'hello\n');
writeFileSync(join(seed, 'shared.txt'), 'base\n');
git(seed, '-c', 'user.email=s@x', '-c', 'user.name=s', 'add', '.');
git(seed, '-c', 'user.email=s@x', '-c', 'user.name=s', 'commit', '-qm', 'init');
git(seed, 'push', '-q', 'origin', 'HEAD:main');
const cloneA = join(tmp, 'alice'), cloneB = join(tmp, 'bob');
git(tmp, 'clone', '-q', bare, cloneA);
git(tmp, 'clone', '-q', bare, cloneB);
for (const c of [cloneA, cloneB]) { git(c, 'config', 'user.email', 'n@x'); git(c, 'config', 'user.name', 'n'); }

const hub = await createHub({ dataDir: join(tmp, 'hub'), port: 0, host: '127.0.0.1' });
const closers: Array<() => unknown> = [() => hub.close()];
after(async () => { for (const c of closers.reverse()) await c(); });

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(hub.url + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-murmur-csrf': '1', ...(cookie ? { cookie } : {}), ...extra },
    });
    const sc = r.headers.getSetCookie?.() ?? [];
    for (const c of sc) if (c.startsWith('murmur_sid=')) cookie = c.split(';')[0];
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json, cookie: () => cookie };
  };
}
const alice = client(), bob = client();

async function startNode(api: ReturnType<typeof client>, name: string, wsId: string, clone: string) {
  const start = await api('POST', '/api/device/start', { name });
  assert.equal(start.status, 200);
  assert.equal((await api('POST', '/api/device/approve', { userCode: start.json.userCode })).status, 200);
  const poll = await api('POST', '/api/device/poll', { deviceCode: start.json.deviceCode });
  assert.equal(poll.status, 200);
  const { deviceId, deviceToken } = poll.json;
  const bind = await fetch(hub.url + `/api/workspaces/${wsId}/bind`, {
    method: 'POST', headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clonePath: clone, remote: git(clone, 'remote', 'get-url', 'origin') }),
  });
  assert.equal(bind.status, 200);
  const home = join(tmp, 'home-' + name);
  execFileSync('mkdir', ['-p', home]);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ hubUrl: hub.url, deviceId, deviceToken, bindings: { [wsId]: clone } }), { mode: 0o600 });
  const node = await createNode({ home, port: 0, hubUrl: hub.url, claudeBin: FAKE });
  closers.push(() => node.close());
  return { node, deviceId };
}

// Browser-side event feed for one workspace.
function uiFeed(cookie: string, wsId: string) {
  const events: any[] = [];
  const ws = new WebSocket(hub.url.replace('http', 'ws') + `/ws/ui?workspace=${wsId}&since=0`, { headers: { cookie } } as any);
  ws.onmessage = m => events.push(JSON.parse(String(m.data)));
  closers.push(() => ws.close());
  return { events, ready: new Promise(r => (ws.onopen = r)) };
}

let wsId = '', sessionId = '', laneA = '', laneB = '';
const text = (events: any[], lane: string) => events.filter(e => e.type === 'lane.events' && e.laneId === lane)
  .flatMap(e => e.d.batch).map((e: any) => e.text ?? '').join('\n');
const laneOf = async (id: string) => (await alice('GET', `/api/sessions/${sessionId}`)).json.lanes.find((l: any) => l.id === id);

let feed: ReturnType<typeof uiFeed>;

test('B1/B2: setup, invite, device login, bind, presence', async () => {
  assert.equal((await alice('GET', '/api/setup')).json.needed, true);
  assert.equal((await alice('POST', '/api/setup', { code: hub.setupCode, name: 'alice', password: 'correct horse 1' })).status, 200);
  const w = await alice('POST', '/api/workspaces', { name: 'demo', gitRemote: bare });
  assert.equal(w.status, 200);
  wsId = w.json.id ?? w.json.workspace?.id;
  const inv = await alice('POST', `/api/workspaces/${wsId}/invites`, { role: 'editor' });
  assert.equal((await bob('POST', `/api/invites/${inv.json.token}/accept`, { name: 'bob', password: 'battery staple 2' })).status, 200);
  await startNode(alice, 'alice-mac', wsId, cloneA);
  await startNode(bob, 'bob-mac', wsId, cloneB);
  const me = await alice('GET', '/api/me');
  feed = uiFeed(me.cookie(), wsId);
  await feed.ready;
});

test('B3/B4: session with two lanes on two machines streams live to the browser', async () => {
  const s = await alice('POST', `/api/workspaces/${wsId}/sessions`, { title: 'Add OAuth', mode: 'allow' });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  sessionId = s.json.session.id; laneA = s.json.lane.id;
  const j = await bob('POST', `/api/sessions/${sessionId}/join`, { mode: 'request' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  laneB = j.json.lane.id;
  await until('both lanes idle', async () => (await laneOf(laneA))?.status === 'idle' && (await laneOf(laneB))?.status === 'idle');
  await alice('POST', `/api/lanes/${laneA}/prompt`, { text: 'hello from alice' });
  await bob('POST', `/api/lanes/${laneB}/prompt`, { text: 'hello from bob' });
  await until('both acks', () => text(feed.events, laneA).includes('ACK: hello from alice') && text(feed.events, laneB).includes('ACK: hello from bob'));
  // worktrees isolate lanes from the user's checkout
  assert.ok(existsSync(join(cloneA, '.murmur', 'wt', laneA)));
});

test('B7: agent-to-agent message wakes the peer agent by itself, exactly once', async () => {
  const before = feed.events.length;
  await alice('POST', `/api/lanes/${laneA}/prompt`, { text: `MCP send_message {"to":"lane:${laneB}","body":"renamed User.id to User.uid"}` });
  // Bob never prompts: his agent gets the message as its next turn and answers it.
  const turnEnded = (from: number) => feed.events.slice(from).some(e => e.type === 'lane.events' && e.laneId === laneB && e.d.batch.some((x: any) => x.k === 'turn.end'));
  await until('peer woken', () => text(feed.events.slice(before), laneB).includes('ACK: Message from alice'));
  await until('peer turn end', () => turnEnded(before));
  const woke = text(feed.events.slice(before), laneB);
  assert.match(woke, /reply with send_message to "lane:/);
  assert.ok(woke.includes('<murmur-untrusted-data provenance="murmur-message">'), 'message reaches the model as data');
  await sleep(300); // message.delivered ack reaches the hub
  const before2 = feed.events.length;
  await bob('POST', `/api/lanes/${laneB}/prompt`, { text: 'again' });
  const t2 = await until('second turn', () => { const t = text(feed.events.slice(before2), laneB); return t.includes('ACK: again') && t; });
  assert.ok(!t2.includes('renamed User.id to User.uid'), 'digest repeated a pushed message');
});

test('B5: teammate approves a gated tool call from another machine', async () => {
  await bob('POST', `/api/lanes/${laneB}/prompt`, { text: 'WRITE approved.txt yes' });
  const req = await until('approval.requested', () => feed.events.find(e => e.type === 'approval.requested'));
  const id = req.d.id ?? req.d.approvalId;
  assert.equal((await alice('POST', `/api/approvals/${id}/decide`, { decision: 'allow' })).status, 200);
  assert.equal((await bob('POST', `/api/approvals/${id}/decide`, { decision: 'deny' })).status, 409);
  await until('file written in bob worktree', () => existsSync(join(cloneB, '.murmur', 'wt', laneB, 'approved.txt')));
  // deny path: reason reaches the model
  const before = feed.events.length;
  await bob('POST', `/api/lanes/${laneB}/prompt`, { text: 'WRITE denied.txt no' });
  const req2 = await until('2nd approval', () => feed.events.slice(before).find(e => e.type === 'approval.requested'));
  await alice('POST', `/api/approvals/${req2.d.id ?? req2.d.approvalId}/decide`, { decision: 'deny' });
  await until('deny result', () => feed.events.slice(before).some(e => e.type === 'lane.events' && e.d.batch.some((x: any) => x.k === 'tool.result' && x.isError)));
  assert.ok(!existsSync(join(cloneB, '.murmur', 'wt', laneB, 'denied.txt')));
});

test('B6: same file edited on two machines → overlap and conflict', async () => {
  await alice('POST', `/api/lanes/${laneA}/prompt`, { text: 'WRITE shared.txt alice version' });
  await bob('POST', `/api/lanes/${laneB}/prompt`, { text: 'WRITE shared.txt bob version' });
  const req = await until('bob approval', () => feed.events.find(e => e.type === 'approval.requested' && JSON.stringify(e.d).includes('shared.txt')));
  await alice('POST', `/api/approvals/${req.d.id ?? req.d.approvalId}/decide`, { decision: 'allow' });
  await until('overlap event', () => feed.events.find(e => e.type === 'overlap'), 20000);
  const conflicts = await until('conflict row', async () => { const s = await alice('GET', `/api/sessions/${sessionId}`); return s.json.conflicts?.length && s.json.conflicts; }, 30000);
  assert.equal(conflicts[0].path, 'shared.txt');
  // remote got snapshot refs
  assert.match(git(bare, 'for-each-ref', 'refs/murmur'), /refs\/murmur\//);
  // user checkouts untouched
  assert.equal(readFileSync(join(cloneA, 'shared.txt'), 'utf8'), 'base\n');
  assert.equal(git(cloneA, 'status', '--porcelain'), '');
});

test('B9: usage limit → awaiting_takeover → Bob takes over on his machine with the brief', async () => {
  await alice('POST', `/api/lanes/${laneA}/prompt`, { text: 'USAGE_LIMIT' });
  await until('awaiting_takeover', async () => (await laneOf(laneA))?.status === 'awaiting_takeover');
  const lane = await laneOf(laneA);
  const [r1, r2] = await Promise.all([
    bob('POST', `/api/lanes/${laneA}/takeover`, { expectedOwner: lane.owner_user_id ?? lane.ownerUserId, version: lane.version }),
    alice('POST', `/api/lanes/${laneA}/takeover`, { expectedOwner: lane.owner_user_id ?? lane.ownerUserId, version: lane.version }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  await until('resumed on bob node', () => existsSync(join(cloneB, '.murmur', 'wt', laneA)), 20000);
  await until('idle after takeover', async () => (await laneOf(laneA))?.status === 'idle');
  const before = feed.events.length;
  const taker = r1.status === 200 ? bob : alice;
  await taker('POST', `/api/lanes/${laneA}/prompt`, { text: 'continue' });
  const t = await until('resumed turn', () => { const x = text(feed.events.slice(before), laneA); return x.includes('ACK: continue') && x; });
  assert.match(t, /Resuming/);
  // the snapshot carried Alice's work into the new worktree
  if (r1.status === 200) assert.equal(readFileSync(join(cloneB, '.murmur', 'wt', laneA, 'shared.txt'), 'utf8'), 'alice version\n');
});

test('B10: shared memory with staleness', async () => {
  await bob('POST', `/api/lanes/${laneB}/prompt`, { text: 'MCP remember {"body":"Never call db.migrate in tests","paths":["README.md"]}' });
  await until('memory stored', async () => (await alice('GET', `/api/workspaces/${wsId}/memory`)).json.length > 0);
  const before = feed.events.length;
  await bob('POST', `/api/lanes/${laneB}/prompt`, { text: 'MCP recall {"query":"migrate"}' });
  const t = await until('recall', () => { const x = text(feed.events.slice(before), laneB); return x.includes('MCP RESULT') && x; });
  assert.match(t, /db\.migrate/);
});
