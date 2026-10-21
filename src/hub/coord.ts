// Coordination: plan, board, leases, overlap, messages, memory, approvals, digest, lane tools.
import { matchesGlob } from 'node:path';
import { newId, argsHash, sanitize, untrusted, safeRelPath, isId, type Capability } from '../shared.ts';
import { tx } from './db.ts';
import { fail, str, optStr, oneOf, int, paths, camel } from './check.ts';
import { laneCore, LANE_SQL, type Hub, type Lane } from './lanes.ts';

export type { Hub, Lane };
export type Kind = 'ws' | 'session' | 'lane' | 'step' | 'task' | 'approval' | 'memory' | 'conflict';
const CAPS = ['files', 'commit', 'push', 'network', 'external'];
const STEP_STATUS = ['unstarted', 'ready', 'in_progress', 'done', 'blocked'];
const COLS = ['backlog', 'ready', 'in_progress', 'review', 'done'];
const DAY = 86_400_000;
// Agent-to-agent messages wake the recipient. Cap the chain between human prompts so two agents
// cannot ping-pong forever; past the cap messages still arrive via digest and get_messages.
const MAX_AGENT_WAKES = 8;

const withPaths = (r: any) => r && { ...camel(r), paths: JSON.parse(r.paths_json) };
const globHit = (p: string, g: string) => p === g || (g.endsWith('/') && p.startsWith(g)) || matchesGlob(p, g);

export function coord(h: Hub) {
  const { get, all, run, emit, send } = h;
  const now = h.now;
  const lanes = laneCore(h, { plan: s => plan(s), humanTurn: id => humanTurn(id) });
  const { lane, lanesOf } = lanes;
  const live = (sessionId: string, except = ''): Lane[] => all(`${LANE_SQL} WHERE l.session_id=? AND l.status<>'stopped' AND l.id<>?`, sessionId, except);
  const roleOf = (userId: string, ws: string): string | undefined => get('SELECT role FROM member WHERE user_id=? AND workspace_id=?', userId, ws)?.role;
  // In-memory state, all pruned by sweep(): agent wake counts, last overlap per lane pair, last merge-checked snapshot pair, live event ring.
  const wakes = new Map<string, number>(), lastOverlap = new Map<string, string>(), checked = new Map<string, string>();
  const ring = new Map<string, { at: number; ws: string; sessionId: string; batch: unknown[] }[]>();
  const humanTurn = (laneId: string) => wakes.delete(laneId);

  // Resource -> workspace, the one lookup every route and policy check goes through.
  const SCOPE: Record<Kind, [string, string]> = {
    ws: ['SELECT * FROM workspace WHERE id=?', 'workspace'],
    session: ['SELECT * FROM session WHERE id=?', 'session'],
    lane: [`${LANE_SQL} WHERE l.id=?`, 'lane'],
    step: ['SELECT p.*, s.workspace_id ws FROM plan_step p JOIN session s ON s.id=p.session_id WHERE p.id=?', 'step'],
    task: ['SELECT * FROM task WHERE id=?', 'task'],
    approval: ['SELECT a.id, s.workspace_id ws FROM approval a JOIN lane l ON l.id=a.lane_id JOIN session s ON s.id=l.session_id WHERE a.id=?', 'approval'],
    memory: ['SELECT * FROM memory WHERE id=?', 'memory'],
    conflict: ['SELECT c.*, s.workspace_id ws, s.branch FROM conflict c JOIN session s ON s.id=c.session_id WHERE c.id=?', 'conflict'],
  };
  function scope(kind: Kind, id: unknown): { row: any; ws: string } {
    const [sql, name] = SCOPE[kind];
    const row = (isId(id) && get(sql, kind === 'memory' ? Number(id) : id)) || fail(404, `no such ${name}`);
    return { row, ws: row.ws ?? row.workspace_id ?? row.id };
  }

  // ---- plan ----
  const plan = (sessionId: string) => all('SELECT * FROM plan_step WHERE session_id=? ORDER BY ord', sessionId).map(withPaths);
  function publishPlan(ws: string, sessionId: string, steps: unknown) {
    if (!Array.isArray(steps) || steps.length > 100) fail(400, 'steps must be an array (≤100)');
    const rows = (steps as any[]).map(s => ({ text: str(s?.text, 500, 'step text'), paths: paths(s?.paths) }));
    tx(h.db, () => {
      run('DELETE FROM plan_step WHERE session_id=?', sessionId);
      rows.forEach((s, i) => run('INSERT INTO plan_step (id, session_id, ord, text, paths_json) VALUES (?,?,?,?,?)', newId(), sessionId, i, s.text, JSON.stringify(s.paths)));
    });
    const p = plan(sessionId);
    emit(ws, 'plan.updated', { steps: p }, sessionId);
    return p;
  }
  const step = (ws: string, id: unknown): any => (isId(id) && get('SELECT p.* FROM plan_step p JOIN session s ON s.id=p.session_id WHERE p.id=? AND s.workspace_id=?', id, ws)) || fail(404, 'no such step');
  function updateStep(ws: string, id: unknown, b: any) {
    const status = b.status == null ? null : oneOf(b.status, STEP_STATUS, 'status');
    const note = b.note == null ? null : str(b.note, 1000, 'note');
    const version = b.version == null ? null : int(b.version, 'version');
    return tx(h.db, () => {
      const s = step(ws, id);
      const owner = b.ownerLaneId === undefined ? s.owner_lane_id : b.ownerLaneId === null ? null : lane(b.ownerLaneId).id;
      if (b.claim && s.owner_lane_id && s.owner_lane_id !== owner) fail(409, `step is owned by lane ${s.owner_lane_id}; message them`, { ownerLaneId: s.owner_lane_id, version: s.version });
      if (b.release && s.owner_lane_id !== b.release) fail(409, 'you do not own this step', { ownerLaneId: s.owner_lane_id });
      const r = run('UPDATE plan_step SET status=coalesce(?,status), note=coalesce(?,note), owner_lane_id=?, version=version+1 WHERE id=? AND version=?',
        status, note, owner, s.id, version ?? s.version);
      if (!r.changes) fail(409, 'version conflict', { version: s.version, status: s.status, ownerLaneId: s.owner_lane_id });
      emit(ws, 'plan.updated', { steps: plan(s.session_id) }, s.session_id);
      return withPaths(get('SELECT * FROM plan_step WHERE id=?', s.id));
    });
  }

  // ---- board ----
  const task = (ws: string, id: unknown): any => (isId(id) && get('SELECT * FROM task WHERE id=? AND workspace_id=?', id, ws)) || fail(404, 'no such task');
  const listTasks = (ws: string) => all('SELECT * FROM task WHERE workspace_id=? ORDER BY created_at', ws).map(withPaths);
  function createTask(ws: string, b: any) {
    const id = newId();
    run('INSERT INTO task (id, workspace_id, title, notes, paths_json, acceptance, col, session_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, ws, str(b.title, 200, 'title'), optStr(b.notes, 4000, 'notes') ?? '', JSON.stringify(paths(b.paths)), optStr(b.acceptance, 2000, 'acceptance') ?? '',
      b.col == null ? 'backlog' : oneOf(b.col, COLS, 'col'), b.sessionId ?? null, now());
    const t = withPaths(get('SELECT * FROM task WHERE id=?', id));
    emit(ws, 'task.updated', t);
    return t;
  }
  function updateTask(ws: string, id: unknown, b: any) {
    const col = (b.col ?? b.status) == null ? null : oneOf(b.col ?? b.status, COLS, 'col');
    const title = b.title == null ? null : str(b.title, 200, 'title'), notes = b.notes == null ? null : str(b.notes, 4000, 'notes');
    const acceptance = b.acceptance == null ? null : str(b.acceptance, 2000, 'acceptance');
    const ps = b.paths == null ? null : JSON.stringify(paths(b.paths));
    return tx(h.db, () => {
      const t = task(ws, id);
      const r = run(`UPDATE task SET col=coalesce(?,col), title=coalesce(?,title), notes=coalesce(?,notes), acceptance=coalesce(?,acceptance),
        paths_json=coalesce(?,paths_json), version=version+1 WHERE id=? AND version=?`, col, title, notes, acceptance, ps, t.id, b.version == null ? t.version : int(b.version, 'version'));
      if (!r.changes) fail(409, 'version conflict', withPaths(t));
      const out = withPaths(get('SELECT * FROM task WHERE id=?', t.id));
      emit(ws, 'task.updated', out);
      return out;
    });
  }
  function claimTask(ws: string, id: unknown, version: unknown, laneId: string | null, userId: string) {
    const v = int(version, 'version');
    return tx(h.db, () => {
      const t = task(ws, id);
      const r = run(`UPDATE task SET col='in_progress', claimed_by_lane_id=?, assignee_user_id=?, version=version+1 WHERE id=? AND version=?`, laneId, userId, t.id, v);
      if (!r.changes) fail(409, 'task was changed or claimed by someone else', withPaths(t));
      const out = withPaths(get('SELECT * FROM task WHERE id=?', t.id));
      emit(ws, 'task.updated', out);
      return out;
    });
  }

  // ---- leases ----
  function leaseFiles(L: Lane, ps: string[], ttlSec: unknown) {
    const ttl = ttlSec == null ? 600 : Math.min(Math.max(int(ttlSec, 'ttlSec'), 10), 86400);
    const t = now(), granted: string[] = [], held: any[] = [];
    tx(h.db, () => {
      for (const p of ps) {
        const r = run(`INSERT INTO lease (workspace_id, path, lane_id, expires_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id, path)
          DO UPDATE SET lane_id=excluded.lane_id, expires_at=excluded.expires_at WHERE lease.lane_id=excluded.lane_id OR lease.expires_at<=?`, L.ws, p, L.id, t + ttl * 1000, t);
        if (r.changes) granted.push(p);
        else held.push(camel(get('SELECT le.path, le.lane_id, le.expires_at, u.name owner_name FROM lease le JOIN lane l ON l.id=le.lane_id JOIN user u ON u.id=l.owner_user_id WHERE le.workspace_id=? AND le.path=?', L.ws, p)));
      }
    });
    if (granted.length) emit(L.ws, 'lease.updated', { laneId: L.id, granted, expiresAt: t + ttl * 1000 }, L.session_id, L.id);
    return { granted, held };
  }
  function releaseFiles(L: Lane, ps: string[]) {
    const r = ps.length ? run('DELETE FROM lease WHERE lane_id=? AND path IN (SELECT value FROM json_each(?))', L.id, JSON.stringify(ps)) : run('DELETE FROM lease WHERE lane_id=?', L.id);
    emit(L.ws, 'lease.updated', { laneId: L.id, released: ps.length ? ps : 'all' }, L.session_id, L.id);
    return { released: Number(r.changes) };
  }
  const othersLeases = (L: Lane) => all(`SELECT le.path, le.lane_id, u.name FROM lease le JOIN lane l ON l.id=le.lane_id JOIN user u ON u.id=l.owner_user_id
    WHERE le.workspace_id=? AND le.lane_id<>? AND le.expires_at>? AND l.status<>'stopped'`, L.ws, L.id, now());

  // ---- diffs, overlap, conflicts ----
  const dirty = (laneId: string): string[] => all('SELECT path FROM lane_dirty WHERE lane_id=?', laneId).map(r => r.path);
  function onDiff(L: Lane, files: unknown) {
    if (!Array.isArray(files) || files.length > 5000) fail(400, 'files must be an array');
    const rows = (files as any[]).map(f => ({
      path: safeRelPath(f?.path) ?? fail(400, 'bad path'), added: Number(f.added) | 0, removed: Number(f.removed) | 0,
      blobSha: typeof f.blobSha === 'string' ? f.blobSha.slice(0, 64) : null, patch: typeof f.patch === 'string' ? f.patch.slice(0, 262144) : null,
    }));
    const t = now();
    tx(h.db, () => {
      run('DELETE FROM lane_dirty WHERE lane_id=?', L.id);
      for (const f of rows) run('INSERT OR REPLACE INTO lane_dirty (lane_id, path, added, removed, blob_sha, patch, updated_at) VALUES (?,?,?,?,?,?,?)', L.id, f.path, f.added, f.removed, f.blobSha, f.patch, t);
    });
    emit(L.ws, 'lane.diff', { laneId: L.id, files: rows.map(({ path, added, removed }) => ({ path, added, removed })) }, L.session_id, L.id);
    const mine = new Set(rows.map(f => f.path));
    for (const O of live(L.session_id, L.id)) {
      const both = dirty(O.id).filter(p => mine.has(p));
      const pats = [...plan(L.session_id).filter(s => s.ownerLaneId === O.id).flatMap(s => s.paths), ...all('SELECT path FROM lease WHERE lane_id=? AND expires_at>?', O.id, t).map(r => r.path)];
      const adj = [...mine].filter(p => !both.includes(p) && pats.some(g => globHit(p, g)));
      for (const [kind, ps] of [['overlap', both], ['adjacent', adj]] as const) {
        const key = `${L.id}|${O.id}|${kind}`, val = ps.join('\n');
        if ((lastOverlap.get(key) ?? '') === val) continue;
        lastOverlap.set(key, val);
        if (ps.length) emit(L.ws, 'overlap', { laneA: L.id, laneB: O.id, paths: ps, kind }, L.session_id, L.id);
      }
    }
    mergeChecks(L.id);
  }
  // Ask laneA's node to merge-tree both snapshots when they share dirty paths without an open conflict.
  function mergeChecks(laneId: string) {
    const L = lane(laneId);
    if (!L.snapshot_ref) return;
    const mine = new Set(dirty(L.id));
    for (const O of live(L.session_id, L.id)) {
      if (!O.snapshot_ref) continue;
      const both = dirty(O.id).filter(p => mine.has(p));
      const open = (p: string) => get(`SELECT 1 FROM conflict WHERE status='open' AND path=? AND ((lane_a=? AND lane_b=?) OR (lane_a=? AND lane_b=?))`, p, L.id, O.id, O.id, L.id);
      const key = `${L.id}|${O.id}`, val = `${L.snapshot_commit}|${O.snapshot_commit}`;
      if (!both.some(p => !open(p)) || checked.get(key) === val) continue;
      checked.set(key, val);
      send(L.device_id, 'merge.check', { sessionId: L.session_id, laneA: L.id, laneB: O.id, refA: L.snapshot_ref, refB: O.snapshot_ref });
    }
  }
  function onSnapshot(L: Lane, d: any) {
    const ref = str(d.ref, 300, 'ref'), commit = str(d.commit, 64, 'commit');
    if (![`refs/murmur/${L.session_id}/${L.id}`, `refs/heads/murmur-snap/${L.session_id}/${L.id}`].includes(ref) || !/^[0-9a-f]{7,64}$/.test(commit)) fail(400, 'bad snapshot');
    run('UPDATE lane SET snapshot_ref=?, snapshot_commit=?, snapshot_at=? WHERE id=?', ref, commit, now(), L.id);
    emit(L.ws, 'lane.snapshot', { laneId: L.id, ref, commit, at: now() }, L.session_id, L.id);
    mergeChecks(L.id);
  }
  function resolveConflict(k: any, choice: unknown) {
    const c = oneOf(choice, ['a', 'b'], 'choice'), L = lane(c === 'a' ? k.lane_a : k.lane_b);
    if (k.status !== 'open') fail(409, 'conflict already resolved', { status: k.status });
    if (!send(L.device_id, 'conflict.resolve', { conflictId: k.id, sessionId: k.session_id, branch: k.branch, path: k.path, fromRef: L.snapshot_ref ?? (c === 'a' ? k.ref_a : k.ref_b) })) fail(409, 'node offline');
    run('UPDATE conflict SET resolution=? WHERE id=?', `keep ${c} (${L.owner_name})`, k.id);
    return { ok: true };
  }
  function conflictResolved(deviceId: string, d: any) {
    const { branch, ...k } = scope('conflict', d.conflictId).row;
    if (!get('SELECT 1 FROM lane WHERE id IN (?,?) AND device_id=?', k.lane_a, k.lane_b, deviceId)) fail(403, 'not your conflict');
    run(`UPDATE conflict SET status='resolved' WHERE id=?`, k.id);
    emit(k.ws, 'conflict.resolved', { ...camel(k), status: 'resolved', commit: typeof d.commit === 'string' ? d.commit.slice(0, 64) : null }, k.session_id);
  }
  function onMergeResult(deviceId: string, d: any) {
    const A = lane(d.laneA), B = lane(d.laneB);
    if (A.device_id !== deviceId || B.session_id !== A.session_id) fail(403, 'not your merge check');
    if (d.clean || !Array.isArray(d.conflictPaths)) return;
    for (const p of paths(d.conflictPaths, 5000)) {
      const exists = get(`SELECT 1 FROM conflict WHERE status='open' AND path=? AND ((lane_a=? AND lane_b=?) OR (lane_a=? AND lane_b=?))`, p, A.id, B.id, B.id, A.id);
      if (exists) continue;
      const id = newId();
      run('INSERT INTO conflict (id, session_id, path, lane_a, lane_b, ref_a, ref_b, created_at) VALUES (?,?,?,?,?,?,?,?)', id, A.session_id, p, A.id, B.id, A.snapshot_ref, B.snapshot_ref, now());
      emit(A.ws, 'conflict.created', camel(get('SELECT * FROM conflict WHERE id=?', id)), A.session_id);
    }
  }
  function checkOverlap(L: Lane, ps: string[]) {
    const t = now(), steps = all('SELECT p.* FROM plan_step p JOIN session s ON s.id=p.session_id WHERE s.workspace_id=? AND p.owner_lane_id IS NOT NULL', L.ws).map(withPaths);
    const list = (ps.length ? ps : dirty(L.id)).map(path => ({
      path,
      dirty: all(`SELECT d.lane_id, d.added, d.removed FROM lane_dirty d JOIN lane l ON l.id=d.lane_id JOIN session s ON s.id=l.session_id
        WHERE s.workspace_id=? AND d.path=? AND d.lane_id<>? AND l.status<>'stopped'`, L.ws, path, L.id).map(camel),
      planned: steps.filter(s => s.ownerLaneId !== L.id && s.paths.some((g: string) => globHit(path, g))).map(s => ({ stepId: s.id, laneId: s.ownerLaneId, text: s.text })),
      leased: camel(get('SELECT lane_id, expires_at FROM lease WHERE workspace_id=? AND path=? AND expires_at>? AND lane_id<>?', L.ws, path, t, L.id)) ?? null,
    }));
    return { paths: list, conflicts: all(`SELECT c.* FROM conflict c JOIN session s ON s.id=c.session_id WHERE s.workspace_id=? AND c.status='open'`, L.ws).map(camel) };
  }
  function peerChanges(L: Lane, laneId: unknown, since: unknown) {
    const target = laneId == null ? null : lane(laneId);
    if (target && target.ws !== L.ws) fail(404, 'no such lane');
    return all(`SELECT d.* FROM lane_dirty d JOIN lane l ON l.id=d.lane_id WHERE l.session_id=? AND d.lane_id<>? AND (? IS NULL OR d.lane_id=?) AND d.updated_at>?`,
      target?.session_id ?? L.session_id, L.id, target?.id, target?.id, Number(since) || 0).map(camel);
  }

  // ---- messages ----
  const MSG_SQL = `SELECT m.*, coalesce(fu.name || CASE WHEN m.from_lane_id IS NOT NULL THEN '''s agent' ELSE '' END, '?') from_name
    FROM message m LEFT JOIN user fu ON fu.id=m.from_user_id`;
  function sendMessage(ws: string, to: unknown, body: unknown, from: { userId: string; laneId?: string; sessionId?: string }) {
    const text = sanitize(str(body, 8000, 'body'), 4000);
    const m = /^(lane|session|user):([A-Za-z0-9_-]{1,64})$/.exec(String(to)) ?? (to === 'all' || to === 'session' ? [String(to), to === 'all' ? 'broadcast' : 'session', to === 'session' ? from.sessionId : null] : null);
    if (!m || (m[1] === 'session' && !m[2])) fail(400, 'to must be lane:<id>|session:<id>|user:<id>|all');
    const [, kind, toId] = m!;
    if (kind === 'lane' && lane(toId).ws !== ws) fail(404, 'no such lane');
    if (kind === 'session' && !get('SELECT 1 FROM session WHERE id=? AND workspace_id=?', toId, ws)) fail(404, 'no such session');
    if (kind === 'user' && !get('SELECT 1 FROM member WHERE user_id=? AND workspace_id=?', toId, ws)) fail(404, 'no such member');
    const id = newId(), t = now();
    run('INSERT INTO message (id, workspace_id, session_id, from_lane_id, from_user_id, to_kind, to_id, body, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, ws, from.sessionId ?? (kind === 'session' ? toId : null), from.laneId, from.userId, kind, toId, text, t, t + DAY);
    const out = camel(get(`${MSG_SQL} WHERE m.id=?`, id));
    emit(ws, 'message.created', out, out.sessionId);
    // Push to the recipient lanes: the node turns it into their next turn (queued if busy) and
    // acks with message.delivered, so the digest does not repeat it.
    const targets = kind === 'lane' ? [lane(toId)] : kind === 'session' ? live(toId, from.laneId ?? '') : [];
    const label = `${out.fromName}${from.laneId ? ` (lane ${from.laneId}; reply with send_message to "lane:${from.laneId}")` : ''}`;
    for (const T of targets) {
      if (T.status === 'stopped' || T.id === from.laneId) continue;
      if (from.laneId) { const n = (wakes.get(T.id) ?? 0) + 1; wakes.set(T.id, n); if (n > MAX_AGENT_WAKES) continue; }
      else humanTurn(T.id);
      send(T.device_id, 'message.deliver', { laneId: T.id, messageId: id, from: label, body: text });
    }
    return out;
  }
  const forLane = `m.workspace_id=? AND m.expires_at>? AND (m.from_lane_id IS NULL OR m.from_lane_id<>?) AND ((m.to_kind='lane' AND m.to_id=?)
    OR (m.to_kind='session' AND m.to_id=?) OR (m.to_kind='user' AND m.to_id=?) OR m.to_kind='broadcast')`;
  const listMessages = (ws: string) => all(`${MSG_SQL} WHERE m.workspace_id=? AND m.expires_at>? ORDER BY m.created_at DESC LIMIT 200`, ws, now()).reverse().map(camel);
  function delivered(L: Lane, messageId: unknown) {
    const m = isId(messageId) && get('SELECT id FROM message WHERE id=? AND workspace_id=?', messageId, L.ws);
    if (m) run('INSERT OR IGNORE INTO message_delivery (message_id, lane_id, delivered_at) VALUES (?,?,?)', m.id, L.id, now());
  }
  const getMessages = (L: Lane, since: unknown) => all(`${MSG_SQL} WHERE (${forLane} OR m.from_lane_id=?) AND m.created_at>? ORDER BY m.created_at`,
    L.ws, now(), L.id, L.id, L.session_id, L.owner_user_id, L.id, Number(since) || 0).map(camel);

  // ---- memory ----
  const refs = (id: number) => all('SELECT path, blob_sha FROM memory_ref WHERE memory_id=?', id).map(camel);
  const memView = (m: any) => ({ ...camel(m), refs: refs(m.id) });
  function remember(ws: string, b: any, by: { laneId?: string; userId?: string; sessionId?: string }) {
    const body = sanitize(str(b.body, 8000, 'body'), 4000);
    const rs = new Map<string, string | null>(paths(b.paths).map(p => [p, null]));
    if (Array.isArray(b.refs)) for (const r of b.refs.slice(0, 200)) { const p = safeRelPath(r?.path); if (p) rs.set(p, typeof r.blobSha === 'string' ? r.blobSha.slice(0, 64) : null); }
    const out = tx(h.db, () => {
      const id = Number(run('INSERT INTO memory (workspace_id, session_id, body, created_by_lane, created_by_user, created_at) VALUES (?,?,?,?,?,?)',
        ws, by.sessionId, body, by.laneId, by.userId, now()).lastInsertRowid);
      for (const [p, sha] of rs) run('INSERT INTO memory_ref (memory_id, path, blob_sha) VALUES (?,?,?)', id, p, sha);
      return memView(get('SELECT * FROM memory WHERE id=?', id));
    });
    emit(ws, 'memory.updated', out);
    return out;
  }
  function recall(ws: string, query: unknown, ps: string[], includeRetired = false) {
    const terms = (String(query ?? '').match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 20).map(t => `"${t}"`).join(' OR ');
    const rows = terms
      ? all(`SELECT m.* FROM memory_fts f JOIN memory m ON m.id=f.rowid WHERE memory_fts MATCH ? AND m.workspace_id=? AND (? OR m.retired_at IS NULL) ORDER BY f.rank LIMIT 50`, terms, ws, includeRetired)
      : all('SELECT * FROM memory WHERE workspace_id=? AND (? OR retired_at IS NULL) ORDER BY pinned DESC, created_at DESC LIMIT 100', ws, includeRetired);
    return rows.map(memView).filter(m => !ps.length || m.refs.some((r: any) => ps.some(p => globHit(r.path, p) || globHit(p, r.path)))).slice(0, 20);
  }
  function patchMemory(ws: string, id: unknown, b: any) {
    const m = get('SELECT * FROM memory WHERE id=? AND workspace_id=?', Number(id), ws) ?? fail(404, 'no such memory');
    if (b.body != null) run('UPDATE memory SET body=? WHERE id=?', sanitize(str(b.body, 8000, 'body'), 4000), m.id);
    if (b.pinned != null) run('UPDATE memory SET pinned=? WHERE id=?', b.pinned ? 1 : 0, m.id);
    if (b.retired != null) run('UPDATE memory SET retired_at=? WHERE id=?', b.retired ? now() : null, m.id);
    const out = memView(get('SELECT * FROM memory WHERE id=?', m.id));
    emit(ws, 'memory.updated', out);
    return out;
  }

  // ---- approvals ----
  const APPROVAL_SQL = `SELECT a.*, u.name owner_name, l.session_id, l.owner_user_id, l.device_id, s.workspace_id ws FROM approval a
    JOIN lane l ON l.id=a.lane_id JOIN session s ON s.id=l.session_id JOIN user u ON u.id=l.owner_user_id`;
  const approvalView = (a: any) => { const { ws, device_id, ...r } = a; return { ...camel(r), capabilities: JSON.parse(a.capabilities_json) }; };
  function listApprovals(ws: string, status?: string) {
    expireApprovals();
    return all(`${APPROVAL_SQL} WHERE s.workspace_id=? AND (? IS NULL OR a.status=?) ORDER BY a.created_at DESC LIMIT 200`, ws, status, status).map(approvalView);
  }
  function createApproval(L: Lane, tool: string, target: string, caps: string[], hash: string, reason: string, idem: string) {
    const id = newId(), t = now();
    run('INSERT INTO approval (id, lane_id, tool, target, capabilities_json, args_hash, reason, idem_key, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, L.id, tool, target, JSON.stringify(caps), hash, reason, idem, t, t + 120_000);
    emit(L.ws, 'approval.requested', approvalView(get(`${APPROVAL_SQL} WHERE a.id=?`, id)), L.session_id, L.id);
    return id;
  }
  function pretool(L: Lane, b: any) {
    const tool = str(b.tool, 200, 'tool'), toolUseId = str(b.toolUseId, 200, 'toolUseId'), ps = paths(b.paths);
    if (!Array.isArray(b.capabilities)) fail(400, 'capabilities must be an array');
    const caps = (b.capabilities as unknown[]).map(c => oneOf(c, CAPS, 'capability')) as Capability[];
    const target = sanitize(b.target ?? (typeof b.input?.command === 'string' ? b.input.command : ''), 1000);
    const held = othersLeases(L).filter(x => ps.includes(x.path));
    let warn: string | undefined;
    if (held.length) {
      warn = held.map(x => `${x.path} is leased by ${x.name} (lane ${x.lane_id})`).join('; ') + '. Message them (send_message) or pick other work.';
      if (get('SELECT lease_policy FROM workspace WHERE id=?', L.ws).lease_policy === 'enforce') return { decision: 'deny', reason: warn };
      emit(L.ws, 'overlap', { laneA: L.id, laneB: held[0].lane_id, paths: held.map(x => x.path), kind: 'lease' }, L.session_id, L.id);
    }
    if (!b.gated) return { decision: 'none', reason: warn };
    if (!caps.some(c => c === 'push' || c === 'external')) {
      const rules = all('SELECT path_glob FROM rule WHERE session_id=? AND tool=?', L.session_id, tool);
      if (rules.some(r => r.path_glob === '*' || (ps.length && ps.every(p => globHit(p, r.path_glob))))) return { decision: 'allow', reason: 'Murmur: allowed for this session' };
    }
    const idem = `${L.id}:${toolUseId}`;
    const ex = get('SELECT * FROM approval WHERE idem_key=?', idem);
    if (ex && ex.args_hash !== argsHash(tool, b.input ?? null)) return { decision: 'deny', reason: 'Murmur: arguments differ from the approved call' };
    if (ex) return ex.status === 'pending' ? { decision: 'pending', approvalId: ex.id } : { decision: ex.status === 'allowed' ? 'allow' : 'deny', approvalId: ex.id };
    return { decision: 'pending', approvalId: createApproval(L, tool, target, caps, argsHash(tool, b.input ?? null), sanitize(b.reason ?? '', 500), idem) };
  }
  function decide(id: unknown, user: { id: string; name: string }, decision: unknown, scope: unknown) {
    const dec = oneOf(decision, ['allow', 'deny'] as const, 'decision');
    const sc = scope == null ? 'once' : oneOf(scope, ['once', 'session'] as const, 'scope');
    expireApprovals();
    const a = (isId(id) && get(`${APPROVAL_SQL} WHERE a.id=?`, id)) || fail(404, 'no such approval');
    const caps: string[] = JSON.parse(a.capabilities_json);
    const risky = caps.includes('push') || caps.includes('external');
    if (dec === 'allow' && caps.includes('push') && a.owner_user_id === user.id && get('SELECT require_second_person r FROM workspace WHERE id=?', a.ws).r)
      fail(403, 'a second person must approve a push');
    if (sc === 'session' && risky) fail(400, 'push and external actions cannot be allowed for a whole session');
    tx(h.db, () => {
      const r = run(`UPDATE approval SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'`, dec === 'allow' ? 'allowed' : 'denied', user.id, now(), a.id);
      if (!r.changes) fail(409, 'already decided', { status: get('SELECT status FROM approval WHERE id=?', a.id).status });
      if (sc === 'session' && dec === 'allow') run('INSERT INTO rule (id, session_id, tool, path_glob, created_by, created_at) VALUES (?,?,?,?,?,?)', newId(), a.session_id, a.tool, '*', user.id, now());
    });
    const reason = `Murmur: ${dec === 'allow' ? 'approved' : 'denied'} by ${user.name}`;
    send(a.device_id, 'approval.decided', { approvalId: a.id, laneId: a.lane_id, decision: dec, argsHash: a.args_hash, reason });
    const out = approvalView(get(`${APPROVAL_SQL} WHERE a.id=?`, a.id));
    emit(a.ws, 'approval.decided', out, a.session_id, a.lane_id);
    return out;
  }
  function expireApprovals() {
    for (const a of all(`${APPROVAL_SQL} WHERE a.status='pending' AND a.expires_at<=?`, now())) {
      if (!run(`UPDATE approval SET status='expired', decided_at=? WHERE id=? AND status='pending'`, now(), a.id).changes) continue;
      send(a.device_id, 'approval.decided', { approvalId: a.id, laneId: a.lane_id, decision: 'deny', argsHash: a.args_hash, reason: 'Murmur: approval expired' });
      emit(a.ws, 'approval.decided', approvalView({ ...a, status: 'expired' }), a.session_id, a.lane_id);
    }
  }

  // ---- digest ----
  function digest(laneId: string) {
    const L = lane(laneId), t = now();
    const policy = get('SELECT lease_policy FROM workspace WHERE id=?', L.ws).lease_policy;
    const msgs = all(`${MSG_SQL} WHERE ${forLane} AND NOT EXISTS (SELECT 1 FROM message_delivery d WHERE d.message_id=m.id AND d.lane_id=?) ORDER BY m.created_at LIMIT 8`,
      L.ws, t, L.id, L.id, L.session_id, L.owner_user_id, L.id);
    const steps = plan(L.session_id);
    const leases = othersLeases(L);
    const mineSet = new Set([...dirty(L.id), ...steps.filter(s => s.ownerLaneId === L.id).flatMap(s => s.paths), ...all('SELECT path FROM lease WHERE lane_id=?', L.id).map(r => r.path)]);
    const others = live(L.session_id, L.id);
    const overlap = others.flatMap(O => {
      const ps = dirty(O.id).filter(p => [...mineSet].some(g => globHit(p, g)));
      return ps.length ? [`${O.owner_name} lane ${O.id} is editing ${ps.length} of your files: ${ps.slice(0, 5).join(', ')}`] : [];
    }).concat(others.map(O => {
      const s = get('SELECT count(*) n, coalesce(sum(added),0) a, coalesce(sum(removed),0) r FROM lane_dirty WHERE lane_id=?', O.id);
      return `${O.owner_name} lane ${O.id} (${O.status}): ${s.n} files, +${s.a} -${s.r}`;
    }));
    const sections: [string, string[]][] = [
      ['CONFLICTS', all(`SELECT * FROM conflict WHERE status='open' AND (lane_a=? OR lane_b=?)`, L.id, L.id)
        .map(c => `${c.path}: 2 versions (lane ${c.lane_a} vs lane ${c.lane_b}). Resolve before editing it.`)],
      ['MESSAGES', msgs.map(m => `${m.from_name}${m.from_lane_id ? ` (lane ${m.from_lane_id})` : ''}: ${JSON.stringify(m.body)} [reply: send_message]`)],
      ['LEASES', leases.map(x => `${x.path} leased by ${x.name} lane ${x.lane_id} [policy=${policy}]`)],
      ['OVERLAP', overlap],
      ['PLAN', [...steps.filter(s => s.ownerLaneId === L.id).map(s => `you own: ${s.ord + 1} "${s.text}" (${s.status})`),
        ...steps.filter(s => !s.ownerLaneId && s.status !== 'done').map(s => `unowned: ${s.ord + 1} "${s.text}"`)]],
      ['BOARD', all(`SELECT id, title FROM task WHERE workspace_id=? AND col='ready' ORDER BY created_at LIMIT 3`, L.ws).map(x => `ready: "${x.title}" (${x.id})`)],
      ['MEMORY', all('SELECT body FROM memory WHERE workspace_id=? AND retired_at IS NULL ORDER BY pinned DESC, created_at DESC LIMIT 3', L.ws).map(m => JSON.stringify(m.body))],
    ];
    const kept = sections.filter(([, lines]) => lines.length).map(([name, lines]) => [name, lines.slice(0, 8).map(x => sanitize(x, 160))] as const);
    const head = `MURMUR TEAM CONTEXT (session ${JSON.stringify(sanitize(L.title, 60))}, you are lane ${L.id} / ${sanitize(L.owner_name, 40)})\n`;
    const render = (n: number) => head + untrusted('murmur-hub', kept.slice(0, n).map(([name, lines]) => `${name}\n${lines.map(x => '- ' + x).join('\n')}`).join('\n') || 'nothing new');
    let n = kept.length;
    while (n > 0 && render(n).length > 2000) n--;
    if (kept.slice(0, n).some(([name]) => name === 'MESSAGES'))
      for (const m of msgs) run('INSERT OR IGNORE INTO message_delivery (message_id, lane_id, delivered_at) VALUES (?,?,?)', m.id, L.id, t);
    return { text: render(n) };
  }

  // ---- misc ----
  function teamStatus(ws: string) {
    const sessions = all(`SELECT * FROM session WHERE workspace_id=? AND status='active' ORDER BY created_at`, ws).map(s => ({
      ...camel(s), lanes: lanesOf(s.id).map(l => ({ ...l, step: plan(s.id).find(p => p.ownerLaneId === l.id && p.status === 'in_progress')?.text ?? null })),
    }));
    const online = all('SELECT DISTINCT u.id, u.name, d.id device_id FROM member m JOIN user u ON u.id=m.user_id JOIN device d ON d.user_id=u.id WHERE m.workspace_id=?', ws)
      .filter(r => h.online.has(r.device_id)).map(r => r.name);
    return { sessions, online: [...new Set(online)], conflicts: all(`SELECT c.* FROM conflict c JOIN session s ON s.id=c.session_id WHERE s.workspace_id=? AND c.status='open'`, ws).map(camel) };
  }
  function laneEvents(laneId: string, tail: unknown) {
    const n = Math.min(Math.max(Number(tail) || 200, 1), 2000);
    return (ring.get(laneId) ?? []).flatMap(e => e.batch).slice(-n);
  }
  // Live lane output: broadcast, kept 5 minutes for late joiners, never persisted.
  function bufferEvents(L: Lane, batch: unknown) {
    if (!Array.isArray(batch) || !batch.length) return;
    const b = batch.slice(0, 2000), at = now(), arr = ring.get(L.id) ?? [];
    arr.push({ at, ws: L.ws, sessionId: L.session_id, batch: b });
    while (arr.length && (arr[0].at < at - 300_000 || arr.length > 5000)) arr.shift();
    ring.set(L.id, arr);
    return b;
  }
  const replay = (ws: string) => [...ring].flatMap(([laneId, arr]) => arr.filter(e => e.ws === ws).map(e => ({ laneId, sessionId: e.sessionId, batch: e.batch })));

  function sweep(t = now()) {
    expireApprovals();
    for (const { workspace_id } of all('SELECT DISTINCT workspace_id FROM lease WHERE expires_at<=?', t)) {
      run('DELETE FROM lease WHERE workspace_id=? AND expires_at<=?', workspace_id, t);
      emit(workspace_id, 'lease.updated', { expired: true });
    }
    run('DELETE FROM message_delivery WHERE message_id IN (SELECT id FROM message WHERE expires_at<=?)', t);
    run('DELETE FROM message WHERE expires_at<=?', t);
    lanes.sweep(t);
    for (const [k, arr] of ring) { while (arr.length && arr[0].at < t - 300_000) arr.shift(); if (!arr.length) ring.delete(k); }
    const alive = new Set(all(`SELECT l.id FROM lane l JOIN session s ON s.id=l.session_id WHERE l.status<>'stopped' AND s.status='active'`).map(r => r.id as string));
    for (const k of wakes.keys()) if (!alive.has(k)) wakes.delete(k);
    for (const m of [lastOverlap, checked]) for (const k of m.keys()) { const [a, b] = k.split('|'); if (!alive.has(a) || !alive.has(b)) m.delete(k); }
  }

  function tool(L: Lane, name: string, a: any) {
    a = a && typeof a === 'object' ? a : {};
    const me = { userId: L.owner_user_id, laneId: L.id, sessionId: L.session_id };
    switch (name) {
      case 'team_status': return teamStatus(L.ws);
      case 'publish_plan': return publishPlan(L.ws, L.session_id, a.steps);
      case 'update_step': return updateStep(L.ws, a.stepId, { status: a.status, note: a.note, version: a.version });
      case 'claim_step': return updateStep(L.ws, a.stepId, { ownerLaneId: L.id, claim: true });
      case 'release_step': return updateStep(L.ws, a.stepId, { ownerLaneId: null, release: L.id });
      case 'board_list': return listTasks(L.ws);
      case 'create_task': return createTask(L.ws, { ...a, col: a.col ?? 'ready', sessionId: L.session_id });
      case 'claim_task': return claimTask(L.ws, a.taskId, a.version ?? task(L.ws, a.taskId).version, L.id, L.owner_user_id);
      case 'update_task': return updateTask(L.ws, a.taskId, a);
      case 'lease_files': return leaseFiles(L, paths(a.paths), a.ttlSec);
      case 'release_files': return releaseFiles(L, paths(a.paths));
      case 'check_overlap': return checkOverlap(L, paths(a.paths));
      case 'peer_changes': return peerChanges(L, a.laneId, a.since);
      case 'send_message': return sendMessage(L.ws, a.to, a.body, me);
      case 'get_messages': return getMessages(L, a.since);
      case 'remember': return remember(L.ws, a, me);
      case 'recall': return recall(L.ws, a.query, paths(a.paths));
      case 'request_approval': {
        const action = sanitize(str(a.action, 2000, 'action'), 1000);
        return { status: 'pending', approvalId: createApproval(L, 'request_approval', action, ['external'], argsHash('request_approval', { action }), sanitize(a.reason ?? '', 500), `${L.id}:${newId()}`) };
      }
      case 'hand_off': return lanes.handOff(L, a.reason, a.recent);
      case 'read_lane': {
        const O = lane(a.laneId);
        if (O.ws !== L.ws) fail(404, 'no such lane');
        return laneEvents(O.id, a.tail);
      }
      case 'record_outcome':
        emit(L.ws, 'outcome', { laneId: L.id, toolUseId: optStr(a.toolUseId, 200, 'toolUseId'), outcome: sanitize(str(a.outcome ?? a.text, 4000, 'outcome'), 2000) }, L.session_id, L.id);
        return { recorded: true };
    }
    return fail(404, `unknown tool ${sanitize(name, 50)}`);
  }

  return { lanes, lane, lanesOf, scope, roleOf, plan, publishPlan, updateStep, listTasks, createTask, updateTask, claimTask, onDiff, onSnapshot, onMergeResult,
    resolveConflict, conflictResolved, sendMessage, listMessages, delivered, remember, recall, patchMemory, listApprovals, pretool, decide, digest, laneEvents,
    bufferEvents, replay, sweep, tool, mem: { wakes, lastOverlap, checked, ring } };
}
