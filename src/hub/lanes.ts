// Lane lifecycle: open/join, start payload, status machine, takeover, handoff, staleness, integrate queue.
// Talks to the world only through Hub ports (db, send, emit, online, now): no sockets, testable in-process.
import type { DatabaseSync } from 'node:sqlite';
import { newId, sanitize, untrusted, isId, type LaneMode, type LaneStatus, type NodeCommands } from '../shared.ts';
import { tx, type q } from './db.ts';
import { fail, str, optStr, oneOf, int, camel } from './check.ts';

export type Hub = ReturnType<typeof q> & {
  db: DatabaseSync;
  emit: (ws: string, type: string, d: unknown, sessionId?: string | null, laneId?: string | null) => void;
  send: <T extends keyof NodeCommands>(deviceId: string, t: T, d: NodeCommands[T]) => boolean;
  online: { has(deviceId: string): boolean };
  now: () => number;
};

export type Lane = {
  id: string; session_id: string; owner_user_id: string; device_id: string; agent: string; mode: LaneMode; status: LaneStatus; status_reason: string | null;
  claude_session_id: string | null; snapshot_ref: string | null; snapshot_commit: string | null; snapshot_at: number | null; handoff_brief: string | null;
  created_at: number; version: number; integrate_pending: number;
  ws: string; title: string; branch: string; base_commit: string | null; session_status: string; owner_name: string;
};
export const LANE_SQL = `SELECT l.*, s.workspace_id ws, s.title, s.branch, s.base_commit, s.status session_status, u.name owner_name
  FROM lane l JOIN session s ON s.id=l.session_id JOIN user u ON u.id=l.owner_user_id`;
export const LANE_STATUS = ['starting', 'idle', 'running', 'blocked', 'awaiting_takeover', 'stale', 'stopped'] as const;
const MODES = ['plan', 'request', 'allow', 'full'] as const;
export const STALE_MS = 90_000;
const NO_DEVICE = 'none of your computers has this workspace set up and running: use "Set up on your computer" and keep Murmur open';

type User = { id: string; name: string };
type Step = { text: string; status: string; paths: string[] };

export function laneCore(h: Hub, dep: { plan: (sessionId: string) => Step[]; humanTurn: (laneId: string) => void }) {
  const { get, all, run, emit, send } = h;
  const lane = (id: unknown): Lane => (isId(id) && get(`${LANE_SQL} WHERE l.id=?`, id)) || fail(404, 'no such lane');
  const view = (L: Lane) => { const { ws, title, branch, base_commit, session_status, handoff_brief, integrate_pending, ...r } = L; return camel(r); };
  const lanesOf = (sessionId: string) => all(`${LANE_SQL} WHERE l.session_id=? ORDER BY l.created_at`, sessionId).map(view);
  const session = (id: string) => get('SELECT * FROM session WHERE id=?', id);
  const lastSeen = new Map<string, number>(), startedAt = h.now();
  const integrating = new Set<string>(); // lane.integrate sent by this process; a restart empties it so hello resends

  // The only publisher of lane.status: one payload shape for every transition.
  const publish = (id: string, over: object = {}) => {
    const L = lane(id);
    emit(L.ws, 'lane.status', { laneId: L.id, status: L.status, reason: L.status_reason, mode: L.mode, ownerUserId: L.owner_user_id, ...over }, L.session_id, L.id);
    return L;
  };
  const setStatus = (L: Lane, status: LaneStatus, reason: string | null = null) => {
    run('UPDATE lane SET status=?, status_reason=? WHERE id=?', status, reason, L.id);
    return publish(L.id);
  };
  const own = (deviceId: string, laneId: unknown) => { const L = lane(laneId); if (L.device_id !== deviceId) fail(403, 'lane is not on this device'); return L; };

  const modeFor = (role: string | undefined, m: unknown): LaneMode => {
    const mode = m == null || m === '' ? 'request' : oneOf(m, MODES, 'mode');
    if (mode === 'full' && role !== 'owner') fail(403, 'full mode needs a workspace owner');
    return mode;
  };
  const baseRef = (v: unknown) => { const b = optStr(v, 200, 'base'); if (b && !/^[A-Za-z0-9._/@^~-]+$/.test(b) || b?.startsWith('-')) fail(400, 'bad base ref'); return b; };
  // A bound node that is (re)connecting gets 5 s to show up.
  async function pickDevice(userId: string, wsId: string, deviceId?: unknown) {
    const ids = all('SELECT d.id FROM device d JOIN binding b ON b.device_id=d.id WHERE d.user_id=? AND b.workspace_id=? AND d.revoked_at IS NULL', userId, wsId)
      .map(r => r.id as string).filter(id => deviceId == null || id === deviceId);
    for (let end = Date.now() + 5000; ids.length; await new Promise(r => setTimeout(r, 100))) {
      const id = ids.find(i => h.online.has(i));
      if (id || Date.now() > end) return id ?? fail(409, NO_DEVICE);
    }
    return fail(409, NO_DEVICE);
  }
  function newLane(s: any, userId: string, deviceId: string, mode: LaneMode) {
    const id = newId();
    run('INSERT INTO lane (id, session_id, owner_user_id, device_id, mode, created_at) VALUES (?,?,?,?,?,?)', id, s.id, userId, deviceId, mode, h.now());
    const L = lane(id);
    emit(s.workspace_id, 'lane.created', view(L), s.id, id);
    return L;
  }
  function start(L: Lane, extra: object = {}) {
    const steps = dep.plan(L.session_id);
    send(L.device_id, 'lane.start', {
      laneId: L.id, sessionId: L.session_id, workspaceId: L.ws, title: L.title, branch: L.branch, base: L.base_commit ?? undefined, mode: L.mode,
      failMode: JSON.parse(get('SELECT fail_mode_json f FROM workspace WHERE id=?', L.ws).f),
      plan: steps.length ? steps.map(s => ({ text: s.text, status: s.status, paths: s.paths })) : undefined, ...extra,
    });
  }

  // ---- human actions ----
  async function open(wsId: string, u: User, role: string | undefined, b: any) {
    const title = sanitize(str(b.title, 200, 'title'), 200), base = baseRef(b.base), mode = modeFor(role, b.mode);
    const dev = await pickDevice(u.id, wsId, b.deviceId);
    const sid = newId();
    const L = tx(h.db, () => {
      run('INSERT INTO session (id, workspace_id, title, base_commit, branch, created_by, created_at) VALUES (?,?,?,?,?,?,?)', sid, wsId, title, base, `murmur/${sid}`, u.id, h.now());
      emit(wsId, 'session.created', camel(session(sid)), sid);
      return newLane(session(sid), u.id, dev, mode);
    });
    start(L);
    return { session: camel(session(sid)), lane: view(L) };
  }
  async function join(s: any, u: User, role: string | undefined, b: any) {
    if (s.status !== 'active') fail(409, 'session is not active');
    const mode = modeFor(role, b.mode);
    const L = newLane(s, u.id, await pickDevice(u.id, s.workspace_id, b.deviceId), mode);
    start(L);
    return { lane: view(L) };
  }
  function finish(s: any, u: User, role: string | undefined) {
    if (s.created_by !== u.id && role !== 'owner') fail(403, 'only the session or workspace owner can finish');
    tx(h.db, () => {
      if (!run(`UPDATE session SET status='finished', version=version+1 WHERE id=? AND status='active'`, s.id).changes) fail(409, 'session is not active');
      run('UPDATE lane SET integrate_pending=1 WHERE session_id=?', s.id);
    });
    integrateNext(s.id);
    emit(s.workspace_id, 'session.updated', camel(session(s.id)), s.id);
    return { session: camel(session(s.id)) };
  }
  // One lane at a time, in creation order; the queue is the integrate_pending column, so it survives a restart.
  function integrateNext(sid: string) {
    for (let L: Lane; (L = get(`${LANE_SQL} WHERE l.session_id=? AND l.integrate_pending=1 ORDER BY l.created_at LIMIT 1`, sid));) {
      if (send(L.device_id, 'lane.integrate', { laneId: L.id, sessionId: sid, branch: L.branch })) return void integrating.add(L.id);
      run('UPDATE lane SET integrate_pending=0 WHERE id=?', L.id); // offline: skipped
    }
  }
  function prompt(L: Lane, u: User, text: unknown) {
    const t = str(text, 100_000, 'text');
    if (!send(L.device_id, 'lane.prompt', { laneId: L.id, text: t, from: u.name })) fail(409, 'node offline');
    dep.humanTurn(L.id);
    return { ok: true };
  }
  function signal(L: Lane, t: 'interrupt' | 'stop') {
    if (!send(L.device_id, `lane.${t}`, { laneId: L.id })) fail(409, 'node offline');
    return { ok: true };
  }
  function setMode(L: Lane, role: string | undefined, m: unknown) {
    const mode = modeFor(role, m);
    run('UPDATE lane SET mode=?, version=version+1 WHERE id=?', mode, L.id);
    send(L.device_id, 'lane.setMode', { laneId: L.id, mode });
    return { lane: view(publish(L.id)) };
  }
  function handoffBrief(L: Lane, reason: string, recent: string) {
    const steps = dep.plan(L.session_id), i = steps.findIndex(s => s.status !== 'done');
    const body = [`Lane ${L.id} of session "${L.title}" (branch ${L.branch}), previously run by ${L.owner_name}. Reason: ${reason}`,
      steps.length ? 'Plan:\n' + steps.map((s, n) => `${n + 1}. [${s.status}] ${s.text}`).join('\n') : 'No plan was published.',
      recent ? 'Recent activity:\n' + recent : ''].filter(Boolean).join('\n\n');
    const at = steps.length ? `Resuming at step ${i < 0 ? steps.length : i + 1} of ${steps.length}.` : 'Resuming without a published plan.';
    return `Murmur handoff: you are taking over this lane. ${at} Check team_status, then continue the work below. Side-effecting actions in flight when the lane stopped (push, deploy) have OUTCOME UNKNOWN: verify, never blindly retry.\n`
      + untrusted('murmur-handoff', body);
  }
  function handOff(L: Lane, reason: unknown, recent: unknown) {
    const why = sanitize(reason ?? 'handoff', 300), brief = handoffBrief(L, why, typeof recent === 'string' ? sanitize(recent, 4000) : '');
    run(`UPDATE lane SET handoff_brief=?, status='awaiting_takeover', status_reason=? WHERE id=?`, brief, why, L.id);
    publish(L.id);
    return { status: 'awaiting_takeover', brief };
  }
  // CAS on (version, expected owner): of two racing takeovers exactly one wins; the loser gets 409 with the current owner.
  async function takeover(L0: Lane, u: User, b: any) {
    const version = int(b.version, 'version'), expected = str(b.expectedOwner, 64, 'expectedOwner');
    const dev = await pickDevice(u.id, L0.ws, b.deviceId);
    const L = lane(L0.id);
    const brief = L.handoff_brief ?? handoffBrief(L, `taken over from ${L.status} lane`, '');
    tx(h.db, () => {
      const ok = run(`UPDATE lane SET owner_user_id=?, device_id=?, status='starting', status_reason=NULL, handoff_brief=?, version=version+1 WHERE id=? AND version=? AND owner_user_id=?
        AND (status IN ('awaiting_takeover','stale','blocked','stopped') OR owner_user_id=?)`,
        u.id, dev, brief, L.id, version, expected, u.id).changes;
      if (!ok) { const cur = lane(L.id); fail(409, 'lane was already taken over or changed', { owner: cur.owner_user_id, ownerName: cur.owner_name, version: cur.version }); }
    });
    send(L.device_id, 'lane.revoke', { laneId: L.id, reason: `taken over by ${u.name}` });
    const N = lane(L.id);
    start(N, { fromRef: L.snapshot_ref ?? undefined, resumeBrief: brief, claudeSessionId: L.owner_user_id === u.id ? L.claude_session_id ?? undefined : undefined });
    publish(L.id, { reason: `taken over by ${u.name}` });
    return { lane: view(N) };
  }

  // ---- node reports ----
  const seen = (deviceId: string) => void lastSeen.set(deviceId, h.now());
  function hello(deviceId: string, lanes: unknown) {
    for (const x of Array.isArray(lanes) ? lanes.slice(0, 1000) : []) {
      if (!isId(x?.laneId)) continue;
      const L: Lane | undefined = get(`${LANE_SQL} WHERE l.id=?`, x.laneId);
      if (!L) continue;
      if (L.device_id !== deviceId) send(deviceId, 'lane.revoke', { laneId: L.id, reason: 'lane moved to another device' });
      else if (LANE_STATUS.includes(x.status) && x.status !== L.status) setStatus(L, x.status);
    }
    // Integrations this process never sent (hub restarted mid-finish) resume when the head lane's node shows up.
    for (const { session_id } of all('SELECT DISTINCT session_id FROM lane WHERE device_id=? AND integrate_pending=1', deviceId)) {
      const head = get('SELECT id, device_id FROM lane WHERE session_id=? AND integrate_pending=1 ORDER BY created_at LIMIT 1', session_id);
      if (head.device_id === deviceId && !integrating.has(head.id)) integrateNext(session_id);
    }
  }
  function report(deviceId: string, d: any) {
    const L = own(deviceId, d.laneId), status = oneOf(d.status, LANE_STATUS, 'status'), reason = d.reason == null ? null : sanitize(d.reason, 300);
    if (status === 'awaiting_takeover' && !L.handoff_brief) run('UPDATE lane SET handoff_brief=? WHERE id=?', handoffBrief(L, reason ?? 'awaiting takeover', ''), L.id);
    setStatus(L, status, reason);
  }
  const claude = (deviceId: string, d: any) => void run('UPDATE lane SET claude_session_id=? WHERE id=?', sanitize(str(d.claudeSessionId, 200, 'claudeSessionId'), 200), own(deviceId, d.laneId).id);
  function integrated(deviceId: string, d: any) {
    const L = own(deviceId, d.laneId);
    emit(L.ws, 'session.updated', { id: L.session_id, laneId: L.id, integrated: !!d.ok, commit: d.commit ?? null, error: d.error == null ? null : sanitize(d.error, 500) }, L.session_id, L.id);
    integrating.delete(L.id);
    if (run('UPDATE lane SET integrate_pending=0 WHERE id=? AND integrate_pending=1', L.id).changes) integrateNext(L.session_id);
  }
  function sweep(t = h.now()) {
    for (const L of all(`${LANE_SQL} WHERE l.status IN ('starting','idle','running','blocked')`))
      if (t - (lastSeen.get(L.device_id) ?? startedAt) > STALE_MS) setStatus(L, 'stale', 'node heartbeat lost');
  }

  return { lane, view, lanesOf, own, open, join, finish, prompt, signal, setMode, handOff, takeover, seen, hello, report, claude, integrated, sweep };
}
