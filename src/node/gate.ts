// PreToolUse gate: capability classifier, mode posture, path containment, fail mode.
import { parse } from 'shell-quote';
import { realpathSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute, join, sep } from 'node:path';
import { READ_ONLY_TOOLS, type Capability, type LaneMode } from '../shared.ts';

// ponytail: string-based Bash heuristic, evadable (python -c sockets, aliases, eval). Speed bump, not a sandbox; upgrade = egress sandbox.
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp']);
const EXTERNAL = new Set(['gh', 'docker', 'kubectl', 'helm', 'terraform', 'aws', 'gcloud', 'az', 'vercel', 'fly', 'flyctl', 'netlify', 'heroku', 'firebase']);
const SHELLS = new Set(['bash', 'sh', 'zsh']);
// wrapper -> flags that take a separate argument
const WRAPPERS: Record<string, string[]> = {
  env: ['-u', '-C', '--unset', '--chdir'], sudo: ['-u', '-g', '-C', '-h', '-p', '-U'], npx: ['-p', '--package'], bunx: ['-p', '--package'],
  timeout: ['-s', '-k', '--signal', '--kill-after'], nice: ['-n'], nohup: [], command: [], exec: ['-a'], xargs: ['-I', '-n', '-P', '-L', '-d', '-a', '-s', '-E'],
};
const SEPS = new Set([';', '|', '&', '&&', '||', '|&', ';;', '(', ')']);
const MAX_DEPTH = 3;

export function classify(tool: string, input: any): Capability[] {
  if (READ_ONLY_TOOLS.has(tool) || tool.startsWith('mcp__murmur__')) return [];
  if (tool.startsWith('mcp__')) return ['external'];
  if (tool !== 'Bash') return ['files'];
  const caps = new Set<Capability>();
  bash(String(input?.command ?? ''), 0, caps);
  return [...caps];
}

function bash(script: string, depth: number, caps: Set<Capability>) {
  if (depth > MAX_DEPTH) { caps.add('external'); return; } // too deep to trust: gate it
  // command substitutions: classify the inner text too, innermost first
  const sub = /\$\(([^()]*)\)|`([^`]*)`/;
  for (let m; (m = sub.exec(script));) {
    bash(m[1] ?? m[2], depth + 1, caps);
    script = script.slice(0, m.index) + ' SUBST ' + script.slice(m.index + m[0].length);
  }
  let seg: string[] = [];
  const toks = parse(script, k => '$' + k);
  for (let i = 0; i <= toks.length; i++) {
    const t: any = toks[i];
    if (t === undefined || (typeof t === 'object' && 'op' in t && SEPS.has(t.op))) {
      if (seg.length) segment(seg, depth, caps);
      seg = [];
    } else if (typeof t === 'string') seg.push(t);
    else if (t.op === 'glob') seg.push(t.pattern);
    else if ('op' in t) i++; // redirect: skip its target
  }
}

function segment(a: string[], depth: number, caps: Set<Capability>) {
  for (;;) {
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a = a.slice(1);
    if (!a.length) return;
    const cmd = basename(a[0]);
    if (cmd === 'pnpm' && a[1] === 'dlx') { a = a.slice(2); continue; }
    if (SHELLS.has(cmd)) {
      const c = a.indexOf('-c');
      if (c > 0 && a[c + 1] !== undefined) return bash(a[c + 1], depth + 1, caps);
      break;
    }
    const argFlags = WRAPPERS[cmd];
    if (!argFlags) break;
    let i = 1;
    while (i < a.length && a[i].startsWith('-')) i += argFlags.includes(a[i]) ? 2 : 1;
    if (cmd === 'timeout') i++; // duration
    a = a.slice(i);
  }
  const cmd = basename(a[0]), args = a.slice(1);
  if (cmd === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[i]) ? 2 : 1;
    const sc = args[i];
    if (sc === 'push') caps.add('push');
    else if (['commit', 'merge', 'rebase', 'cherry-pick', 'reset', 'tag'].includes(sc)) caps.add('commit');
    else if (['fetch', 'pull', 'clone', 'ls-remote'].includes(sc)) caps.add('network');
    else caps.add('files');
  } else if (NETWORK.has(cmd)) caps.add('network');
  else if (EXTERNAL.has(cmd) || (['npm', 'pnpm', 'yarn'].includes(cmd) && args.includes('publish'))) caps.add('external');
  else caps.add('files');
}

export function decide(mode: LaneMode, caps: Capability[], ctx: { outsideWorktree: boolean }): 'none' | 'gate' {
  if (mode === 'plan') return 'none';
  if (mode === 'full') return caps.includes('push') || ctx.outsideWorktree ? 'gate' : 'none';
  if (ctx.outsideWorktree && caps.length) return 'gate';
  if (mode === 'request') return caps.length ? 'gate' : 'none';
  return caps.some(c => c !== 'files') ? 'gate' : 'none';
}

function real(p: string): string {
  try { return realpathSync(p); } catch { const d = dirname(p); return d === p ? p : join(real(d), basename(p)); }
}

export function targetPaths(tool: string, input: any, wt: string): { paths: string[]; outsideWorktree: boolean } {
  const root = real(resolve(wt));
  let outsideWorktree = false;
  const paths: string[] = [];
  for (const k of ['file_path', 'path', 'notebook_path']) {
    const v = input?.[k];
    if (typeof v !== 'string' || !v) continue;
    const abs = real(resolve(root, v));
    const rel = relative(root, abs);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) { outsideWorktree = true; paths.push(abs); }
    else paths.push(rel.split(sep).join('/'));
  }
  return { paths, outsideWorktree };
}

const FAIL_DEFAULT: Record<string, 'open' | 'closed'> = { push: 'closed', external: 'closed', network: 'closed', files: 'open', commit: 'open' };
export function failDecision(caps: Capability[], failMode: Record<string, 'open' | 'closed'>): 'allow' | 'deny' {
  const m = { ...FAIL_DEFAULT, ...failMode };
  return caps.some(c => m[c] === 'closed') ? 'deny' : 'allow';
}
