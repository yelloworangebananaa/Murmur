// Live folder sync, this computer's side. Owns `known` (path -> hash both we and the hub agree on; a disk hash that
// differs from it is a local edit) and decides, per path, between what the room has, what is on disk and what we last
// agreed on. Disk access goes through a Disk adapter: fsDisk() for a real folder, memDisk() for tests.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, lstatSync, readdirSync, unlinkSync, renameSync, rmSync, realpathSync, watch } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { newId, sha256, safeRelPath } from '../shared.ts';
import { blockedPath, MAX_FILE } from './room.ts';
import type { HubMsg, PeerMsg, UiMsg } from './wire.ts';

const SKIP = new Set(['.git', '.murmur', 'node_modules', '.DS_Store', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target']);
export const okPath = (p: string) => { const s = safeRelPath(p); return s && !s.split('/').some(x => SKIP.has(x)) && !blockedPath(s) ? s : null; };

export type Disk = {
  read(p: string): Buffer | null; // regular file inside the folder, <= MAX_FILE; else null
  write(p: string, buf: Buffer | null): boolean; // null deletes; false when it cannot be written here
  files(under?: string[]): Promise<string[]>; // syncable files (whole folder, or these paths with folders expanded)
  known(): Map<string, string>;
  saveKnown(k: Map<string, string>): void;
};
type Remote = Map<string, { hash: string; b64: string }>;

export function folderSync(disk: Disk, o: { send(m: Extract<PeerMsg, { t: 'file' }>): void; emit(m: UiMsg): void; who(): { agent?: string; name?: string; color: string } }) {
  const known = disk.known();
  let online = false, snapshot: Remote | null = null;
  const settled = () => { disk.saveKnown(known); o.emit({ t: 'files', paths: [...known.keys()] }); };

  function push(p: string, buf: Buffer | null) {
    if (!online) return; // offline edits stay "unknown" and are pushed by reconcile() on reconnect
    if (buf === null) { if (known.has(p)) { o.send({ t: 'file', path: p, deleted: true }); known.delete(p); settled(); } return; }
    const hash = sha256(buf);
    if (known.get(p) === hash) return;
    const isNew = !known.has(p), w = o.who();
    o.send({ t: 'file', path: p, b64: buf.toString('base64'), hash, base: known.get(p), agent: w.agent });
    known.set(p, hash); disk.saveKnown(known);
    if (isNew) o.emit({ t: 'files', paths: [...known.keys()] });
    o.emit({ t: 'file', path: p, by: w.agent ?? w.name, color: w.color });
  }

  // After (re)connecting: settle every path. Decision table (r = room hash, d = disk hash, k = known hash):
  async function reconcile(remote: Remote) {
    const local = new Set(await disk.files());
    for (const p of new Set([...remote.keys(), ...local, ...known.keys()])) {
      const r = remote.get(p), buf = local.has(p) ? disk.read(p) : null, d = buf && sha256(buf), k = known.get(p);
      if (r && d === r.hash) known.set(p, r.hash); // same everywhere
      else if (r && (k === undefined || d === k)) { disk.write(p, Buffer.from(r.b64, 'base64')); known.set(p, r.hash); } // room changed it, or new to us: take it
      // Edited or deleted here while offline: send it (the hub merges against k).
      // ponytail: an offline delete wins over a teammate's edit made meanwhile (r != k); restore r instead if that bites.
      else if (r) push(p, buf);
      else if (buf && d === k) { disk.write(p, null); known.delete(p); } // room deleted it, untouched here: delete
      else if (buf) { known.delete(p); push(p, buf); } // new here, or edited here after the room deleted it: send
      else known.delete(p);
    }
    settled();
  }

  return {
    paths: () => [...known.keys()],
    // Files (or folders) changed on disk.
    async local(paths: string[]) { for (const p of await disk.files(paths)) push(p, disk.read(p)); },
    // A file message from the hub. Snapshot frames (between welcome and synced) are collected for reconcile().
    remote(m: Extract<HubMsg, { t: 'file' }>) {
      const p = okPath(m.path);
      if (!p) return;
      if (snapshot && m.snapshot) return void snapshot.set(p, { hash: m.hash!, b64: m.b64! });
      const buf = disk.read(p), d = buf && sha256(buf), k = known.get(p);
      if (d && d !== k && d !== m.hash) return push(p, buf); // unsent local edit: send it, the hub merges both
      if (!disk.write(p, m.deleted ? null : Buffer.from(m.b64!, 'base64'))) return;
      if (m.deleted) known.delete(p); else known.set(p, m.hash!);
      settled();
      o.emit({ t: 'file', path: p, by: m.by, color: m.color, deleted: !!m.deleted });
    },
    welcome() { snapshot = new Map(); },
    async synced() { const s = snapshot; if (!s) return; snapshot = null; online = true; await reconcile(s); },
    offline() { online = false; snapshot = null; },
  };
}

// ---------------- adapters ----------------
// A real folder. Watches it and reports changed paths (debounced); keeps `known` in .murmur/known.json.
export function fsDisk(folder: string) {
  const root = resolve(folder);
  mkdirSync(root, { recursive: true });
  const rootReal = realpathSync(root), knownFile = join(root, '.murmur', 'known.json');
  let known = new Map<string, string>(), knownT: NodeJS.Timeout | undefined, flushT: NodeJS.Timeout | undefined, watcher: ReturnType<typeof watch> | null = null;
  try { known = new Map(Object.entries(JSON.parse(readFileSync(knownFile, 'utf8')))); } catch {}
  const writeKnown = () => { clearTimeout(knownT); knownT = undefined; try { mkdirSync(dirname(knownFile), { recursive: true }); writeFileSync(knownFile, JSON.stringify(Object.fromEntries(known))); } catch {} };
  try {
    const ex = join(root, '.git', 'info', 'exclude');
    if (statSync(join(root, '.git')).isDirectory() && !(existsSync(ex) && readFileSync(ex, 'utf8').split('\n').includes('.murmur/'))) { mkdirSync(dirname(ex), { recursive: true }); writeFileSync(ex, (existsSync(ex) ? readFileSync(ex, 'utf8') : '') + '\n.murmur/\n'); }
  } catch {}
  // Drop paths the project's .gitignore excludes (only when the folder is a git repo).
  const unignored = (paths: string[]) => new Promise<string[]>(res => {
    if (!paths.length || !existsSync(join(root, '.git'))) return res(paths);
    const c = execFile('git', ['check-ignore', '--stdin', '-z'], { cwd: root, maxBuffer: 64 << 20 }, (_e, so) => {
      const ign = new Set(String(so ?? '').split('\0').filter(Boolean));
      res(paths.filter(p => !ign.has(p)));
    });
    c.stdin!.on('error', () => {});
    c.stdin!.end(paths.join('\0') + '\0');
  });
  function walk(d = '', out: string[] = []) {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, out); else if (e.isFile() && okPath(p)) out.push(p);
    }
    return out;
  }
  // Never write through a symlink or outside the folder.
  function inside(abs: string) {
    let d = dirname(abs);
    while (!existsSync(d)) d = dirname(d);
    const r = realpathSync(d);
    return (r === rootReal || r.startsWith(rootReal + sep)) && !(existsSync(abs) && lstatSync(abs).isSymbolicLink());
  }
  return {
    root,
    // Regular files under the folder only: a symlinked parent folder must not leak files from elsewhere on disk.
    read(p: string) {
      try { const a = join(root, p), st = lstatSync(a); return st.isFile() && st.size <= MAX_FILE && realpathSync(a).startsWith(rootReal + sep) ? readFileSync(a) : null; } catch { return null; }
    },
    // False when the file cannot be written here (e.g. a name Windows forbids); the room copy is kept and we retry on the next change.
    write(p: string, buf: Buffer | null) {
      const abs = join(root, p);
      try {
        if (!inside(abs)) return false;
        if (buf === null) { try { unlinkSync(abs); } catch {} return true; }
        mkdirSync(dirname(abs), { recursive: true });
        const tmp = join(dirname(abs), `.murmur-tmp-${newId()}`);
        writeFileSync(tmp, buf);
        // Windows refuses to rename over a file an editor holds open; write in place instead.
        try { renameSync(tmp, abs); } catch { writeFileSync(abs, buf); rmSync(tmp, { force: true }); }
        return true;
      } catch { return false; }
    },
    async files(under?: string[]) {
      if (!under) return unignored(walk());
      const out: string[] = [];
      for (const p of under) {
        try { if (statSync(join(root, p)).isDirectory()) { out.push(...walk(p)); continue; } } catch {}
        out.push(p);
      }
      return unignored(out);
    },
    known: () => known,
    saveKnown(k: Map<string, string>) { known = k; clearTimeout(knownT); knownT = setTimeout(writeKnown, 300); },
    watch(cb: (paths: string[]) => void) {
      const pending = new Set<string>();
      watcher = watch(root, { recursive: true }, (_e, f) => {
        const p = f && okPath(String(f).split(sep).join('/'));
        if (!p || p.includes('.murmur-tmp-')) return;
        pending.add(p); clearTimeout(flushT); flushT = setTimeout(() => { const b = [...pending]; pending.clear(); cb(b); }, 200);
      });
      watcher.on('error', () => {});
    },
    close() { watcher?.close(); clearTimeout(flushT); if (knownT || known.size) writeKnown(); },
  };
}

// In memory, for tests: path -> contents. Same filtering as the real folder minus .gitignore.
export function memDisk(init: Record<string, string> = {}, known: Record<string, string> = {}) {
  const files = new Map(Object.entries(init).map(([p, s]) => [p, Buffer.from(s)]));
  let k = new Map(Object.entries(known));
  return {
    read: (p: string) => files.get(p) ?? null,
    write(p: string, buf: Buffer | null) { if (buf) files.set(p, buf); else files.delete(p); return true; },
    async files(under?: string[]) {
      const all = [...files.keys()].filter(p => okPath(p));
      return under ? under.flatMap(p => files.has(p) ? [p] : all.some(x => x.startsWith(p + '/')) ? all.filter(x => x.startsWith(p + '/')) : [p]) : all;
    },
    known: () => new Map(k),
    saveKnown(m: Map<string, string>) { k = new Map(m); },
  };
}
