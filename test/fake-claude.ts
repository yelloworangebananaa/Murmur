// Scripted stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Emits the same event shapes as claude 2.1.x and runs hooks from --settings like the real CLI.
// Prompt lines are commands: WRITE <path> <content> | BASH <cmd> | MCP <tool> <json> | USAGE_LIMIT | SLEEP <ms> | anything else = chat.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { callNode } from '../src/node/loopback.ts';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const settings = arg('--settings') ? JSON.parse(readFileSync(arg('--settings')!, 'utf8')) : {};
const mcp = arg('--mcp-config') ? JSON.parse(readFileSync(arg('--mcp-config')!, 'utf8')) : {};
const mode = arg('--permission-mode') ?? 'default';
const sessionId = arg('--resume') ?? randomUUID();
const systemPrompt = arg('--append-system-prompt') ?? '';
const mcpEnv: Record<string, string> = mcp?.mcpServers?.murmur?.env ?? {};

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
const base = { session_id: sessionId, uuid: '' };

function runHook(event: string, payload: Record<string, unknown>, toolName?: string): Promise<string> {
  const groups: any[] = settings?.hooks?.[event] ?? [];
  const cmds = groups.filter(g => !toolName || !g.matcher || g.matcher === '*' || new RegExp(`^(${g.matcher})$`).test(toolName))
    .flatMap(g => g.hooks.map((h: any) => h.command as string));
  return cmds.reduce<Promise<string>>(async (acc, cmd) => {
    const prev = await acc;
    const p = spawn('sh', ['-c', cmd], { cwd: process.cwd(), env: process.env });
    let so = '';
    p.stdout.on('data', d => (so += d));
    p.stdin.end(JSON.stringify({ session_id: sessionId, cwd: process.cwd(), hook_event_name: event, permission_mode: mode, ...payload }));
    await new Promise(r => p.on('close', r));
    return prev + so;
  }, Promise.resolve(''));
}

let interrupted = false;

async function tool(name: string, input: any, exec: () => string): Promise<string> {
  const id = 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 20);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, ...base });
  const hookOut = await runHook('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: id }, name);
  let decision: string | undefined, reason = '';
  try { const j = JSON.parse(hookOut); decision = j.hookSpecificOutput?.permissionDecision; reason = j.hookSpecificOutput?.permissionDecisionReason ?? ''; } catch {}
  let text: string, isError = false;
  const needsPermission = mode === 'plan' || mode === 'default' || (mode === 'acceptEdits' && name === 'Bash');
  if (decision === 'deny') { text = `PreToolUse:${name} hook error: ${reason}`; isError = true; }
  else if (decision !== 'allow' && needsPermission) { text = `Claude requested permissions to use ${name}, but you haven't granted it yet.`; isError = true; }
  else { try { text = exec(); } catch (e: any) { text = String(e.message); isError = true; } }
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, ...base });
  if (!isError) await runHook('PostToolUse', { tool_name: name, tool_input: input, tool_use_id: id }, name);
  return text;
}

async function turn(prompt: string) {
  interrupted = false;
  const ctx = await runHook('UserPromptSubmit', { prompt });
  const lines = prompt.split('\n');
  const said: string[] = [];
  const say = (t: string) => {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, ...base });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, ...base });
    said.push(t);
  };
  if (ctx) say('CONTEXT: ' + ctx);
  if (systemPrompt) say('SYSTEM: ' + systemPrompt.slice(0, 2000));
  for (const line of lines) {
    if (interrupted) break;
    const [cmd, ...rest] = line.trim().split(' ');
    if (cmd === 'WRITE') {
      const [p, ...content] = rest; const fp = resolve(process.cwd(), p);
      await tool('Write', { file_path: fp, content: content.join(' ') + '\n' }, () => { mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, content.join(' ') + '\n'); return `File created successfully at: ${fp}`; });
    } else if (cmd === 'BASH') {
      const command = rest.join(' ');
      await tool('Bash', { command, description: 'run' }, () => execFileSync('sh', ['-c', command], { encoding: 'utf8' }));
    } else if (cmd === 'MCP') {
      const [t, ...json] = rest;
      const res = await callNode(`/mcp/${t}`, JSON.stringify({ args: json.length ? JSON.parse(json.join(' ')) : {} }), undefined, mcpEnv)
        .then(r => r.text()).catch(e => 'ERR ' + e.message);
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_mcp', name: `mcp__murmur__${t}`, input: {} }] }, ...base });
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mcp', content: res }] }, ...base });
      say('MCP RESULT: ' + res);
    } else if (cmd === 'USAGE_LIMIT') {
      out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1760000000', ...base });
      await runHook('Stop', {});
      return;
    } else if (cmd === 'SLEEP') {
      await new Promise(r => setTimeout(r, Number(rest[0]) || 0));
    } else if (line.trim()) say('ACK: ' + line.trim());
  }
  await runHook('Stop', {});
  out({ type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', is_error: interrupted, result: interrupted ? 'interrupted' : said.join('\n'), total_cost_usd: 0.001, ...base });
}

out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Read', 'Write', 'Bash'], permissionMode: mode, ...base });
await runHook('SessionStart', { source: arg('--resume') ? 'resume' : 'startup' });

let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', line => {
  let msg: any; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    interrupted = true;
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    return;
  }
  if (msg.type === 'user') {
    const c = msg.message?.content;
    const text = typeof c === 'string' ? c : (c ?? []).map((b: any) => b.text ?? '').join('');
    chain = chain.then(() => turn(text));
  }
}).on('close', () => { chain.then(() => process.exit(0)); });
