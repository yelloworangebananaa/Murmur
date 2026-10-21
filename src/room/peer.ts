// Murmur peer: runs on every computer. Serves the local UI (127.0.0.1 only), keeps a local folder in live
// sync with the room (file by file, so nobody re-downloads the whole project), and runs this computer's agents.
import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { newId, sanitize, isId } from '../shared.ts';
import { createRoomHub, ROOM_HUB_PORT, MAX_HOPS, type Ev } from './hub.ts';
import { PRESETS, runTurn, modelOptions, okModel, okEffort } from './agent.ts';
import { exec } from '../claude.ts';
import { connect as wireConnect, agentName, okHops, MAX_FRAME, type Channel, type HubMsg, type PeerMsg, type UiMsg } from './wire.ts';
import { folderSync, fsDisk, okPath } from './sync.ts';
import { createCrew, type AgentDef } from './crew.ts';

export const ROOM_UI_PORT = 7441;
const WEB = fileURLToPath(new URL('./web/', import.meta.url));
const FX = fileURLToPath(new URL('../hub/web/fx.js', import.meta.url)); // shared WebGL backdrops
const HL = fileURLToPath(import.meta.resolve('@highlightjs/cdn-assets/es/highlight.min.js')); // syntax colors in the code view
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// Prefer a Tailscale address (100.64.0.0/10) so invites work across the internet; else the LAN address.
const tailscale = (a: string) => { const [x, y] = a.split('.').map(Number); return x === 100 && y >= 64 && y < 128; };
const lanIp = () => {
  const v4 = Object.values(networkInterfaces()).flat().filter(i => i?.family === 'IPv4' && !i.internal).map(i => i!.address);
  return v4.find(tailscale) ?? v4[0] ?? '127.0.0.1';
};

// Native "choose folder" dialog per OS. Prints the chosen path; non-zero exit when cancelled.
export function folderDialog(os = process.platform): string[][] {
  if (os === 'darwin') return [['osascript', '-e', 'POSIX path of (choose folder with prompt "Choose a folder for Murmur")']];
  if (os === 'win32') return [['powershell', '-NoProfile', '-STA', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }"]];
  return [['zenity', '--file-selection', '--directory'], ['kdialog', '--getexistingdirectory']];
}
function hopsOf(v: unknown) {
  const n = okHops(v);
  if (n === undefined) throw new Error('agent reply limit must be a whole number from 0 to 1000, or unlimited');
  return n;
}
async function pickFolder() {
  for (const argv of folderDialog()) {
    const r = await exec(argv, 600_000);
    if (r.ok) return { folder: r.out.replace(/(.)[\\/]$/, '$1') };
    if (!/ENOENT/.test(r.out)) return { folder: '' }; // cancelled
  }
  throw new Error('no folder dialog on this computer; type the path');
}

// How to try the project on this computer: guessed from the files in the folder.
export function runSteps(dir: string, os = process.platform): string[] {
  const has = (f: string) => existsSync(join(dir, f));
  if (has('package.json')) {
    let s: Record<string, string> = {};
    try { s = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}; } catch {}
    return ['npm install', ...(s.dev ? ['npm run dev'] : s.start ? ['npm start'] : [])];
  }
  if (has('Cargo.toml')) return ['cargo run'];
  if (has('go.mod')) return ['go run .'];
  const py = os === 'win32' ? 'python' : 'python3', main = ['main.py', 'app.py'].find(has);
  if (has('requirements.txt') || main) return [...(has('requirements.txt') ? [`${py} -m pip install -r requirements.txt`] : []), ...(main ? [`${py} ${main}`] : [])];
  if (has('index.html')) return [`${os === 'darwin' ? 'open' : os === 'win32' ? 'start' : 'xdg-open'} index.html`];
  return [];
}

type Conf = { peerId: string; name?: string; room?: { name?: string; hubUrl: string; roomId: string; key: string; folder: string; hosted?: boolean; invite: string };
  agents: AgentDef[] };

export async function createPeer(o: { home: string; port?: number; hubPort?: number; hubHost?: string; publicHost?: string }) {
  mkdirSync(o.home, { recursive: true });
  const confFile = join(o.home, 'room.json');
  const conf: Conf = existsSync(confFile) ? JSON.parse(readFileSync(confFile, 'utf8')) : { peerId: newId(), agents: [] };
  const saveConf = () => writeFileSync(confFile, JSON.stringify(conf, null, 2), { mode: 0o600 });
  saveConf();

  let hub: Awaited<ReturnType<typeof createRoomHub>> | null = null;
  let ws: WebSocket | null = null, inRoom = false, connected = false, roomName = '', myColor = '', denied = '', closing = false, retry: NodeJS.Timeout | undefined;
  let presence: { peers: any[]; agents: any[]; maxHops?: number | null } = { peers: [], agents: [] };
  let feed: Ev[] = [];
  const ui = new Set<WebSocket>();
  const toUi = (m: UiMsg) => { const s = JSON.stringify(m); for (const c of ui) if (c.readyState === 1) c.send(s); };
  let ch: Channel<HubMsg> | null = null;
  const toHub = (m: PeerMsg) => { if (connected) ch?.send(m); };

  let root = '', disk: ReturnType<typeof fsDisk> | null = null, sync: ReturnType<typeof folderSync> | null = null;
  const crew = createCrew({ turn: runTurn, send: toHub,
    room: () => ({ name: roomName, me: conf.name, peers: presence.peers, agents: presence.agents, feed, cwd: root }) });
  function openFolder(folder: string) {
    disk?.close();
    const d = disk = fsDisk(folder);
    root = d.root;
    const s = sync = folderSync(d, { send: toHub, emit: toUi, who: () => ({ agent: crew.busy(), name: conf.name, color: myColor }) });
    d.watch(paths => { void s.local(paths); });
  }

  // ---------------- hub connection ----------------
  function connect() {
    const R = conf.room;
    if (!R || closing) return;
    clearTimeout(retry);
    const sock = ws = new WebSocket(R.hubUrl.replace(/^http/, 'ws') + '/ws', { maxPayload: MAX_FRAME });
    sock.on('close', () => {
      if (ws !== sock) return;
      connected = false; ch = null; sync?.offline(); sendState();
      if (!closing && !denied && inRoom) retry = setTimeout(connect, 2000);
    });
    sock.on('error', () => {});
    wireConnect(sock, R.roomId, R.key, { peerId: conf.peerId, name: conf.name ?? '', folder: root, os: process.platform }).then(c => {
      if (ws !== sock || !c) return; // left the room meanwhile, or the connection failed (close retries)
      if ('denied' in c) { denied = c.denied; sendState(); return sock.close(); }
      const s = sync!;
      ch = c.ch; roomName = c.welcome.room.name; myColor = c.welcome.color; denied = '';
      if (conf.room && conf.room.name !== roomName) { conf.room.name = roomName; saveConf(); }
      s.welcome();
      c.ch.on(m => {
        if (ws !== sock) return; // late frames from a room we already left
        if (m.t === 'file') s.remote(m);
        else if (m.t === 'synced') { connected = true; s.synced().then(() => { crew.publish(); sendState(); }); }
        else if (m.t === 'history') { feed = m.feed; sendState(); }
        else if (m.t === 'feed') { feed.push(m.ev); if (feed.length > 300) feed.shift(); toUi(m); }
        else if (m.t === 'presence') { presence = { peers: m.peers, agents: m.agents, maxHops: m.maxHops }; toUi({ t: 'presence', ...presence }); }
        else if (m.t === 'wake') crew.wake(m.agentId, { from: m.from, text: m.text, hops: m.hops });
      });
    });
  }
  const state = () => ({ t: 'state', me: { name: conf.name ?? '', color: myColor }, presets: PRESETS, cwd: process.cwd(), os: process.platform,
    last: !inRoom && conf.room ? { name: conf.room.name ?? '', folder: conf.room.folder, hosted: !!conf.room.hosted } : null,
    run: inRoom ? runSteps(root) : [],
    room: inRoom && conf.room ? { name: roomName, invite: conf.room.invite, folder: conf.room.folder, hosted: !!conf.room.hosted, connected, denied, maxHops: presence.maxHops } : null,
    peers: presence.peers, agents: presence.agents, mine: crew.list(), access: Object.fromEntries(conf.agents.map(a => [a.id, !!a.fullAccess])), files: sync?.paths() ?? [], feed });
  const sendState = () => toUi(state());

  async function enter(room: NonNullable<Conf['room']>, name: string) {
    leave();
    conf.name = sanitize(name, 32) || 'guest'; conf.room = room; saveConf();
    openFolder(room.folder);
    inRoom = true;
    crew.load(conf.agents);
    connect();
  }
  function leave() {
    clearTimeout(retry);
    crew.clear();
    const s = ws; ws = null; s?.close();
    disk?.close();
    inRoom = false; connected = false; feed = []; presence = { peers: [], agents: [] }; roomName = ''; denied = ''; ch = null;
  }
  async function ensureHub() {
    hub ??= await createRoomHub({ dataDir: join(o.home, 'hub'), port: o.hubPort ?? ROOM_HUB_PORT, host: o.hubHost ?? '0.0.0.0' });
    return hub;
  }
  const pickModel = (b: any) => {
    if (b.model && !okModel(b.model)) throw new Error('model names use letters, numbers and . _ - : / [ ]');
    if (b.effort && !okEffort(b.effort)) throw new Error('unknown effort level');
    return { ...(b.model ? { model: b.model } : {}), ...(b.effort ? { effort: b.effort } : {}) };
  };
  // The key rides in the #fragment, which browsers never send to a server, so opening the link cannot leak it.
  const inviteFor = (port: number, id: string, key: string) => `http://${o.publicHost ?? process.env.MURMUR_PUBLIC_HOST ?? lanIp()}:${port}/r/${id}#key=${key}`;
  const defaultFolder = (name: string) => join(homedir(), 'Murmur', name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'room');

  // ---------------- local API (this computer only) ----------------
  const api: Record<string, (b: any) => Promise<unknown> | unknown> = {
    async create(b) {
      const name = sanitize(b.name, 32), roomN = sanitize(b.room, 60) || 'my project';
      if (!name) throw new Error('pick a name');
      const folder = String(b.folder ?? '').trim();
      if (!folder) throw new Error('choose a project folder');
      const maxHops = b.maxHops === undefined ? MAX_HOPS : hopsOf(b.maxHops);
      const h = await ensureHub(), { id, key } = h.createRoom(roomN, maxHops);
      await enter({ hubUrl: `http://127.0.0.1:${h.port}`, roomId: id, key, folder: resolve(folder), hosted: true, invite: inviteFor(h.port, id, key) }, name);
    },
    async join(b) {
      let u: URL;
      try { u = new URL(String(b.link).trim()); } catch { throw new Error('that is not an invite link'); }
      const roomId = /^\/r\/([^/]+)$/.exec(u.pathname)?.[1], key = new URLSearchParams(u.hash.slice(1)).get('key') ?? u.searchParams.get('key'); // ?key= from older links
      if (!/^https?:$/.test(u.protocol) || !isId(roomId) || !key || key.length > 200) throw new Error('that is not an invite link');
      if (!sanitize(b.name, 32)) throw new Error('pick a name');
      await enter({ hubUrl: u.origin, roomId, key, folder: resolve(String(b.folder || defaultFolder(roomId))), invite: u.href }, b.name);
    },
    leave() { leave(); conf.room = undefined; conf.agents = []; saveConf(); },
    async rejoin() {
      if (!conf.room) throw new Error('no room to rejoin');
      if (conf.room.hosted) { // re-host; the port or LAN address may have changed
        const port = (await ensureHub()).port;
        Object.assign(conf.room, { hubUrl: `http://127.0.0.1:${port}`, invite: inviteFor(port, conf.room.roomId, conf.room.key) });
      }
      await enter(conf.room, conf.name ?? 'guest');
    },
    say(b) { toHub({ t: 'say', text: sanitize(b.text, 8000) }); },
    addAgent(b) {
      const name = agentName(b.name);
      const cmd = b.cli === 'custom' ? sanitize(b.cmd, 500) : PRESETS[b.cli];
      if (!name || !cmd) throw new Error('agent needs a name (letters, numbers, - or _) and a CLI');
      if (presence.agents.some(a => a.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already an agent called ${name}`);
      const d = { id: newId(), name, cli: b.cli === 'custom' ? 'custom' : b.cli, cmd, ...pickModel(b), fullAccess: b.fullAccess === true };
      conf.agents.push(d); saveConf(); crew.load(conf.agents); crew.publish();
    },
    // Change model/effort, or full access, of one of my agents; takes effect on its next turn.
    async setAgent(b) {
      const d = conf.agents.find(x => x.id === b.id), a = crew.get(b.id);
      if (!d || !a) throw new Error('no such agent');
      if ('fullAccess' in b) {
        if (typeof b.fullAccess !== 'boolean') throw new Error('fullAccess must be true or false');
        d.fullAccess = a.fullAccess = b.fullAccess;
      } else {
        Object.assign(d, { model: undefined, effort: undefined }, pickModel(b));
        a.model = d.model; a.effort = d.effort;
      }
      saveConf(); crew.publish();
    },
    removeAgent(b) { crew.remove(b.id); conf.agents = conf.agents.filter(a => a.id !== b.id); saveConf(); crew.publish(); },
    stopAgent(b) { crew.stop(b.id); },
    pickFolder,
    // Agent reply limit for the room: the hub lives in the host's process, so only the host can change it.
    async setMaxHops(b) {
      if (!conf.room?.hosted || !hub || !inRoom) throw new Error('only the room host can change the agent reply limit');
      hub.setMaxHops(conf.room.roomId, hopsOf(b.maxHops));
    },
  };
  // Local UI only: reject other hosts (DNS rebinding) and cross-site requests (custom header forces a CORS preflight we never answer).
  const localHost = (req: IncomingMessage) => /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '');
  const server = createServer(async (req, res) => {
    const json = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (!localHost(req)) return json(403, { error: 'local only' });
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-murmur'] !== '1') return json(403, { error: 'missing header' });
        const fn = api[url.pathname.slice(5)];
        if (!fn) return json(404, { error: 'no such action' });
        let body = '';
        for await (const c of req) { body += c; if (body.length > 1 << 20) return json(413, { error: 'too big' }); }
        const out = await fn(JSON.parse(body || '{}'));
        sendState();
        return json(200, { ok: true, ...(fn === pickFolder ? out as object : {}) });
      }
      if (url.pathname === '/api/models') return json(200, modelOptions());
      if (url.pathname === '/api/file') {
        const p = okPath(url.searchParams.get('path') ?? '');
        const buf = p && disk ? disk.read(p) : null;
        if (!buf) return json(404, { error: 'not found' });
        return json(200, buf.includes(0) ? { binary: true, size: buf.length } : { text: buf.toString('utf8') });
      }
      const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-z]+\.(html|js|css|svg)$/.test(f)) return json(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES[extname(f)], 'cache-control': 'no-store' });
      res.end(await readFile(f === 'fx.js' ? FX : f === 'hl.js' ? HL : join(WEB, f)));
    } catch (e: any) { json(400, { error: e.message }); }
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (c, req) => {
    if (!localHost(req) || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin ?? '')) return c.close();
    ui.add(c); c.send(JSON.stringify(state()));
    c.on('close', () => ui.delete(c));
    c.on('error', () => {});
  });
  await new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(o.port ?? ROOM_UI_PORT, '127.0.0.1', () => ok()); });

  // No auto-resume: a restart opens the home screen, which offers to rejoin the last room. Auto-entering it
  // showed an old project's chat when you started Murmur for a different one.

  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    api, state, get folder() { return root; },
    async close() {
      closing = true; leave();
      for (const c of ui) c.terminate();
      wss.close(); await new Promise(r => server.close(() => r(null)));
      await hub?.close();
    },
  };
}
