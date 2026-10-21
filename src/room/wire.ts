// Encrypted hub<->peer wire. The room key (from the invite link) is never sent: both ends derive a per-connection
// session key from it plus two fresh nonces, and every frame after the plaintext challenge/hello is AES-256-GCM.
// The IV is a per-direction counter the receiver expects exactly, so replayed, reordered or tampered frames fail to open.
//
// Handshake (bytes unchanged since v1):
//   hub  -> peer  text   {t:'challenge', nonce}
//   peer -> hub   text   {t:'hello', roomId, nonce, box: base64(sealed {peerId, name, folder, os})}
//   hub  -> peer  text   {t:'denied', error}               wrong room/key, or locked out; then close
//   hub  -> peer  binary sealed {t:'welcome', ...}          must be the first sealed frame; then the catalog below
// accept()/connect() run it over any ws-like socket and hand back a Channel of validated catalog messages.
import { hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { sanitize, isId } from '../shared.ts';

export const MAX_FRAME = 8 << 20; // a 2 MB file is ~2.7 MB as base64 plus envelope
export const HELLO_MS = 10_000;
export const newNonce = () => randomBytes(32).toString('base64');
const nonceBuf = (s: unknown) => { const b = Buffer.from(typeof s === 'string' ? s : '', 'base64'); if (b.length !== 32) throw new Error('bad nonce'); return b; };

export type Session = { seal(m: unknown): Buffer; open(b: Buffer): any };

// hub: true on the hub's side. Direction byte 1 = hub->peer, 0 = peer->hub.
export function session(roomKey: string, serverNonce: string, clientNonce: string, hub: boolean): Session {
  const key = Buffer.from(hkdfSync('sha256', roomKey, Buffer.concat([nonceBuf(serverNonce), nonceBuf(clientNonce)]), 'murmur-room-v1', 32));
  let sent = 0n, got = 0n;
  const iv = (dir: number, n: bigint) => { const b = Buffer.alloc(12); b[0] = dir; b.writeBigUInt64BE(n, 4); return b; };
  return {
    seal(m) {
      const c = createCipheriv('aes-256-gcm', key, iv(hub ? 1 : 0, sent++));
      return Buffer.concat([c.update(JSON.stringify(m)), c.final(), c.getAuthTag()]);
    },
    // Throws on any failure; callers drop the connection.
    open(b) {
      if (b.length < 16) throw new Error('short frame');
      const d = createDecipheriv('aes-256-gcm', key, iv(hub ? 0 : 1, got));
      d.setAuthTag(b.subarray(-16));
      const pt = Buffer.concat([d.update(b.subarray(0, -16)), d.final()]);
      got++;
      return JSON.parse(String(pt));
    },
  };
}

// ---------------- message catalog ----------------
export type Ev = { id: string; at: number; kind: 'chat' | 'agent' | 'tool' | 'note' | 'error'; from: string; fromKind: 'human' | 'agent' | 'system';
  color?: string; agentId?: string; to?: string[]; text: string; hops?: number };
export type AgentInfo = { id: string; name: string; cli: string; model?: string; effort?: string; status: string; doing?: string; claims?: string[] };
export type Hello = { peerId: string; name: string; folder: string; os: string };

// peer -> hub
export type PeerMsg =
  | { t: 'file'; path: string; deleted?: boolean; b64?: string; hash?: string; base?: string; agent?: string }
  | { t: 'agents'; list: AgentInfo[] }
  | { t: 'say' | 'feed'; text: string; agentId?: string; kind?: string; hops?: number };
// hub -> peer (challenge/denied travel in clear, see above)
export type HubMsg =
  | { t: 'welcome'; room: { id: string; name: string }; color: string }
  | { t: 'file'; path: string; hash?: string; b64?: string; by?: string; color?: string; deleted?: boolean; snapshot?: boolean }
  | { t: 'synced'; paths?: string[] }
  | { t: 'history'; feed: Ev[] }
  | { t: 'feed'; ev: Ev }
  | { t: 'presence'; peers: any[]; agents: any[]; maxHops?: number | null }
  | { t: 'wake'; agentId: string; from: string; text: string; hops: number };
// peer -> its local UI (web/app.js)
export type UiMsg =
  | { t: 'state'; [k: string]: unknown }
  | { t: 'feed'; ev: Ev }
  | { t: 'presence'; peers: any[]; agents: any[]; maxHops?: number | null }
  | { t: 'files'; paths: string[] }
  | { t: 'file'; path: string; by?: string; color?: string; deleted?: boolean };

// Agent names are @mention targets: letters, numbers, - and _ only.
export const agentName = (s: unknown) => sanitize(s, 32).replace(/[^A-Za-z0-9_-]/g, '');
const obj = (m: any) => m !== null && typeof m === 'object' && !Array.isArray(m);

// Validators: a clean message, or null to drop it. Lenient coercion where the old handlers coerced.
export function hello(me: any): Hello | null {
  if (!obj(me) || !isId(me.peerId)) return null;
  return { peerId: me.peerId, name: sanitize(me.name, 32).replace(/\s+/g, ' ').trim() || 'guest', folder: sanitize(me.folder, 400),
    os: ['darwin', 'win32', 'linux'].includes(me.os) ? me.os : '' };
}
export function peerMsg(m: any): PeerMsg | null {
  if (!obj(m)) return null;
  if (m.t === 'file') return typeof m.path !== 'string' ? null : { t: 'file', path: m.path, deleted: !!m.deleted || undefined, b64: String(m.b64 ?? ''),
    base: typeof m.base === 'string' ? m.base : undefined, agent: typeof m.agent === 'string' ? m.agent : undefined };
  if (m.t === 'agents') return !Array.isArray(m.list) ? null : { t: 'agents', list: m.list.slice(0, 20).filter((a: any) => isId(a?.id)).map((a: any) => ({
    id: a.id, name: agentName(a.name) || 'agent', cli: sanitize(a.cli, 20), model: sanitize(a.model, 80) || undefined, effort: sanitize(a.effort, 12) || undefined,
    status: sanitize(a.status, 20), doing: sanitize(a.doing, 200), claims: (Array.isArray(a.claims) ? a.claims : []).slice(0, 30).map((c: unknown) => sanitize(c, 200)) })) };
  if (m.t === 'say' || m.t === 'feed') return { t: m.t, text: String(m.text ?? ''), agentId: m.agentId ? String(m.agentId) : undefined,
    kind: typeof m.kind === 'string' ? m.kind : undefined, hops: Number(m.hops) || 0 };
  return null;
}
// Agent reply limit: a whole number 0..1000, or null for unlimited. undefined = invalid.
export const okHops = (v: unknown): number | null | undefined => v === null ? null : Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1000 ? v as number : undefined;

export function hubMsg(m: any): HubMsg | null {
  if (!obj(m)) return null;
  switch (m.t) {
    case 'welcome': return { t: 'welcome', room: { id: String(m.room?.id ?? ''), name: sanitize(m.room?.name, 60) }, color: sanitize(m.color, 20) };
    case 'file': return typeof m.path === 'string' && (m.deleted || (typeof m.b64 === 'string' && typeof m.hash === 'string')) ? m : null;
    case 'synced': return m;
    case 'history': return Array.isArray(m.feed) ? m : null;
    case 'feed': return obj(m.ev) ? m : null;
    case 'presence': return Array.isArray(m.peers) && Array.isArray(m.agents) ? { ...m, maxHops: okHops(m.maxHops) } : null;
    case 'wake': return { t: 'wake', agentId: String(m.agentId), from: sanitize(m.from, 40), text: sanitize(m.text, 8000), hops: Number(m.hops) || 0 };
  }
  return null;
}

// ---------------- handshake + channel ----------------
// The slice of a `ws` WebSocket this module uses; memPair() below is the in-memory adapter for tests.
export type Sock = { readyState: number; send(d: string | Buffer): void; close(): void; terminate(): void; on(e: string, f: (...a: any[]) => void): unknown };
export type Channel<M> = { send(m: unknown): void; on(f: (m: M) => void): void };

// After the handshake: sealed binary frames only. Plaintext, undecryptable or replayed frames end the connection;
// well-sealed messages that fail validation are dropped. Messages arriving before on() is set are buffered.
function channel<M>(ws: Sock, s: Session, check: (m: any) => M | null) {
  let fn: ((m: M) => void) | undefined;
  const early: M[] = [];
  const ch: Channel<M> = {
    send(m) { if (ws.readyState === 1) ws.send(s.seal(m)); },
    on(f) { fn = f; for (const m of early.splice(0)) f(m); },
  };
  const recv = (raw: Buffer, bin: boolean) => {
    let m: any;
    try { if (!bin) throw 0; m = s.open(raw); } catch { return void ws.terminate(); }
    const v = check(m);
    if (v) fn ? fn(v) : early.push(v);
  };
  return { ch, recv };
}

export const deny = (ws: Sock, error: string) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'denied', error })); ws.close(); };

// Hub side. 'denied': wrong room or key (caller counts it and calls deny()); null: protocol violation, timeout or close
// (already terminated). Opening the sealed hello proves the peer holds the room key without ever sending it.
export function accept(ws: Sock, keyOf: (roomId: string) => string | undefined, ms = HELLO_MS) {
  return new Promise<{ roomId: string; hello: Hello; ch: Channel<PeerMsg> } | 'denied' | null>(done => {
    const nonce = newNonce();
    let state: 'wait' | 'over' = 'wait', recv: ((raw: Buffer, bin: boolean) => void) | undefined;
    const end = (v: Parameters<typeof done>[0]) => { clearTimeout(late); state = 'over'; done(v); };
    const late = setTimeout(() => { ws.terminate(); end(null); }, ms);
    ws.on('close', () => end(null));
    ws.on('message', (raw: Buffer, bin: boolean) => {
      if (recv) return recv(raw, bin);
      if (state === 'over' || bin) { ws.terminate(); return end(null); } // one hello only
      let m: any, me: Hello | null = null, s: Session | undefined;
      try { m = JSON.parse(String(raw)); } catch { ws.terminate(); return end(null); }
      const key = m?.t === 'hello' && isId(m.roomId) ? keyOf(m.roomId) : undefined;
      try { s = session(key!, nonce, m.nonce, true); me = hello(s.open(Buffer.from(String(m.box), 'base64'))); } catch {}
      if (!key || !s || !me) return end('denied');
      const c = channel(ws, s, peerMsg);
      recv = c.recv;
      end({ roomId: m.roomId, hello: me, ch: c.ch });
    });
    ws.send(JSON.stringify({ t: 'challenge', nonce }));
  });
}

// Peer side. Resolves with the hub's welcome, { denied } (caller closes), or null (terminated or closed).
export function connect(ws: Sock, roomId: string, key: string, me: Omit<Hello, 'os'> & { os?: string }) {
  return new Promise<{ welcome: Extract<HubMsg, { t: 'welcome' }>; ch: Channel<HubMsg> } | { denied: string } | null>(done => {
    let s: Session | undefined, recv: ((raw: Buffer, bin: boolean) => void) | undefined;
    const kill = () => { ws.terminate(); done(null); };
    ws.on('close', () => done(null));
    ws.on('message', (raw: Buffer, bin: boolean) => {
      if (recv) return recv(raw, bin);
      let m: any;
      try { if (bin && !s) throw 0; m = bin ? s!.open(raw) : JSON.parse(String(raw)); } catch { return kill(); }
      if (!bin) {
        // Only the challenge and a refusal travel in clear. The room key never does: the hello is sealed with a key derived from it.
        if (m?.t === 'challenge' && !s) {
          const nonce = newNonce();
          try { s = session(key, m.nonce, nonce, false); } catch { return kill(); }
          ws.send(JSON.stringify({ t: 'hello', roomId, nonce, box: s.seal(me).toString('base64') }));
        } else if (m?.t === 'denied') done({ denied: sanitize(m.error, 200) || 'denied' });
        else kill();
        return;
      }
      // The hub's first sealed frame must be the welcome: opening it proves the hub holds the room key too.
      const w = m?.t === 'welcome' ? hubMsg(m) : null;
      if (!w || w.t !== 'welcome') return kill();
      const c = channel(ws, s!, hubMsg);
      recv = c.recv;
      done({ welcome: w, ch: c.ch });
    });
  });
}

// In-memory socket pair: what one side sends, the other receives (next tick, binary when it is a Buffer).
export function memPair(): [Sock, Sock] {
  const mk = () => Object.assign(new EventEmitter(), { readyState: 1, ended: false, peer: null as any,
    send(d: string | Buffer) { const p = this.peer; if (this.readyState === 1) setImmediate(() => p.readyState === 1 && p.emit('message', Buffer.isBuffer(d) ? d : Buffer.from(d), Buffer.isBuffer(d))); },
    close() { if (this.readyState !== 1) return; this.readyState = 3; setImmediate(() => { for (const x of [this, this.peer]) if (!x.ended) { x.ended = true; x.readyState = 3; x.emit('close'); } }); },
    terminate() { this.close(); } });
  const a = mk(), b = mk();
  a.peer = b; b.peer = a;
  return [a, b];
}
