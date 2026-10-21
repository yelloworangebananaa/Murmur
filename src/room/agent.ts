// Runs one turn of any agent CLI in the shared folder. Claude's stream-json is parsed for tool steps;
// every other CLI's stdout is relayed as plain text. Coordination is plain text too, so it works with any CLI.
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parse as shParse } from 'shell-quote';
import { parseLine } from '../shared.ts';
import { WIN, okModel, okEffort, sessionOf, jsonLines, spawnChild } from '../claude.ts';
export { okModel, okEffort };

// Prompt delivery, in order of preference (stdin and files dodge Windows' command-line length and quoting limits):
//   no token     -> prompt on stdin
//   {promptfile} -> path of a file holding the prompt
//   {prompt}     -> the prompt as one argument (on Windows: a short "read this file" pointer instead)
// Permission switches are not in these strings: launch() adds them from the agent's access setting.
export const PRESETS: Record<string, string> = {
  claude: 'claude -p --output-format stream-json --verbose',
  codex: 'codex exec --skip-git-repo-check -',
  gemini: 'gemini',
  opencode: 'opencode run {prompt}',
  aider: 'aider --yes-always --no-git --no-auto-commits --message-file {promptfile}',
};

// ---- model + effort for claude and codex ----
// Claude: aliases always track the newest model; full ids pin one. Any other id can be typed in.
const CLAUDE_MODELS = [['fable', 'Fable (latest)'], ['opus', 'Opus (latest)'], ['sonnet', 'Sonnet (latest)'], ['haiku', 'Haiku (latest)'],
  ['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // `claude --help`, --effort

// Codex keeps the models your account can use (with their effort levels) in ~/.codex/models_cache.json.
export function modelOptions() {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  let codex: { id: string; label: string; efforts: string[]; defaultEffort?: string; hidden: boolean }[] = [];
  let cfgModel: string | undefined, cfgEffort: string | undefined;
  try {
    codex = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')).models.filter((m: any) => okModel(m.slug)).map((m: any) => ({
      id: m.slug, label: m.display_name || m.slug, efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l.effort).filter(okEffort),
      defaultEffort: m.default_reasoning_level, hidden: m.visibility === 'hide' }));
  } catch {}
  try {
    const top = readFileSync(join(home, 'config.toml'), 'utf8').split(/^\[/m)[0];
    cfgModel = /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1];
    cfgEffort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  } catch {}
  return {
    claude: { models: CLAUDE_MODELS.map(([id, label]) => ({ id, label, efforts: CLAUDE_EFFORTS })), efforts: CLAUDE_EFFORTS },
    codex: { models: codex, efforts: [...new Set(codex.flatMap(m => m.efforts))], configModel: cfgModel, configEffort: cfgEffort,
      configModelMissing: !!cfgModel && codex.length > 0 && !codex.some(m => m.id === cfgModel) },
  };
}
export function modelArgs(cli: string, model?: string, effort?: string): string[] {
  const m = okModel(model) ? model : undefined, e = okEffort(effort) ? effort : undefined;
  if (cli === 'claude') return [...(m ? ['--model', m] : []), ...(e ? ['--effort', e] : [])];
  // Unquoted value: codex parses -c as TOML and falls back to the raw string, which also survives cmd.exe quoting.
  if (cli === 'codex') return [...(m ? ['-m', m] : []), ...(e ? ['-c', `model_reasoning_effort=${e}`] : [])];
  return [];
}
// Shell access per CLI. Off (default): the agent edits files but cannot run commands, so no tests or scripts
// on this computer. Full access: the CLI runs with no permission checks, like your own terminal session.
// codex can't drop its shell (it is how codex works), so off = its workspace sandbox: commands only inside the folder, no network.
const ACCESS: Record<string, { off: string[]; full: string[]; env?: (full: boolean) => Record<string, string> }> = {
  claude: { off: ['--permission-mode', 'acceptEdits', '--disallowedTools=Bash'], full: ['--permission-mode', 'bypassPermissions'] },
  codex: { off: ['--sandbox', 'workspace-write'], full: ['--dangerously-bypass-approvals-and-sandbox'] },
  gemini: { off: ['--approval-mode', 'auto_edit'], full: ['--yolo'] },
  opencode: { off: [], full: [], env: full => ({ OPENCODE_PERMISSION: JSON.stringify(full ? { edit: 'allow', bash: 'allow', webfetch: 'allow' } : { edit: 'allow', bash: 'deny' }) }) },
  aider: { off: ['--no-suggest-shell-commands'], full: [] },
};
export type AgentLaunch = { cli: string; cmd: string; model?: string; effort?: string; fullAccess?: boolean };
// Preset agents always use today's preset (an older saved command could carry e.g. --yolo); custom commands run as typed.
export function launch(a: AgentLaunch) {
  const acc = ACCESS[a.cli], full = !!a.fullAccess;
  return { template: PRESETS[a.cli] ?? a.cmd, extra: [...modelArgs(a.cli, a.model, a.effort), ...(acc ? acc[full ? 'full' : 'off'] : [])], env: acc?.env?.(full) };
}
export type Out = (kind: 'agent' | 'tool' | 'error', text: string) => void;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const TURN_MS = 20 * 60_000;

const toolLine = (name: string, i: any) => {
  const what = i?.file_path ?? i?.path ?? i?.command ?? i?.pattern ?? i?.url ?? i?.description ?? '';
  return `${name} ${String(what).split('\n')[0].slice(0, 200)}`.trim();
};

export function runTurn(o: { template: string; prompt: string; cwd: string; resume?: string; extra?: string[]; env?: Record<string, string>; onOut: Out; onSession?: (id: string) => void }) {
  const words = shParse(o.template).filter((w): w is string => typeof w === 'string');
  if (!words.length) throw new Error('empty agent command');
  const viaStdin = !words.includes('{prompt}') && !words.includes('{promptfile}');
  // The prompt file lives in the project's .murmur/ so sandboxed CLIs (claude reads only inside cwd) can open it.
  const rel = `.murmur/prompt-${randomBytes(4).toString('hex')}.md`, abs = join(o.cwd, rel);
  const needFile = words.includes('{promptfile}') || (WIN && words.includes('{prompt}'));
  if (needFile) { mkdirSync(join(o.cwd, '.murmur'), { recursive: true }); writeFileSync(abs, o.prompt); }
  const args = words.slice(1).map(w => w === '{promptfile}' ? abs
    : w === '{prompt}' ? (WIN ? `Read your instructions from the file ${rel} in the current folder, then follow them.` : o.prompt) : w);
  // Model/effort flags go before a trailing "-" (codex's read-stdin marker), else at the end.
  if (o.extra?.length) args.splice(args.at(-1) === '-' ? args.length - 1 : args.length, 0, ...o.extra);
  const claude = args.includes('stream-json');
  if (claude && o.resume) args.push('--resume', o.resume);
  const env = { ...process.env, ...o.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  let buf = '', errTail = '', flushT: NodeJS.Timeout | undefined, failed = false;
  const flush = () => { clearTimeout(flushT); flushT = undefined; const t = buf.replace(ANSI, '').trim(); buf = ''; if (t) o.onOut('agent', t); };
  const json = jsonLines(j => {
    const sid = sessionOf(j);
    if (sid) o.onSession?.(sid);
    for (const e of parseLine(j)) {
      if (e.k === 'assistant.message' && e.text.trim()) o.onOut('agent', e.text.trim());
      else if (e.k === 'tool.start') o.onOut('tool', toolLine(e.name, e.input));
      else if (e.k === 'turn.end' && e.isError) o.onOut('error', e.text || 'turn failed');
    }
  });
  const child = spawnChild([words[0], ...args], { cwd: o.cwd, env }, {
    out: c => { if (claude) json.push(c); else { buf += c; flushT ??= setTimeout(flush, 800); } },
    err: c => { errTail = (errTail + c).slice(-1500); },
    error: e => { failed = true; o.onOut('error', `could not start "${words[0]}": ${e.message}. Is it installed and logged in?`); },
    close: code => {
      clearTimeout(t); json.end(); flush();
      if (needFile) rmSync(abs, { force: true });
      if (code && !failed) o.onOut('error', `${words[0]} exited with code ${code}${errTail.trim() ? `: ${errTail.replace(ANSI, '').trim()}` : ''}`);
    },
  });
  child.end(viaStdin ? o.prompt : undefined);
  // Kills the whole process tree: the CLI may have spawned tools of its own.
  const t = setTimeout(child.kill, TURN_MS); t.unref();
  return { done: child.exited, stop: child.kill };
}
