// One room's domain, no sockets: live files (3-way merge when two people edit the same file at once), the shared
// feed where humans and agents talk, and who is here. Every method returns addressed messages for the hub to deliver.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { newId, sha256, sanitize, safeRelPath, denied } from '../shared.ts';
import { okHops, type Ev, type AgentInfo, type Hello, type HubMsg, type PeerMsg } from './wire.ts';

export type { Ev } from './wire.ts';
export const MAX_FILE = 2 << 20, MAX_HOPS = 4; // MAX_HOPS: default agent reply limit for new rooms
const COLORS = ['#7c9cff', '#ff7ab6', '#5fd3a5', '#ffb454', '#b48cff', '#4fd1e8', '#ff8a65', '#c6e05a'];
const FEED_KEEP = 1000, RECENT_KEEP = 4000, MAX_FILES = 20000, POSTS_PER_10S = 120;

export type FileRec = { b64: string; hash: string; by: string; at: number };
export type Member = Hello & { id: string; color: string; agents: AgentInfo[]; win: number; posts: number };
// to: only that member; otherwise everyone in the room except `except`.
export type Out = { to?: Member; except?: Member; m: HubMsg };

// Never synced: git internals, Murmur state, secrets, and agent CLI config (a friend could otherwise plant hooks,
// MCP servers or permission rules that run commands on your computer the next time your agent starts).
// Case-folded and trailing dots/spaces dropped: on macOS/Windows ".GIT" or ".git." is the same folder as ".git".
// ponytail: denylist of known CLIs; add new agent CLIs' config names here.
const BLOCKED = new Set(['.git', 'git~1', '.murmur', '.claude', '.codex', '.gemini', '.opencode', '.mcp.json', 'opencode.json', 'opencode.jsonc', '.aider.conf.yml']);
export const blockedPath = (p: string) => {
  const parts = p.split('/').map(x => x.toLowerCase().replace(/[. ]+$/, ''));
  return parts.some(x => BLOCKED.has(x) || x.includes(':')) || denied(parts.join('/'));
};

// Three-way merge text with git; null for binary or when git fails. Conflicts come back with markers.
export function merge3(cur: Buffer, base: Buffer, inc: Buffer): { out: Buffer; clean: boolean } | null {
  if ([cur, base, inc].some(b => b.includes(0))) return null;
  const d = mkdtempSync(join(tmpdir(), 'murmur-merge-'));
  try {
    const f = [cur, base, inc].map((b, i) => { const p = join(d, String(i)); writeFileSync(p, b); return p; });
    // ponytail: sync call blocks the hub for up to 3 s on a pathological merge; go async if that ever bites.
    const opt = { timeout: 3000, maxBuffer: 4 * MAX_FILE, stdio: 'pipe' as const };
    let res: { out: Buffer; clean: boolean } | null;
    try { res = { out: execFileSync('git', ['merge-file', '-p', '-L', 'theirs', '-L', 'base', '-L', 'yours', ...f], opt), clean: true }; }
    catch (e: any) { res = e.status > 0 && e.status < 128 && e.stdout ? { out: e.stdout, clean: false } : null; }
    return res && res.out.length <= MAX_FILE ? res : null;
  } finally { rmSync(d, { recursive: true, force: true }); }
}

export class Room {
  peers = new Map<string, Member>();
  recent: Map<string, string>; // hash -> b64 of recent versions, the merge bases
  private out: Out[] = [];
  id: string; name: string; key: string; files: Record<string, FileRec>; feed: Ev[];
  maxHops: number | null; // agent-to-agent replies before a pause; null = unlimited. Only the host changes it.
  constructor(r: { id: string; name: string; key: string; files?: Record<string, FileRec>; feed?: Ev[]; maxHops?: number | null }) {
    this.id = r.id; this.name = r.name; this.key = r.key; this.files = r.files ?? {}; this.feed = r.feed ?? [];
    this.maxHops = okHops(r.maxHops) === undefined ? MAX_HOPS : r.maxHops!;
    this.recent = new Map(Object.values(this.files).map(x => [x.hash, x.b64]));
  }
  toJSON() { return { id: this.id, name: this.name, key: this.key, maxHops: this.maxHops, files: this.files, feed: this.feed.slice(-500) }; }

  setMaxHops(n: number | null): Out[] {
    if (okHops(n) === undefined) throw new Error('agent reply limit must be a whole number from 0 to 1000, or unlimited');
    this.maxHops = n;
    this.presence();
    this.post({ kind: 'note', from: 'murmur', fromKind: 'system', text: `Agent reply limit set to ${n ?? 'unlimited'} by the host.` });
    return this.flush();
  }

  // A peer with the same id (same computer, reconnecting) replaces the old one; the hub closes the old socket.
  join(h: Hello): [Member, Out[]] {
    const taken = new Set([...this.peers.values()].map(x => x.color));
    const p: Member = { ...h, id: h.peerId, color: COLORS.find(c => !taken.has(c)) ?? COLORS[this.peers.size % COLORS.length], agents: [], win: 0, posts: 0 };
    this.peers.set(p.id, p);
    const to = (m: HubMsg) => this.out.push({ to: p, m });
    to({ t: 'welcome', room: { id: this.id, name: this.name }, color: p.color });
    for (const [path, f] of Object.entries(this.files)) to({ t: 'file', path, hash: f.hash, b64: f.b64, by: f.by, snapshot: true });
    to({ t: 'synced', paths: Object.keys(this.files) });
    to({ t: 'history', feed: this.feed.slice(-300) });
    this.presence();
    this.post({ kind: 'note', from: 'murmur', fromKind: 'system', text: `${p.name} joined` });
    return [p, this.flush()];
  }
  leave(p: Member): Out[] {
    if (this.peers.get(p.id) !== p) return [];
    this.peers.delete(p.id);
    this.presence();
    this.post({ kind: 'note', from: 'murmur', fromKind: 'system', text: `${p.name} left` });
    return this.flush();
  }
  receive(p: Member, m: PeerMsg): Out[] {
    // Files skip the post cap on purpose: a (re)connect pushes a whole folder at once, and a capped file would be
    // dropped silently while the sender already counts it as synced. Files are bounded by MAX_FILE/MAX_FILES instead.
    // ponytail: a key holder can still spam stale-base edits, each a sync git merge (<=3 s); rate-limit merges if abused.
    if (m.t === 'file') { this.file(p, m); return this.flush(); }
    const now = Date.now();
    if (now - p.win > 10_000) { p.win = now; p.posts = 0; }
    if (++p.posts > POSTS_PER_10S) return []; // chat/agent spam cap
    if (m.t === 'agents') { p.agents = m.list; this.presence(); }
    else {
      const a = m.agentId ? p.agents.find(x => x.id === m.agentId) : undefined;
      if (m.agentId && !a) return [];
      const kind = a ? (['agent', 'tool', 'error'].includes(m.kind!) ? m.kind as Ev['kind'] : 'agent') : 'chat';
      this.post({ kind, from: a ? a.name : p.name, fromKind: a ? 'agent' : 'human', color: p.color, agentId: a?.id, text: m.text, hops: a ? m.hops : 0 });
    }
    return this.flush();
  }

  private flush() { const o = this.out; this.out = []; return o; }
  private all(m: HubMsg, except?: Member) { this.out.push({ m, except }); }
  private agentsOf() { return [...this.peers.values()].flatMap(p => p.agents.map(a => ({ ...a, owner: p.name, peerId: p.id, color: p.color }))); }
  private presence() { this.all({ t: 'presence', peers: [...this.peers.values()].map(p => ({ id: p.id, name: p.name, color: p.color, folder: p.folder, os: p.os })), agents: this.agentsOf(), maxHops: this.maxHops }); }
  private remember(hash: string, b64: string) {
    this.recent.delete(hash); this.recent.set(hash, b64);
    if (this.recent.size > RECENT_KEEP) this.recent.delete(this.recent.keys().next().value!);
  }

  private post(e: Omit<Ev, 'id' | 'at'>): void {
    const ev: Ev = { ...e, id: newId(), at: Date.now(), text: sanitize(e.text, 8000) };
    // @Name or @all wakes those agents on their owner's computer; agent-to-agent chains stop after maxHops.
    const names = [...ev.text.matchAll(/@([A-Za-z0-9_-]+)/g)].map(m => m[1].toLowerCase());
    if ((ev.kind === 'chat' || ev.kind === 'agent') && names.length) {
      const hops = ev.fromKind === 'agent' ? (ev.hops ?? 0) + 1 : 0;
      const targets = this.agentsOf().filter(a => a.id !== ev.agentId && (names.includes('all') || names.includes(a.name.toLowerCase())));
      if (targets.length) ev.to = targets.map(a => a.name);
      if (targets.length && this.maxHops !== null && hops > this.maxHops) {
        this.feed.push(ev); this.all({ t: 'feed', ev });
        return this.post({ kind: 'note', from: 'murmur', fromKind: 'system', text: `Paused the agent back-and-forth after ${this.maxHops} replies. Mention an agent to continue.` });
      }
      for (const a of targets) { const p = this.peers.get(a.peerId); if (p) this.out.push({ to: p, m: { t: 'wake', agentId: a.id, from: ev.from, text: ev.text, hops } }); }
    }
    this.feed.push(ev);
    if (this.feed.length > FEED_KEEP) this.feed.splice(0, this.feed.length - FEED_KEEP);
    this.all({ t: 'feed', ev });
  }

  private file(p: Member, m: Extract<PeerMsg, { t: 'file' }>) {
    const path = safeRelPath(m.path);
    if (!path || blockedPath(path)) return;
    const cur = this.files[path];
    if (m.deleted) {
      if (!cur) return;
      delete this.files[path];
      return this.all({ t: 'file', path, deleted: true, by: p.name, color: p.color }, p);
    }
    let buf = Buffer.from(m.b64 ?? '', 'base64');
    if (buf.length > MAX_FILE || (!cur && Object.keys(this.files).length >= MAX_FILES)) return;
    let merged = false;
    if (cur && m.base !== cur.hash && cur.hash !== sha256(buf)) {
      // Someone else changed this file since the sender last saw it: merge both edits.
      // No base means both sides created the file independently: merge against an empty file.
      const base = typeof m.base === 'string' ? this.recent.get(m.base) : '';
      const res = base === undefined ? null : merge3(Buffer.from(cur.b64, 'base64'), Buffer.from(base, 'base64'), buf);
      if (res) { buf = res.out; merged = true; }
      this.post({ kind: 'note', from: 'murmur', fromKind: 'system', text: !res ? `${p.name} and ${cur.by} both edited ${path}; kept ${p.name}'s version.`
        : res.clean ? `Merged simultaneous edits to ${path} (${cur.by} + ${p.name}).` : `Conflict in ${path} between ${cur.by} and ${p.name}: conflict markers added, please fix.` });
    }
    const b64 = buf.toString('base64'), hash = sha256(buf);
    const by = p.agents.find(a => a.name === m.agent)?.name ?? p.name; // credit the agent that made the edit
    this.files[path] = { b64, hash, by, at: Date.now() };
    this.remember(hash, b64);
    this.all({ t: 'file', path, hash, b64, by, color: p.color }, merged ? undefined : p);
  }
}
