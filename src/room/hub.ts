// Murmur room hub. No accounts: a room is an id plus a secret key carried in the invite link.
// This file is transport only: sockets, the wire handshake, per-IP lockout and debounced saves.
// The room itself (files, merge, feed, presence, @mentions) lives in room.ts. Peers relay; nobody needs GitHub.
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { newId, newToken, sanitize } from '../shared.ts';
import { accept, deny, MAX_FRAME, type Channel, type PeerMsg, type Sock } from './wire.ts';
import { Room, MAX_HOPS, type Member, type Out } from './room.ts';

export { merge3, blockedPath, MAX_FILE, MAX_HOPS, type Ev } from './room.ts';
export const ROOM_HUB_PORT = 7440;
const FAIL_MAX = 10, FAIL_WINDOW = 10 * 60_000;

export async function createRoomHub(o: { dataDir: string; port?: number; host?: string }) {
  const dir = join(o.dataDir, 'rooms');
  mkdirSync(dir, { recursive: true });
  const rooms = new Map<string, Room>();
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try { const r = new Room(JSON.parse(readFileSync(join(dir, f), 'utf8'))); rooms.set(r.id, r); } catch {}
  }
  const timers = new Map<string, NodeJS.Timeout>();
  // ponytail: whole room rewritten as one JSON file (debounced); move to sqlite if rooms get huge.
  const writeRoom = (r: Room) => {
    const tmp = join(dir, `${r.id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
    renameSync(tmp, join(dir, `${r.id}.json`));
  };
  const save = (r: Room) => { clearTimeout(timers.get(r.id)); timers.set(r.id, setTimeout(() => writeRoom(r), 500)); };
  const link = new WeakMap<Member, { ch: Channel<PeerMsg>; ws: Sock }>();
  const deliver = (r: Room, out: Out[]) => {
    for (const { to, except, m } of out) for (const p of to ? [to] : r.peers.values()) if (p !== except) link.get(p)?.ch.send(m);
    if (out.length) save(r);
  };

  const server: Server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset=utf-8><title>Murmur room</title><body style="font:16px system-ui;background:#0b0d12;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0">'
      + '<div style="max-width:30em;text-align:center"><h2>This is a Murmur room link</h2><p>Run <code>npm start</code> in Murmur on your computer, then paste this link into <b>Join a room</b>.</p></div>');
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME });
  // Failed hellos per IP; too many in the window and that IP is refused until it expires.
  // ponytail: in-memory map, cleared wholesale if it grows huge.
  const fails = new Map<string, { n: number; at: number }>();
  wss.on('connection', async (ws, req) => {
    ws.on('error', () => {});
    const ip = req.socket.remoteAddress ?? '';
    const f = fails.get(ip);
    if (f && Date.now() - f.at > FAIL_WINDOW) fails.delete(ip);
    if ((fails.get(ip)?.n ?? 0) >= FAIL_MAX) return deny(ws, 'too many wrong links from your address; try again later');
    let room: Room | undefined, me: Member | undefined;
    ws.on('close', () => { if (room && me) deliver(room, room.leave(me)); });
    const a = await accept(ws, id => rooms.get(id)?.key);
    if (a === 'denied') {
      if (fails.size > 10_000) fails.clear();
      const g = fails.get(ip) ?? { n: 0, at: Date.now() };
      g.n++; fails.set(ip, g);
      return deny(ws, 'room not found or wrong link');
    }
    if (!a || ws.readyState !== 1) return;
    const r = room = rooms.get(a.roomId)!;
    const old = r.peers.get(a.hello.peerId);
    if (old) link.get(old)?.ws.close(); // same computer reconnecting: drop its old socket
    const [p, out] = r.join(a.hello);
    me = p; link.set(p, { ch: a.ch, ws });
    deliver(r, out);
    a.ch.on(m => deliver(r, r.receive(p, m)));
  });
  await new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(o.port ?? ROOM_HUB_PORT, o.host ?? '0.0.0.0', () => ok()); });

  return {
    port: (server.address() as any).port as number,
    createRoom(name: string, maxHops: number | null = MAX_HOPS) {
      const r = new Room({ id: newId(), name: sanitize(name, 60) || 'room', key: newToken(), maxHops });
      rooms.set(r.id, r); save(r);
      return { id: r.id, key: r.key };
    },
    setMaxHops(roomId: string, n: number | null) {
      const r = rooms.get(roomId);
      if (!r) throw new Error('room not found');
      deliver(r, r.setMaxHops(n));
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      for (const [id, t] of timers) { clearTimeout(t); const r = rooms.get(id); if (r) writeRoom(r); }
      wss.close();
      await new Promise(r => server.close(() => r(null)));
    },
  };
}
