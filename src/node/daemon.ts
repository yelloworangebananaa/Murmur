// murmur node daemon: lane supervisor + loopback API for hooks/MCP/CLI. Hub traffic goes through HubLink,
// permissions through the broker, git through LaneRepo, the claude process through LaneProcess.
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import pkg from '../../package.json' with { type: 'json' };
import { CLAUDE_MODE, PROTOCOL_VERSION, NODE_PORT, newId, newToken, untrusted, sanitize, safeRelPath, isId, normalizeRemote, type Frame, type LaneEvent, type LaneMode, type LaneStatus } from '../shared.ts';
import { claudeBin, claudeInfo } from '../claude.ts';
import { LaneProcess, laneArgs } from './lane.ts';
import { blobSha, git } from './git.ts';
import { openLaneRepo, checkMerge, takePathFrom, type LaneRepo } from './repo.ts';
import { createBroker, hookOutput } from './broker.ts';
import { hubLink, type Dial } from './hublink.ts';
import { readConfig, updateConfig } from './config.ts';

export { murmurHome, readConfig } from './config.ts';
export const VERSION: string = pkg.version;

export type Lane = {
  id: string; sessionId: string; workspaceId?: string; title: string; mode: LaneMode; model?: string; plan?: unknown;
  clone: string; worktree: string; failMode: Record<string, 'open' | 'closed'>;
  proc?: LaneProcess; repo?: LaneRepo; status: LaneStatus; claudeSessionId?: string; revoked: boolean; ending?: Promise<void>;
  events: LaneEvent[]; batch: LaneEvent[]; flush?: NodeJS.Timeout; queue: string[]; digest?: { text: string; at: number }; token?: string;
};

// Where "Set up on this computer" looks for an existing clone (two levels deep) before cloning.
const REPO_DIRS = ['', 'code', 'Code', 'src', 'dev', 'Developer', 'projects', 'Projects', 'repos', 'git', 'GitHub', 'github', 'work', 'Desktop', 'Documents'];
const originOf = (dir: string) => {
  try { return /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(readFileSync(join(dir, '.git', 'config'), 'utf8'))?.[1] ?? null; } catch { return null; }
};
export function findClone(remote: string, roots = REPO_DIRS.map(d => join(homedir(), d))): string | null {
  const want = normalizeRemote(remote);
  const seen = new Set<string>();
  const ls = (d: string) => { try { return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => join(d, e.name)); } catch { return []; } };
  // ponytail: bounded two-level scan of common folders; a folder outside them is linked by typing its path
  for (const root of roots) for (const dir of [root, ...ls(root), ...ls(root).flatMap(ls)]) {
    if (seen.has(dir) || seen.size > 20000) continue;
    seen.add(dir);
    const o = originOf(dir);
    if (o && normalizeRemote(o) === want) return dir;
  }
  return null;
}

export async function createNode(o: { home: string; port?: number; hubUrl?: string; claudeBin?: string[]; repoRoots?: string[]; dial?: Dial }) {
  mkdirSync(join(o.home, 'lanes'), { recursive: true });
  const tokenFile = join(o.home, 'node-token');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, newToken(), { mode: 0o600 });
  const token = readFileSync(tokenFile, 'utf8').trim();
  const boot = newId(); // lets the hub tell a restart (seq starts over) from a reconnect
  const config = readConfig(o.home);
  const hubUrl: string | undefined = (o.hubUrl ?? config.hubUrl)?.replace(/\/$/, '');
  const bin = o.claudeBin ?? claudeBin();
  const lanes = new Map<string, Lane>();
  let url = '', port = 0, claude: unknown;

  const link = hubUrl && config.deviceToken ? hubLink({
    url: hubUrl, token: config.deviceToken, dial: o.dial,
    hello: () => ({ boot, deviceId: config.deviceId, version: VERSION, protocol: PROTOCOL_VERSION, bindings: config.bindings ?? {}, claude, lanes: [...lanes.values()].map(l => ({ laneId: l.id, status: l.status })) }),
    onFrame: f => down(f).catch(e => up('error', { ref: f.id ?? f.t, text: String(e.message) })),
  }) : undefined;
  const up: NonNullable<typeof link>['up'] = (t, d) => link?.up(t, d);
  const hub = async (method: string, path: string, body?: unknown, timeout?: number) => {
    if (!link) throw new Error('no hub connected');
    return link.hub(method, path, body, timeout);
  };
  const broker = createBroker(link && ((path, body, timeout) => link.hub('POST', path, body, timeout)));

  const laneOf = (id: unknown) => { const l = lanes.get(String(id)); if (!l) throw new Error(`unknown lane ${id}`); return l; };
  const cloneFor = (sessionId: string, ...ids: string[]) => {
    const c = ids.map(i => lanes.get(i)?.clone).find(Boolean) ?? [...lanes.values()].find(l => l.sessionId === sessionId)?.clone ?? Object.values(config.bindings ?? {})[0];
    if (!c) throw new Error('no clone for session ' + sessionId);
    return c as string;
  };

  async function down(f: Frame) {
    const d = f.d ?? {};
    switch (f.t) {
      case 'lane.start': await startLane(d); return;
      case 'lane.prompt': prompt(laneOf(d.laneId), String(d.text), d.from); return;
      case 'lane.interrupt': laneOf(d.laneId).proc?.interrupt(); return;
      case 'lane.stop': await stopLane(laneOf(d.laneId)); return;
      case 'lane.revoke': { const l = laneOf(d.laneId); l.revoked = true; l.repo?.revoke(); l.proc?.interrupt(); await stopLane(l); return; }
      case 'lane.setMode': {
        const l = laneOf(d.laneId);
        if (!(d.mode in CLAUDE_MODE)) throw new Error('bad mode');
        l.mode = d.mode;
        const p = l.proc;
        p?.removeAllListeners('event');
        await p?.stop();
        spawnClaude(l, l.claudeSessionId ?? p?.claudeSessionId);
        return;
      }
      case 'approval.decided': broker.decided(d); return;
      case 'message.deliver': {
        deliver(laneOf(d.laneId), d.from, d.body);
        if (isId(d.messageId)) up('message.delivered', { laneId: d.laneId, messageId: d.messageId });
        return;
      }
      case 'workspace.link': await linkWorkspace(d); return;
      case 'merge.check': {
        const clone = cloneFor(d.sessionId, d.laneA, d.laneB);
        up('merge.result', { sessionId: d.sessionId, laneA: d.laneA, laneB: d.laneB, ...await checkMerge(clone, d.refA, d.refB) });
        return;
      }
      case 'conflict.resolve': {
        const path = safeRelPath(d.path);
        if (!path) throw new Error('bad path');
        up('conflict.resolved', { conflictId: d.conflictId, commit: await takePathFrom(cloneFor(d.sessionId), d.branch, path, d.fromRef) });
        return;
      }
      case 'lane.integrate': {
        const l = laneOf(d.laneId);
        try {
          if (!l.repo) throw new Error('lane has no worktree');
          up('lane.integrated', { laneId: l.id, ...await l.repo.integrateInto(d.branch) });
        } catch (e: any) { up('lane.integrated', { laneId: l.id, ok: false, error: e.message }); }
        return;
      }
    }
  }

  // ---- workspace linking ----
  // Use the folder the user named, else an existing clone of the remote, else clone it under ~/.murmur/repos.
  async function linkWorkspace(d: any) {
    try {
      if (!isId(d.workspaceId) || typeof d.remote !== 'string') throw new Error('bad link request');
      let clone: string | null = typeof d.clonePath === 'string' ? resolve(d.clonePath.replace(/^~(?=$|\/)/, homedir())) : null;
      if (clone && !statSync(clone, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`folder not found: ${clone}`);
      clone ??= findClone(d.remote, o.repoRoots);
      if (!clone) {
        clone = join(o.home, 'repos', String(d.name ?? 'repo').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) + '-' + d.workspaceId);
        if (!existsSync(join(clone, '.git'))) {
          mkdirSync(join(o.home, 'repos'), { recursive: true });
          // The remote comes from the workspace owner: no ext:: or other command-running transports.
          await git(o.home, ['clone', '--', d.remote, clone], { GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file' });
        }
      }
      const remote = (await git(clone, ['remote', 'get-url', 'origin'])).out.trim();
      await hub('POST', `/api/workspaces/${d.workspaceId}/bind`, { clonePath: clone, remote });
      config.bindings = updateConfig(o.home, c => ({ ...c, bindings: { ...c.bindings, [d.workspaceId]: clone } })).bindings;
      up('workspace.linked', { workspaceId: d.workspaceId, ok: true });
    } catch (e: any) {
      up('workspace.linked', { workspaceId: d.workspaceId, ok: false, error: sanitize(e.message, 300) });
    }
  }

  // ---- lanes ----
  function onEvent(l: Lane, e: LaneEvent) {
    if (l.revoked) return; // a revoked lane never reports again
    if (e.k === 'lane.status') { l.status = e.status; up('lane.status', { laneId: l.id, status: e.status, reason: e.reason }); }
    l.events.push(e);
    if (l.events.length > 1000) l.events.splice(0, 200);
    l.batch.push(e);
    l.flush ??= setTimeout(() => { l.flush = undefined; up('lane.events', { laneId: l.id, batch: l.batch.splice(0) }); }, 100);
  }

  function spawnClaude(l: Lane, resume?: string, brief?: string) {
    const dir = join(o.home, 'lanes', l.id);
    mkdirSync(dir, { recursive: true });
    // claude gets a lane-scoped token: it can call /hook and /mcp as this lane, never the node's admin routes.
    l.token ??= newToken();
    writeFileSync(join(dir, 'token'), l.token, { mode: 0o600 });
    const env = { MURMUR_LANE: l.id, MURMUR_NODE_URL: url, MURMUR_NODE_TOKEN_FILE: join(dir, 'token') };
    const args = laneArgs(dir, env, { mode: l.mode, resume, brief, model: l.model });
    const childEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^MURMUR_.*TOKEN/.test(k))), ...env };
    const p = l.proc = new LaneProcess(bin, args, l.worktree, childEnv);
    p.on('event', e => onEvent(l, e));
    onEvent(l, { k: 'lane.status', status: p.status });
  }

  async function startLane(d: any): Promise<Lane> {
    if (!isId(d.laneId) || !isId(d.sessionId)) throw new Error('bad lane/session id');
    if (!(d.mode in CLAUDE_MODE)) throw new Error('bad mode');
    const prev = lanes.get(d.laneId);
    if (prev?.proc && !prev.proc.stopping) return prev; // idempotent re-send
    await prev?.ending; // a stop still cleaning up this lane's worktree finishes first
    const clone = d.clonePath ?? config.bindings?.[d.workspaceId];
    const l: Lane = {
      id: d.laneId, sessionId: d.sessionId, workspaceId: d.workspaceId, title: String(d.title ?? ''), mode: d.mode, model: d.model, plan: d.plan,
      clone, worktree: '', failMode: d.failMode ?? {}, status: 'starting', revoked: false, events: [], batch: [], queue: [],
    };
    lanes.set(l.id, l);
    onEvent(l, { k: 'lane.status', status: 'starting' });
    try {
      if (!clone) throw new Error('workspace not bound on this node (murmur bind)');
      l.repo = await openLaneRepo({ clone, laneId: l.id, sessionId: l.sessionId, base: d.base, fromRef: d.fromRef }, {
        diff: files => up('lane.diff', { laneId: l.id, files }),
        snapshot: (ref, commit) => up('lane.snapshot', { laneId: l.id, ref, commit, at: Date.now() }),
        error: text => onEvent(l, { k: 'error', text }),
      });
      l.worktree = l.repo.worktree;
      spawnClaude(l, d.claudeSessionId, d.resumeBrief);
    } catch (e: any) {
      onEvent(l, { k: 'lane.status', status: 'blocked', reason: sanitize(e.message, 300) });
      throw e;
    }
    return l;
  }

  function prompt(l: Lane, text: string, from = 'local') {
    if (!l.proc || l.proc.stopping) throw new Error('lane is not running');
    onEvent(l, { k: 'user.prompt', text, from: String(from) });
    l.proc.send(text);
  }

  // Team messages reach the model only as untrusted data, at a turn boundary.
  function deliver(l: Lane, from: unknown, body: unknown) {
    onEvent(l, { k: 'user.prompt', text: sanitize(body, 4000), from: `message from ${sanitize(from, 60)}` });
    const text = `Message from ${sanitize(from, 200)}:\n` + untrusted('murmur-message', body);
    if (l.proc?.status === 'idle') l.proc.send(text);
    else l.queue.push(text);
  }

  // Final snapshot, stop claude, then drop the worktree if everything in it reached the remote.
  // A revoked lane keeps its files: the new owner continues from the last pushed snapshot.
  function stopLane(l: Lane) {
    return l.ending ??= (async () => {
      await l.repo?.stop(!l.revoked);
      await l.proc?.stop();
      if (!l.revoked && lanes.get(l.id) === l) await l.repo?.dispose().catch(e => onEvent(l, { k: 'error', text: 'cleanup: ' + e.message }));
    })();
  }

  // ---- hooks ----
  async function hook(l: Lane, ev: string, b: any): Promise<{ stdout?: string; exit?: number }> {
    if (ev === 'SessionStart') {
      if (b.session_id) { l.claudeSessionId = String(b.session_id); up('lane.claude', { laneId: l.id, claudeSessionId: l.claudeSessionId }); }
      const ctx = `Murmur lane ${l.id}, session ${JSON.stringify(sanitize(l.title, 200))}, mode ${l.mode}. You work in an isolated git worktree; use the murmur MCP tools to coordinate with teammates.`
        + ' Teammates and their agents work in parallel lanes. Their messages arrive as turns: answer with send_message to their lane.'
        + ' Use team_status to see who is doing what, read_lane and peer_changes to look at another lane\'s work, lease_files before editing shared paths,'
        + ' and send_message to ask another agent for something or hand it a piece of the work.'
        + (l.plan ? '\n' + untrusted('hub', l.plan) : '');
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }) };
    }
    if (ev === 'UserPromptSubmit') {
      if (!link) return {};
      try {
        const j = await hub('GET', `/api/lanes/${l.id}/digest`, undefined, 1500);
        l.digest = { text: String(j.text ?? ''), at: Date.now() };
        return { stdout: l.digest.text };
      } catch {
        return { stdout: l.digest ? `${l.digest.text}\n[team context unavailable, last update ${Math.round((Date.now() - l.digest.at) / 60000)} min ago]` : '[team context unavailable]' };
      }
    }
    if (ev === 'PreToolUse') return hookOutput(await broker.pretool(l, b));
    if (ev === 'PostToolUse') { l.repo?.nudge(); return {}; } // ponytail: lease renewal on touched paths not done; leases expire by TTL
    if (ev === 'Stop') {
      l.repo?.snapshot();
      const q = l.queue.splice(0);
      if (q.length) setImmediate(() => l.proc?.send(q.join('\n\n')));
      return {};
    }
    return {};
  }

  async function mcpTool(l: Lane, tool: string, args: any) {
    args = args && typeof args === 'object' ? args : {};
    if (tool === 'remember') {
      const paths = (Array.isArray(args.paths) ? args.paths : []).map(safeRelPath).filter(Boolean) as string[];
      args = { ...args, refs: await Promise.all(paths.map(async path => ({ path, blobSha: await blobSha(l.worktree, path) }))) };
    }
    if (tool === 'hand_off') {
      await l.repo?.snapshot();
      const recent = l.events.flatMap(e => e.k === 'user.prompt' ? [`USER: ${e.text}`] : e.k === 'assistant.message' ? [`ASSISTANT: ${e.text}`] : e.k === 'tool.start' ? [`TOOL: ${e.name} ${JSON.stringify(e.input).slice(0, 300)}`] : []);
      args = { ...args, recent: recent.join('\n').slice(-4000) };
    }
    if (!link) throw new Error('no hub connected');
    const { result } = await hub('POST', `/api/lanes/${l.id}/tool/${tool}`, { args });
    if (tool === 'recall') {
      const hits = Array.isArray(result) ? result : result?.hits ?? result?.memories ?? [];
      for (const h of hits) for (const ref of h?.refs ?? []) {
        const p = safeRelPath(ref?.path), now = p ? await blobSha(l.worktree, p) : null;
        if (now === null) h.gone = true; else if (now !== ref.blobSha) h.stale = true;
      }
    }
    return result;
  }

  // ---- loopback API ----
  const tokenBuf = Buffer.from(token);
  // Node's own fetch sends sec-fetch-mode, so only that one is tolerated; browsers always add sec-fetch-site/dest.
  const allowed = (req: IncomingMessage) => {
    const t = Buffer.from(String(req.headers['x-murmur-token'] ?? ''));
    const eq = (k: Buffer) => t.length === k.length && timingSafeEqual(t, k);
    const l = lanes.get(String(req.headers['x-murmur-lane'] ?? ''));
    const who = eq(tokenBuf) ? 'node' : l?.token && eq(Buffer.from(l.token)) ? 'lane' : null;
    return who && !req.headers.origin
      && !Object.keys(req.headers).some(k => k.startsWith('sec-fetch-') && k !== 'sec-fetch-mode') && [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host)) ? who : null;
  };
  const readJson = (req: IncomingMessage) => new Promise<any>((res, rej) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 10 << 20) { rej(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new Error('bad json')); } });
  });
  const info = (l: Lane) => ({ id: l.id, sessionId: l.sessionId, status: l.status, worktree: l.worktree, mode: l.mode });

  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const who = allowed(req);
    if (!who) return send(403, { error: 'forbidden' });
    try {
      const [a, b, c] = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean);
      if (who === 'lane' && a !== 'hook' && a !== 'mcp') return send(403, { error: 'forbidden' });
      const m = req.method;
      const body = m === 'POST' ? await readJson(req) : {};
      if (m === 'GET' && a === 'health' && !b) return send(200, { version: VERSION, hub: link?.online() ? 'online' : 'offline', lanes: lanes.size });
      if (m === 'GET' && a === 'lanes' && !b) return send(200, [...lanes.values()].map(info));
      if (m === 'POST' && a === 'lanes' && !b) { // single-machine lane, no hub
        const clonePath = body.clonePath;
        if (typeof clonePath !== 'string' || !isAbsolute(clonePath) || !statSync(clonePath, { throwIfNoEntry: false })?.isDirectory()) return send(400, { error: 'clonePath must be an absolute directory' });
        const mode = body.mode ?? 'request';
        if (!(mode in CLAUDE_MODE)) return send(400, { error: 'bad mode' });
        return send(200, info(await startLane({ laneId: newId(), sessionId: newId(), clonePath, base: body.base, mode, title: body.title ?? 'local', model: body.model })));
      }
      if (m === 'POST' && a === 'lanes' && b && c) {
        const l = lanes.get(b);
        if (!l) return send(404, { error: 'no such lane' });
        if (c === 'prompt') prompt(l, String(body.text ?? ''));
        else if (c === 'interrupt') l.proc?.interrupt();
        else if (c === 'stop') await stopLane(l);
        else return send(404, { error: 'not found' });
        return send(200, info(l));
      }
      const l = lanes.get(String(req.headers['x-murmur-lane'] ?? ''));
      if (m === 'POST' && (a === 'hook' || a === 'mcp') && b) {
        if (!l) return send(404, { error: 'unknown lane' });
        if (a === 'hook') return send(200, await hook(l, b, body));
        if (!isId(b)) return send(400, { error: 'bad tool' });
        try { return send(200, { ok: true, result: await mcpTool(l, b, body.args) }); } catch (e: any) { return send(200, { ok: false, error: e.message }); }
      }
      send(404, { error: 'not found' });
    } catch (e: any) { send(400, { error: e.message }); }
  });
  await new Promise<void>((r, j) => server.once('error', j).listen(o.port ?? NODE_PORT, '127.0.0.1', r));
  port = (server.address() as any).port;
  url = `http://127.0.0.1:${port}`;
  if (link) claudeInfo(bin, 5000).then(c => { claude = c; link.connect(); });

  async function close() {
    link?.close();
    broker.close();
    await Promise.all([...lanes.values()].map(async l => {
      l.repo?.stop(false); clearTimeout(l.flush);
      l.proc?.removeAllListeners('event');
      await l.proc?.stop();
    }));
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }

  return { url, close, lanes, token };
}
