// Agent CLI processes (claude first): which binary, spawn as a killable tree, stream-json lines, session id.
// Shared by node lanes (src/node/lane.ts) and room turns (src/room/agent.ts).
import { spawn, execFile } from 'node:child_process';
import { parse as shParse } from 'shell-quote';

export const WIN = process.platform === 'win32';
export const claudeBin = (): string[] => process.env.MURMUR_CLAUDE_BIN ? shParse(process.env.MURMUR_CLAUDE_BIN).filter((w): w is string => typeof w === 'string') : ['claude'];
export const okModel = (m: unknown): m is string => typeof m === 'string' && !m.startsWith('-') && /^[A-Za-z0-9._:/\[\]-]{1,80}$/.test(m);
export const okEffort = (e: unknown): e is string => typeof e === 'string' && /^[a-z]{2,12}$/.test(e);

// Claude reports its session on `system`/`init` lines (one per turn) (see test/fixtures/claude-2.1.302.jsonl).
export const sessionOf = (o: any): string | undefined => o?.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string' ? o.session_id : undefined;

// Chunks in, whole lines out (\r\n tolerated); end() flushes a last line without a newline.
export function lines(fn: (line: string) => void) {
  let rest = '';
  return {
    push: (chunk: string) => { const ls = (rest + chunk).split('\n'); rest = ls.pop()!; for (const l of ls) fn(l.replace(/\r$/, '')); },
    end: () => { if (rest) fn(rest.replace(/\r$/, '')); rest = ''; },
  };
}
export const jsonLines = (onJson: (o: any) => void, onText: (line: string) => void = () => {}) => lines(l => {
  let o: any;
  try { o = JSON.parse(l); } catch { return onText(l); }
  onJson(o);
});

// The transport seam: a real process tree (spawnChild) or, in tests, an in-process script.
export type Child = { write(s: string): void; end(s?: string): void; kill(): Promise<void>; exited: Promise<void> };
export type Handlers = { out(chunk: string): void; err(chunk: string): void; error(e: Error): void; close(code: number | null, signal: string | null): void };
export type Spawn = (argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv }, h: Handlers) => Child;

const KILL_GRACE_MS = 3000;
// cmd.exe quoting for shell:true on Windows (needed to run npm .cmd shims like claude.cmd).
const winQuote = (a: string) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

export const spawnChild: Spawn = (argv, o, h) => {
  const c = WIN ? spawn(argv.map(winQuote).join(' '), { ...o, shell: true, windowsHide: true, stdio: 'pipe' })
    : spawn(argv[0], argv.slice(1), { ...o, detached: true, stdio: 'pipe' }); // own process group, so kill() reaches tools it spawned
  c.stdin!.on('error', () => {});
  c.stdout!.setEncoding('utf8').on('data', h.out);
  c.stderr!.setEncoding('utf8').on('data', h.err);
  c.on('error', h.error);
  const exited = new Promise<void>(r => c.on('close', (code, sig) => { h.close(code, sig); r(); })); // also fires after a spawn error
  const live = () => c.exitCode === null && !c.signalCode && c.pid !== undefined;
  const signal = (sig: NodeJS.Signals) => {
    if (WIN) execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], () => {});
    else try { process.kill(-c.pid!, sig); } catch {}
  };
  return {
    exited,
    write: s => { if (live() && !c.stdin!.destroyed) c.stdin!.write(s); },
    end: s => c.stdin!.end(s),
    // SIGTERM the tree, SIGKILL whatever ignores it.
    async kill() {
      if (!live()) return;
      signal('SIGTERM');
      const t = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
      await exited;
      clearTimeout(t);
    },
  };
};

export const exec = (argv: string[], timeout = 10000) => new Promise<{ ok: boolean; out: string }>(r => {
  const c = execFile(argv[0], argv.slice(1), { timeout }, (e, so, se) => r({ ok: !e, out: String(so || se || e?.message || '').trim() }));
  c.stdin?.end();
});
export async function claudeInfo(bin = claudeBin(), timeout?: number) {
  const [v, a] = await Promise.all([exec([...bin, '--version'], timeout), exec([...bin, 'auth', 'status'], timeout)]);
  return { version: v.ok ? v.out.split('\n')[0] || null : null, authed: a.ok };
}
