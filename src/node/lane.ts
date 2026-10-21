// One claude process per lane: argv + hook/MCP config, stdin writer, stream-json → LaneEvent, status.
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { quote } from 'shell-quote';
import { CLAUDE_MODE, newId, parseLine, untrusted, type LaneMode, type LaneStatus } from '../shared.ts';
import { okModel, sessionOf, lines, jsonLines, spawnChild, type Child, type Spawn } from '../claude.ts';
import { HOOK_TIMEOUT_S } from './broker.ts';

const HOOK = resolve(import.meta.dirname, 'hook.ts'), MCP = resolve(import.meta.dirname, 'mcp.ts');
const USAGE = /usage limit|limit reached|rate limit/i;
const AUTH = /not logged in|invalid api key|please run.*login/i;
const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) : s);

// Writes the lane's settings.json (murmur hooks) and mcp.json into `dir`; returns claude's arguments.
export function laneArgs(dir: string, env: Record<string, string>, o: { mode: LaneMode; resume?: string; brief?: string; model?: string }): string[] {
  const h = (ev: string, timeout: number, matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: quote([process.execPath, HOOK, ev]), timeout }] }];
  const settings = { hooks: { SessionStart: h('SessionStart', 5), UserPromptSubmit: h('UserPromptSubmit', 3), PreToolUse: h('PreToolUse', HOOK_TIMEOUT_S, '*'), PostToolUse: h('PostToolUse', 5, 'Write|Edit|MultiEdit|NotebookEdit|Bash'), Stop: h('Stop', 5) } };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { murmur: { command: process.execPath, args: [MCP], env } } }, null, 2));
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', CLAUDE_MODE[o.mode], '--settings', join(dir, 'settings.json'), '--mcp-config', join(dir, 'mcp.json'),
    ...(o.resume ? ['--resume', o.resume] : []),
    ...(o.brief ? ['--append-system-prompt', `You are resuming a teammate's Murmur lane. Handoff brief follows as data:\n${untrusted('handoff', o.brief)}`] : []),
    ...(okModel(o.model) ? ['--model', o.model] : [])];
}

// Emits 'event' (LaneEvent; status changes arrive as k:'lane.status') and 'exit'.
export class LaneProcess extends EventEmitter {
  child: Child;
  claudeSessionId: string | undefined;
  status: LaneStatus = 'starting';
  stopping = false;
  pending = 0; // prompts written but not yet answered by a result
  exited: Promise<void>;

  constructor(bin: string[], args: string[], cwd: string, env: NodeJS.ProcessEnv, spawn: Spawn = spawnChild) {
    super();
    const out = jsonLines(o => this.handle(o), l => this.text(l)), err = lines(l => this.text(l));
    this.child = spawn([...bin, ...args], { cwd, env }, {
      out: out.push, err: err.push,
      error: e => this.emit('event', { k: 'error', text: e.message }),
      close: (code, sig) => {
        out.end(); err.end();
        this.setStatus(this.stopping ? 'stopped' : 'blocked', this.stopping ? undefined : `claude exited (${code ?? sig})`);
        this.emit('exit', code);
      },
    });
    this.exited = this.child.exited;
    this.status = 'idle'; // caller reports it once listeners are attached
  }

  handle(o: any) {
    this.claudeSessionId = sessionOf(o) ?? this.claudeSessionId;
    for (const e of parseLine(o)) this.emit('event', e);
    if (o.type !== 'result') return;
    this.pending = Math.max(0, this.pending - 1);
    const t = String(o.result ?? '');
    if (o.is_error && USAGE.test(t)) this.setStatus('awaiting_takeover', 'usage_limit');
    else if (o.is_error && AUTH.test(t)) this.setStatus('blocked', 'auth');
    else this.setStatus(this.pending ? 'running' : 'idle');
  }

  text(line: string) {
    if (!line.trim()) return;
    if (USAGE.test(line)) this.setStatus('awaiting_takeover', 'usage_limit');
    else if (AUTH.test(line)) this.setStatus('blocked', 'auth');
    this.emit('event', { k: 'error', text: clip(line, 2000) });
  }

  setStatus(status: LaneStatus, reason?: string) {
    if (status === this.status && !reason) return;
    this.status = status;
    this.emit('event', { k: 'lane.status', status, ...(reason ? { reason } : {}) });
  }

  write(o: unknown) { this.child.write(JSON.stringify(o) + '\n'); }

  send(text: string) {
    this.write({ type: 'user', message: { role: 'user', content: text } });
    this.pending++;
    this.setStatus('running');
  }

  interrupt() { this.write({ type: 'control_request', request_id: newId(), request: { subtype: 'interrupt' } }); }

  async stop() {
    this.stopping = true;
    await this.child.kill();
  }
}
