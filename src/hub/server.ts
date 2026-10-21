// Murmur hub: REST, /ws/node, /ws/ui, static web UI.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { newId, newToken, sha256, sanitize, isId, normalizeRemote, NODE_COMMANDS, type Frame } from '../shared.ts';
import { openDb, tx, q } from './db.ts';
import { fail, str, optStr, oneOf, int, camel, ROLES } from './check.ts';
import { coord, type Hub, type Kind } from './coord.ts';
import { authorize, type Rule } from './policy.ts';

const WEB = fileURLToPath(new URL('./web/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const SESSION_MS = 30 * 86_400_000;

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; body: any; ip: string; user?: { id: string; name: string }; device?: { id: string; user_id: string } };

const hashPw = (pw: string) => { const salt = randomBytes(16); return salt.toString('hex') + ':' + scryptSync(pw, salt, 64).toString('hex'); };
function checkPw(pw: string, stored: string | null) {
  const [salt, hash] = (stored ?? '').split(':');
  if (!salt || !hash) return false;
  return timingSafeEqual(scryptSync(pw, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}
const same = (a: string, b: string) => timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
export { normalizeRemote };
const userCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = randomBytes(8); return [...b].map((x, i) => (i === 4 ? '-' : '') + A[x % A.length]).join(''); };

export async function createHub(o: { dataDir: string; port: number; host?: string; publicUrl?: string; setupCode?: string }) {
  const db = openDb(o.dataDir);
  const { get, all, run } = q(db);
  const online = new Map<string, { ws: WebSocket; userId: string }>();
  const nodeSeq = new Map<string, { boot: unknown; seq: number }>(); // per device: frames at or below seq are retransmits
  const ui = new Set<{ ws: WebSocket; wsId: string; userId: string }>();
  const hits = new Map<string, number[]>();

  const broadcast = (wsId: string, msg: unknown) => { const s = JSON.stringify(msg); for (const u of ui) if (u.wsId === wsId && u.ws.readyState === 1) u.ws.send(s); };
  const emit: Hub['emit'] = (ws, type, d, sessionId = null, laneId = null) => {
    const at = Date.now();
    const seq = Number(run('INSERT INTO event (workspace_id, session_id, lane_id, type, payload_json, at) VALUES (?,?,?,?,?,?)', ws, sessionId, laneId, type, JSON.stringify(d ?? null), at).lastInsertRowid);
    broadcast(ws, { seq, type, sessionId, laneId, d, at });
  };
  const send: Hub['send'] = (deviceId, t, d) => {
    if (!NODE_COMMANDS.has(t)) throw new Error(`unknown frame ${t}`);
    const c = online.get(deviceId);
    if (!c || c.ws.readyState !== 1) return false;
    c.ws.send(JSON.stringify({ t, id: newId(), d }));
    return true;
  };
  const co = coord({ db, get, all, run, emit, send, online, now: Date.now }), ln = co.lanes;

  let setupCode: string | null = get('SELECT 1 FROM user LIMIT 1') ? null : o.setupCode ?? randomBytes(6).toString('hex');
  if (setupCode) console.log(`murmur-hub: one-time setup code: ${setupCode}`);

  // ---- auth ----
  const cookieUser = (req: IncomingMessage) => {
    const tok = /(?:^|;\s*)murmur_sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    return tok ? get('SELECT u.id, u.name FROM web_session w JOIN user u ON u.id=w.user_id WHERE w.token_hash=? AND w.expires_at>?', sha256(tok), Date.now()) : undefined;
  };
  const bearerDevice = (req: IncomingMessage) => {
    const tok = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    return tok ? get('SELECT * FROM device WHERE token_hash=? AND revoked_at IS NULL', sha256(tok)) : undefined;
  };
  function login(c: Ctx, userId: string) {
    const tok = newToken();
    run('INSERT INTO web_session (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(tok), userId, Date.now() + SESSION_MS);
    const secure = (o.publicUrl ?? '').startsWith('https:') ? '; Secure' : '';
    c.res.setHeader('set-cookie', `murmur_sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
    c.user = get('SELECT id, name FROM user WHERE id=?', userId);
  }
  function createUser(name: unknown, password: unknown) {
    const n = str(name, 64, 'name').trim();
    if (!/^[\p{L}\p{N} ._@-]+$/u.test(n)) fail(400, 'name has invalid characters');
    const pw = str(password, 200, 'password');
    if (pw.length < 8) fail(400, 'password must be at least 8 characters');
    if (get('SELECT 1 FROM user WHERE name=?', n)) fail(409, 'name taken');
    const id = newId();
    run('INSERT INTO user (id, name, password_hash, created_at) VALUES (?,?,?,?)', id, n, hashPw(pw), Date.now());
    return id;
  }
  function limit(c: Ctx, key: string) {
    const k = key + '|' + c.ip, t = Date.now(), arr = (hits.get(k) ?? []).filter(x => x > t - 60_000);
    if (arr.length >= 10) fail(429, 'too many attempts; wait a minute');
    arr.push(t); hits.set(k, arr);
  }
  const me = (c: Ctx) => c.user ?? fail(401, 'login required');
  const roleOf = co.roleOf;
  const workspacesOf = (userId: string) => all('SELECT w.id, w.name, m.role FROM member m JOIN workspace w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.created_at', userId);
  const presence = (userId: string, deviceId: string, isOnline: boolean) => {
    for (const w of workspacesOf(userId)) emit(w.id, 'presence', { userId, deviceId, online: isOnline });
  };

  // ---- routes ----
  // Every route declares who may call it (policy.ts); the device allow-list and CSRF exemptions derive from these rules.
  type A = { row?: any; ws?: string; role?: string };
  type H = (c: Ctx, p: string[], a: A) => unknown;
  const routes: { m: string; re: RegExp; rule: Rule; fn: H; id?: (c: Ctx) => unknown }[] = [];
  const r = (m: string, path: string, rule: Rule, fn: H, id?: (c: Ctx) => unknown) => routes.push({ m, re: new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$'), rule, fn, id });
  const ANY: Rule = { who: 'anyone' }, USER: Rule = { who: 'user' }, CLI: Rule = { who: 'anyone', csrf: false };
  const U = (role: string, on: Kind, lane?: Rule['lane']): Rule => ({ who: 'user', role, on, lane });
  const pathOk = (path: string, ok: (x: Rule) => boolean) => routes.some(x => ok(x.rule) && x.re.test(path));
  const can = (c: Ctx, rule: Rule, id: unknown) => authorize(co, rule, c, id);

  r('GET', '/api/setup', ANY, () => ({ needed: !get('SELECT 1 FROM user LIMIT 1') }));
  r('POST', '/api/setup', ANY, c => {
    limit(c, 'setup');
    if (!setupCode || get('SELECT 1 FROM user LIMIT 1')) fail(409, 'already set up');
    if (!same(String(c.body.code ?? ''), setupCode!)) fail(403, 'bad setup code');
    const id = createUser(c.body.name, c.body.password);
    setupCode = null;
    login(c, id);
    return { user: c.user };
  });
  r('POST', '/api/login', ANY, c => {
    limit(c, 'login');
    const u = get('SELECT * FROM user WHERE name=?', String(c.body.name ?? ''));
    if (!u || !checkPw(String(c.body.password ?? ''), u.password_hash)) fail(401, 'bad name or password');
    login(c, u.id);
    return { user: c.user };
  });
  r('POST', '/api/logout', ANY, c => {
    const tok = /(?:^|;\s*)murmur_sid=([^;]+)/.exec(c.req.headers.cookie ?? '')?.[1];
    if (tok) run('DELETE FROM web_session WHERE token_hash=?', sha256(tok));
    c.res.setHeader('set-cookie', 'murmur_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });
  r('GET', '/api/me', USER, c => ({ user: me(c), workspaces: workspacesOf(me(c).id) }));

  r('POST', '/api/workspaces', USER, c => {
    const u = me(c), id = newId();
    const remote = str(c.body.gitRemote, 1000, 'gitRemote');
    tx(db, () => {
      run('INSERT INTO workspace (id, name, git_remote, lease_policy, created_at) VALUES (?,?,?,?,?)', id, sanitize(str(c.body.name, 100, 'name'), 100), remote,
        c.body.leasePolicy == null ? 'warn' : oneOf(c.body.leasePolicy, ['warn', 'enforce'], 'leasePolicy'), Date.now());
      run(`INSERT INTO member (workspace_id, user_id, role) VALUES (?,?,'owner')`, id, u.id);
    });
    return { id, name: c.body.name, role: 'owner' };
  });
  const wsView = (w: any) => ({
    ...camel(w), failMode: JSON.parse(w.fail_mode_json), requireSecondPerson: !!w.require_second_person,
    members: all('SELECT u.id, u.name, m.role FROM member m JOIN user u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.name', w.id).map(m => ({
      ...m, devices: all('SELECT id, name FROM device WHERE user_id=? AND revoked_at IS NULL', m.id).map(d => ({ ...d, online: online.has(d.id) })),
    })),
  });
  r('GET', '/api/workspaces/:id', U('viewer', 'ws'), (c, p, { row }) => wsView(row));
  r('PATCH', '/api/workspaces/:id', U('owner', 'ws'), (c, p, { row: w }) => {
    const b = c.body;
    if (b.leasePolicy != null) run('UPDATE workspace SET lease_policy=? WHERE id=?', oneOf(b.leasePolicy, ['warn', 'enforce'], 'leasePolicy'), w.id);
    if (b.requireSecondPerson != null) run('UPDATE workspace SET require_second_person=? WHERE id=?', b.requireSecondPerson ? 1 : 0, w.id);
    if (b.failMode != null) {
      if (typeof b.failMode !== 'object') fail(400, 'failMode must be an object');
      const fm = { ...JSON.parse(w.fail_mode_json) };
      for (const [k, v] of Object.entries(b.failMode)) fm[oneOf(k, ['push', 'external', 'network', 'commit', 'files'], 'capability')] = oneOf(v, ['open', 'closed'], 'failMode');
      run('UPDATE workspace SET fail_mode_json=? WHERE id=?', JSON.stringify(fm), w.id);
    }
    return wsView(co.scope('ws', w.id).row);
  });

  // invites
  r('POST', '/api/workspaces/:id/invites', U('owner', 'ws'), (c, p, { ws }) => {
    const role = oneOf(c.body.role ?? 'editor', ROLES, 'role'), ttl = c.body.ttlHours == null ? 72 : int(c.body.ttlHours, 'ttlHours');
    if (ttl < 1 || ttl > 24 * 30) fail(400, 'ttlHours must be 1..720');
    const token = newToken();
    run('INSERT INTO invite (id, workspace_id, role, token_hash, expires_at) VALUES (?,?,?,?,?)', newId(), ws, role, sha256(token), Date.now() + ttl * 3_600_000);
    return { token, url: `${publicUrl}/#/invite/${token}`, role, expiresAt: Date.now() + ttl * 3_600_000 };
  });
  const invite = (token: string) => {
    const i = get('SELECT i.*, w.name ws_name FROM invite i JOIN workspace w ON w.id=i.workspace_id WHERE i.token_hash=?', sha256(token)) ?? fail(404, 'no such invite');
    if (i.used_by || i.expires_at <= Date.now()) fail(410, 'invite expired or already used');
    return i;
  };
  r('GET', '/api/invites/:token', ANY, (c, [t]) => { const i = invite(t); return { workspaceName: i.ws_name, role: i.role, workspaceId: i.workspace_id }; });
  r('POST', '/api/invites/:token/accept', ANY, (c, [t]) => {
    limit(c, 'invite');
    const i = invite(t);
    return tx(db, () => {
      const userId = c.user?.id ?? createUser(c.body.name, c.body.password);
      if (!run('UPDATE invite SET used_by=? WHERE id=? AND used_by IS NULL AND expires_at>?', userId, i.id, Date.now()).changes) fail(410, 'invite expired or already used');
      const cur = roleOf(userId, i.workspace_id);
      if (!cur || ROLES.indexOf(cur) < ROLES.indexOf(i.role)) run('INSERT OR REPLACE INTO member (workspace_id, user_id, role) VALUES (?,?,?)', i.workspace_id, userId, i.role);
      if (!c.user) login(c, userId);
      emit(i.workspace_id, 'presence', { userId, joined: true });
      return { workspaceId: i.workspace_id, role: roleOf(userId, i.workspace_id), user: c.user };
    });
  });

  // device flow
  r('POST', '/api/device/start', CLI, c => {
    limit(c, 'device-start');
    const deviceCode = newToken(), code = userCode();
    run('INSERT INTO device_code (device_code_hash, user_code, name, expires_at) VALUES (?,?,?,?)', sha256(deviceCode), code, sanitize(str(c.body.name, 100, 'name'), 100), Date.now() + 600_000);
    return { deviceCode, userCode: code, verifyUrl: `${publicUrl}/#/device/${code}`, expiresIn: 600, interval: 5 };
  });
  r('POST', '/api/device/approve', USER, c => {
    const u = me(c), code = String(c.body.userCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const row = get('SELECT * FROM device_code WHERE replace(user_code, \'-\', \'\')=? AND expires_at>?', code, Date.now()) ?? fail(404, 'unknown or expired code');
    if (row.device_id) fail(409, 'code already used');
    const id = newId(), token = newToken();
    tx(db, () => {
      run('INSERT INTO device (id, user_id, name, token_hash) VALUES (?,?,?,?)', id, u.id, row.name, sha256(token));
      run('UPDATE device_code SET user_id=?, device_id=?, token=? WHERE device_code_hash=?', u.id, id, token, row.device_code_hash);
    });
    return { deviceId: id, name: row.name };
  });
  // What the approve page shows before the click: the name the computer gave itself.
  r('GET', '/api/device/lookup/:code', USER, (c, [code]) => {
    const row = get('SELECT name, device_id FROM device_code WHERE replace(user_code, \'-\', \'\')=? AND expires_at>?', code.toUpperCase().replace(/[^A-Z0-9]/g, ''), Date.now()) ?? fail(404, 'unknown or expired code');
    return { name: row.name, used: !!row.device_id };
  });
  r('POST', '/api/device/poll', CLI, c => {
    limit(c, 'device-poll');
    const row = get('SELECT * FROM device_code WHERE device_code_hash=?', sha256(String(c.body.deviceCode ?? '')));
    if (!row || row.expires_at <= Date.now()) { if (row) run('DELETE FROM device_code WHERE device_code_hash=?', row.device_code_hash); fail(410, 'expired'); }
    if (!row.device_id) { c.res.statusCode = 428; return { pending: true }; }
    run('DELETE FROM device_code WHERE device_code_hash=?', row.device_code_hash);
    return { deviceId: row.device_id, deviceToken: row.token };
  });
  r('GET', '/api/devices', USER, c => all('SELECT id, name, last_seen_at, revoked_at FROM device WHERE user_id=? ORDER BY name', me(c).id).map(d => ({ ...camel(d), online: online.has(d.id) })));
  r('DELETE', '/api/devices/:id', USER, (c, [id]) => {
    if (!run('UPDATE device SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL', Date.now(), id, me(c).id).changes) fail(404, 'no such device');
    online.get(id)?.ws.close(4001, 'revoked');
    return { ok: true };
  });
  r('POST', '/api/workspaces/:id/bind', { who: 'device', role: 'viewer', on: 'ws' }, (c, p, { row: w }) => {
    const remote = str(c.body.remote, 1000, 'remote'), clonePath = str(c.body.clonePath, 4096, 'clonePath');
    if (normalizeRemote(remote) !== normalizeRemote(w.git_remote)) fail(400, `remote ${sanitize(remote, 200)} does not match workspace remote ${w.git_remote}`);
    run('INSERT OR REPLACE INTO binding (workspace_id, device_id, clone_path, verified_at) VALUES (?,?,?,?)', w.id, c.device!.id, clonePath, Date.now());
    return { ok: true, workspaceId: w.id, name: w.name };
  });

  // "Set up on this computer": the user's own online node finds or clones the repo, then binds itself.
  r('GET', '/api/workspaces/:id/computers', U('viewer', 'ws'), (c, p, { ws }) =>
    all('SELECT d.id, d.name, b.clone_path FROM device d LEFT JOIN binding b ON b.device_id=d.id AND b.workspace_id=? WHERE d.user_id=? AND d.revoked_at IS NULL ORDER BY d.name', ws, me(c).id)
      .map(d => ({ id: d.id, name: d.name, online: online.has(d.id), linked: !!d.clone_path, clonePath: d.clone_path })));
  r('POST', '/api/workspaces/:id/link', U('editor', 'ws'), (c, p, { row: w }) => {
    const mine = all('SELECT id FROM device WHERE user_id=? AND revoked_at IS NULL', me(c).id).map(d => d.id as string).filter(i => online.has(i));
    const dev = (c.body.deviceId == null ? mine[0] : mine.find(i => i === c.body.deviceId)) ?? fail(409, 'none of your computers is online: start Murmur on it first');
    send(dev, 'workspace.link', { workspaceId: w.id, name: w.name, remote: w.git_remote, clonePath: optStr(c.body.clonePath, 4096, 'clonePath') });
    return { ok: true, deviceId: dev };
  });

  // sessions & lanes
  r('POST', '/api/workspaces/:id/sessions', U('editor', 'ws'), (c, p, { ws, role }) => ln.open(ws!, me(c), role, c.body));
  const overlapIn = (sid: string) => !!get(`SELECT 1 FROM lane_dirty a JOIN lane_dirty b ON a.path=b.path AND a.lane_id<b.lane_id JOIN lane la ON la.id=a.lane_id
    JOIN lane lb ON lb.id=b.lane_id WHERE la.session_id=? AND lb.session_id=? AND la.status<>'stopped' AND lb.status<>'stopped' LIMIT 1`, sid, sid);
  r('GET', '/api/workspaces/:id/sessions', U('viewer', 'ws'), (c, p, { ws }) =>
    all('SELECT * FROM session WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200', ws).map(s => ({
      ...camel(s), lanes: co.lanesOf(s.id), openConflicts: get(`SELECT count(*) n FROM conflict WHERE session_id=? AND status='open'`, s.id).n, overlap: overlapIn(s.id),
    })));
  r('GET', '/api/sessions/:id', U('viewer', 'session'), (c, p, { row: s }) => {
    const lanes = co.lanesOf(s.id), dirty: Record<string, unknown[]> = {};
    for (const l of lanes) dirty[l.id] = all('SELECT path, added, removed, blob_sha, patch, updated_at FROM lane_dirty WHERE lane_id=? ORDER BY path', l.id).map(camel);
    return { session: camel(s), lanes, plan: co.plan(s.id), conflicts: all('SELECT * FROM conflict WHERE session_id=? ORDER BY created_at', s.id).map(camel), dirty };
  });
  r('POST', '/api/sessions/:id/join', U('editor', 'session'), (c, p, { row, role }) => ln.join(row, me(c), role, c.body));
  r('POST', '/api/sessions/:id/finish', U('editor', 'session'), (c, p, { row, role }) => ln.finish(row, me(c), role));
  r('POST', '/api/lanes/:id/prompt', U('viewer', 'lane', 'owner'), (c, p, { row }) => ln.prompt(row, me(c), c.body.text));
  for (const t of ['interrupt', 'stop'] as const) r('POST', `/api/lanes/:id/${t}`, U('viewer', 'lane', 'owner+ws'), (c, p, { row }) => ln.signal(row, t));
  r('POST', '/api/lanes/:id/mode', U('viewer', 'lane', 'owner+ws'), (c, p, { row, role }) => ln.setMode(row, role, c.body.mode));
  r('POST', '/api/lanes/:id/handoff', U('viewer', 'lane', 'owner'), (c, p, { row }) => ln.handOff(row, c.body.reason, ''));
  r('POST', '/api/lanes/:id/takeover', U('editor', 'lane'), (c, p, { row }) => ln.takeover(row, me(c), c.body));
  r('GET', '/api/lanes/:id/events', U('viewer', 'lane'), (c, p, { row }) => ({ events: co.laneEvents(row.id, c.url.searchParams.get('tail')) }));

  // coordination (cookie)
  r('POST', '/api/sessions/:id/plan', U('editor', 'session'), (c, p, { row: s }) => ({ steps: co.publishPlan(s.workspace_id, s.id, c.body.steps) }));
  r('PATCH', '/api/steps/:id', U('editor', 'step'), (c, [id], { ws }) => co.updateStep(ws!, id, c.body));
  r('GET', '/api/workspaces/:id/tasks', U('viewer', 'ws'), (c, p, { ws }) => co.listTasks(ws!));
  r('POST', '/api/workspaces/:id/tasks', U('editor', 'ws'), (c, p, { ws }) => {
    if (c.body.sessionId != null && co.scope('session', c.body.sessionId).ws !== ws) fail(404, 'no such session');
    return co.createTask(ws!, c.body);
  });
  r('PATCH', '/api/tasks/:id', U('editor', 'task'), (c, [id], { ws }) => co.updateTask(ws!, id, c.body));
  r('POST', '/api/tasks/:id/claim', U('editor', 'task'), (c, [id], { ws }) => {
    const laneId = c.body.laneId == null ? null : can(c, U('viewer', 'lane', 'owner'), c.body.laneId).row.id;
    return co.claimTask(ws!, id, c.body.version, laneId, me(c).id);
  });
  r('POST', '/api/messages', U('commenter', 'ws'), (c, p, { ws }) => co.sendMessage(ws!, c.body.to, c.body.body, { userId: me(c).id }), c => c.body.workspaceId);
  r('GET', '/api/workspaces/:id/messages', U('viewer', 'ws'), (c, p, { ws }) => co.listMessages(ws!));
  r('GET', '/api/workspaces/:id/approvals', U('viewer', 'ws'), (c, p, { ws }) => {
    const st = c.url.searchParams.get('status');
    return co.listApprovals(ws!, st ? oneOf(st, ['pending', 'allowed', 'denied', 'expired'], 'status') : undefined);
  });
  r('POST', '/api/approvals/:id/decide', U('editor', 'approval'), (c, [id]) => co.decide(id, me(c), c.body.decision, c.body.scope));
  r('GET', '/api/workspaces/:id/memory', U('viewer', 'ws'), (c, p, { ws }) => co.recall(ws!, c.url.searchParams.get('q') ?? '', [], true));
  r('POST', '/api/workspaces/:id/memory', U('editor', 'ws'), (c, p, { ws }) => co.remember(ws!, c.body, { userId: me(c).id }));
  r('PATCH', '/api/memory/:id', U('editor', 'memory'), (c, [id], { ws }) => co.patchMemory(ws!, id, c.body));
  r('POST', '/api/conflicts/:id/resolve', U('editor', 'conflict'), (c, p, { row }) => co.resolveConflict(row, c.body.choice));

  // lane-only (bearer)
  const LANE_DEVICE: Rule = { who: 'device', on: 'lane', lane: 'device' };
  r('GET', '/api/lanes/:id/digest', LANE_DEVICE, (c, p, { row }) => co.digest(row.id));
  r('POST', '/api/lanes/:id/pretool', LANE_DEVICE, (c, p, { row }) => co.pretool(row, c.body));
  r('POST', '/api/lanes/:id/tool/:tool', LANE_DEVICE, (c, [, t], { row }) => ({ result: co.tool(row, t, c.body.args) }));

  // ---- http ----
  const readBody = (req: IncomingMessage) => new Promise<string>((res, rej) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', d => { s += d; if (s.length > 2 << 20) { rej(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => res(s)); req.on('error', rej);
  });
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body ?? null));
  };
  async function serveStatic(pathname: string, res: ServerResponse) {
    let file: string;
    try { file = resolve(WEB, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname))); } catch { return json(res, 400, { error: 'bad path' }); }
    if (!file.startsWith(WEB)) return json(res, 404, { error: 'not found' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' }).end(data);
    } catch { json(res, 404, { error: 'not found' }); }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) return req.method === 'GET' || req.method === 'HEAD' ? await serveStatic(url.pathname, res) : json(res, 405, { error: 'method not allowed' });
      const raw = await readBody(req);
      let body: any = {};
      if (raw) try { body = JSON.parse(raw); } catch { fail(400, 'bad json'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'body must be a JSON object');
      const c: Ctx = { req, res, url, body, ip: req.socket.remoteAddress ?? '?' };
      const device = req.headers.authorization ? bearerDevice(req) ?? fail(401, 'bad device token') : undefined;
      if (device) {
        // A device token lives on disk next to the agent; it must never act as its human (approve, invite, take over).
        if (!pathOk(url.pathname, x => x.who === 'device')) fail(403, 'device tokens may only call lane and bind routes');
        c.device = device; c.user = get('SELECT id, name FROM user WHERE id=?', device.user_id);
        run('UPDATE device SET last_seen_at=? WHERE id=?', Date.now(), device.id);
      } else {
        c.user = cookieUser(req);
        // Custom header + JSON content type force a CORS preflight: CSRF-safe. Device-flow start/poll come from the CLI.
        if (req.method !== 'GET' && !pathOk(url.pathname, x => x.csrf === false)) {
          if (req.headers['x-murmur-csrf'] !== '1') fail(403, 'missing x-murmur-csrf header');
          if (raw && !String(req.headers['content-type']).startsWith('application/json')) fail(415, 'content-type must be application/json');
        }
      }
      for (const x of routes) {
        const hit = x.m === req.method && x.re.exec(url.pathname);
        if (!hit) continue;
        let params: string[];
        try { params = hit.slice(1).map(decodeURIComponent); } catch { return fail(400, 'bad url'); }
        res.statusCode = 200;
        const out = await x.fn(c, params, can(c, x.rule, x.id ? x.id(c) : params[0]));
        return json(res, res.statusCode, out);
      }
      fail(404, 'not found');
    } catch (e: any) {
      if (!e.status) console.error('murmur-hub:', e);
      if (!res.headersSent) json(res, e.status ?? 500, { error: e.status ? e.message : 'internal error', ...(e.current !== undefined ? { current: e.current } : {}) });
    }
  });

  // ---- websockets ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 << 20 });
  const reject = (sock: any, code: number) => { sock.end(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Forbidden'}\r\nconnection: close\r\n\r\n`); };
  server.on('upgrade', (req, sock, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/ws/node') {
      const d = bearerDevice(req);
      if (!d) return reject(sock, 401);
      return wss.handleUpgrade(req, sock, head, ws => onNode(ws, d));
    }
    if (url.pathname === '/ws/ui') {
      const u = cookieUser(req), wsId = url.searchParams.get('workspace') ?? '';
      if (!u) return reject(sock, 401);
      let originHost: string | null = null;
      try { originHost = req.headers.origin ? new URL(req.headers.origin).host : req.headers.host ?? null; } catch {}
      if (originHost !== req.headers.host) return reject(sock, 403);
      if (!isId(wsId) || !roleOf(u.id, wsId)) return reject(sock, 403);
      return wss.handleUpgrade(req, sock, head, ws => onUi(ws, u.id, wsId, Number(url.searchParams.get('since')) || 0));
    }
    sock.destroy();
  });

  function onUi(ws: WebSocket, userId: string, wsId: string, since: number) {
    const rows = all('SELECT * FROM (SELECT * FROM event WHERE workspace_id=? AND seq>? ORDER BY seq DESC LIMIT 500) ORDER BY seq', wsId, since);
    for (const e of rows) ws.send(JSON.stringify({ seq: e.seq, type: e.type, sessionId: e.session_id, laneId: e.lane_id, d: JSON.parse(e.payload_json), at: e.at }));
    for (const e of co.replay(wsId)) ws.send(JSON.stringify({ type: 'lane.events', sessionId: e.sessionId, laneId: e.laneId, d: { batch: e.batch }, replay: true }));
    const sub = { ws, wsId, userId };
    ui.add(sub);
    ws.on('close', () => ui.delete(sub));
    ws.on('error', () => {});
  }

  function onNode(ws: WebSocket, dev: any) {
    online.get(dev.id)?.ws.close(4000, 'replaced');
    online.set(dev.id, { ws, userId: dev.user_id });
    ln.seen(dev.id);
    run('UPDATE device SET last_seen_at=? WHERE id=?', Date.now(), dev.id);
    presence(dev.user_id, dev.id, true);
    ws.on('message', m => {
      let f: Frame;
      try { f = JSON.parse(String(m)); } catch { return; }
      if (!f || typeof f.t !== 'string') return;
      ln.seen(dev.id);
      const seq = Number.isSafeInteger(f.seq) ? f.seq! : null;
      const ns = nodeSeq.get(dev.id) ?? { boot: undefined, seq: 0 };
      nodeSeq.set(dev.id, ns);
      if (f.t === 'hello') { if (f.d?.boot !== ns.boot) { ns.boot = f.d?.boot; ns.seq = 0; } } // new boot id: node restarted, seq starts over
      else if (seq !== null && seq <= ns.seq) return void ws.send(JSON.stringify({ t: 'ack', d: { seq: ns.seq } }));
      try { onFrame(dev, f); } catch (e: any) {
        if (!e.status) console.error('murmur-hub frame', f.t, e);
        ws.send(JSON.stringify({ t: 'error', ref: f.id ?? f.t, d: { text: sanitize(e.message, 300) } }));
      }
      if (f.t !== 'hello' && seq !== null) { ns.seq = seq; ws.send(JSON.stringify({ t: 'ack', d: { seq } })); }
    });
    ws.on('close', () => {
      if (online.get(dev.id)?.ws !== ws) return;
      online.delete(dev.id);
      run('UPDATE device SET last_seen_at=? WHERE id=?', Date.now(), dev.id);
      presence(dev.user_id, dev.id, false);
    });
    ws.on('error', () => {});
  }

  // Node frames map 1:1 onto core calls; the core checks the lane is on this device.
  function onFrame(dev: any, f: Frame) {
    const d = f.d ?? {};
    switch (f.t) {
      case 'hello':
        run('UPDATE device SET claude_json=? WHERE id=?', JSON.stringify(d.claude ?? null).slice(0, 2000), dev.id);
        return ln.hello(dev.id, d.lanes);
      case 'lane.status': return ln.report(dev.id, d);
      case 'lane.claude': return ln.claude(dev.id, d);
      case 'lane.events': {
        const L = ln.own(dev.id, d.laneId), batch = co.bufferEvents(L, d.batch);
        return void (batch && broadcast(L.ws, { type: 'lane.events', sessionId: L.session_id, laneId: L.id, d: { batch } }));
      }
      case 'lane.diff': return co.onDiff(ln.own(dev.id, d.laneId), d.files);
      case 'lane.snapshot': return co.onSnapshot(ln.own(dev.id, d.laneId), d);
      case 'merge.result': return co.onMergeResult(dev.id, d);
      case 'conflict.resolved': return co.conflictResolved(dev.id, d);
      case 'lane.integrated': return ln.integrated(dev.id, d);
      case 'message.delivered': return co.delivered(ln.own(dev.id, d.laneId), d.messageId);
      case 'workspace.linked': {
        const w = isId(d.workspaceId) && roleOf(dev.user_id, d.workspaceId) ? d.workspaceId : fail(403, 'not a member of that workspace');
        return emit(w, 'computer.linked', { userId: dev.user_id, deviceId: dev.id, deviceName: dev.name, ok: !!d.ok, error: d.ok ? null : sanitize(d.error, 300) });
      }
      case 'pong': return;
      case 'error': return console.warn('murmur-hub: node', dev.id, 'error:', sanitize(d.text, 300));
    }
  }

  // ---- timers ----
  function sweep() {
    const t = Date.now();
    co.sweep(t);
    run('DELETE FROM device_code WHERE expires_at<=?', t);
    run('DELETE FROM web_session WHERE expires_at<=?', t);
    for (const [k, arr] of hits) if (!arr.some(x => x > t - 60_000)) hits.delete(k);
  }
  const timers = [setInterval(sweep, 5000), setInterval(() => { for (const id of online.keys()) send(id, 'ping', {}); }, 20_000)];

  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(o.port, o.host ?? '127.0.0.1', () => res()); });
  const addr = server.address() as { port: number; address: string };
  const url = `http://${(o.host ?? '127.0.0.1').includes(':') ? `[${o.host}]` : o.host ?? '127.0.0.1'}:${addr.port}`;
  const publicUrl = (o.publicUrl ?? url).replace(/\/+$/, '');

  return {
    url, db, setupCode, sweep,
    close: async () => {
      timers.forEach(clearInterval);
      for (const c of wss.clients) { c.removeAllListeners(); c.on("error", () => {}); c.terminate(); }
      wss.close();
      server.closeAllConnections();
      await new Promise(res => server.close(res));
      db.close();
    },
  };
}
