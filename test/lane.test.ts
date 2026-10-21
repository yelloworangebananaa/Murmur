import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LaneProcess, laneArgs } from '../src/node/lane.ts';
import { lines as splitLines, sessionOf, type Spawn, type Handlers } from '../src/claude.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLine } from '../src/shared.ts';

const lines = readFileSync(resolve(import.meta.dirname, 'fixtures/claude-2.1.302.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('parser maps the real stream-json fixture', () => {
  const ev = lines.flatMap(parseLine);
  assert.deepEqual(ev.map(e => e.k), ['tool.start', 'tool.result', 'assistant.message', 'turn.end', 'tool.start', 'tool.result', 'assistant.message', 'turn.end']);
  assert.deepEqual(ev[0], { k: 'tool.start', id: 'toolu_01XfKru4RhnvFfvPCH68VDVo', name: 'Bash', input: { command: 'echo hi', description: 'Print hi' } });
  assert.deepEqual(ev[1], { k: 'tool.result', id: 'toolu_01XfKru4RhnvFfvPCH68VDVo', isError: true, text: 'PreToolUse:Bash hook error: murmur says no bash' });
  assert.match((ev[2] as any).text, /PINEAPPLE/);
  assert.equal((ev[3] as any).costUsd, 0.00996731);
  assert.equal((ev[3] as any).isError, false);
});

test('parser: deltas, array tool_result content, ignored types', () => {
  assert.deepEqual(parseLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }), [{ k: 'assistant.delta', text: 'hi' }]);
  assert.deepEqual(parseLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } } }), [{ k: 'thinking.delta', text: 'hm' }]);
  const r = parseLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'x'.repeat(5000) }] }] } });
  assert.equal((r[0] as any).text.length, 4000);
  assert.deepEqual(parseLine({ type: 'system', subtype: 'init', session_id: 's' }), []);
  assert.deepEqual(parseLine({ type: 'rate_limit_event' }), []);
});

// In-process transport: the test plays claude's stdout and reads what the lane wrote to stdin.
function scripted() {
  const s = { h: undefined as any as Handlers, stdin: [] as any[], killed: 0, exit: (code: number | null) => {} };
  const spawn: Spawn = (_argv, _o, h) => {
    s.h = h;
    let done!: () => void;
    const exited = new Promise<void>(r => (done = r));
    s.exit = code => { h.close(code, null); done(); };
    return { exited, write: x => s.stdin.push(JSON.parse(x)), end: () => {}, kill: async () => { s.killed++; s.exit(null); await exited; } };
  };
  return { s, spawn, line: (o: unknown) => s.h.out(JSON.stringify(o) + '\n') };
}

test('LaneProcess: session id, usage limit, auth failure', async () => {
  const { spawn, line } = scripted();
  const p = new LaneProcess(['claude'], [], process.cwd(), process.env, spawn);
  const ev: any[] = [];
  p.on('event', e => ev.push(e));
  line(lines[0]);
  assert.equal(p.claudeSessionId, 'b0e015f5-aeca-4808-8298-7b8a75a3134d');
  line({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1760000000' });
  assert.equal(p.status, 'awaiting_takeover');
  p.text('Invalid API key · Please run /login');
  assert.equal(p.status, 'blocked');
  assert.ok(ev.some(e => e.k === 'lane.status' && e.reason === 'usage_limit'));
  await p.stop();
  assert.equal(p.status, 'stopped');
});

test('LaneProcess: prompts, results, split chunks, stderr, crash', async () => {
  const { s, spawn } = scripted();
  const p = new LaneProcess(['claude'], [], process.cwd(), process.env, spawn);
  const ev: any[] = [];
  p.on('event', e => ev.push(e));
  p.send('one'); p.send('two');
  assert.deepEqual(s.stdin.map(x => x.message.content), ['one', 'two']);
  assert.equal(p.status, 'running');
  const r = JSON.stringify({ type: 'result', result: 'ok' }) + '\r\n';
  s.h.out(r.slice(0, 7)); s.h.out(r.slice(7) + r.slice(0, 3));
  assert.equal(p.status, 'running', 'one result answers one prompt');
  s.h.out(r.slice(3));
  assert.equal(p.status, 'idle');
  assert.equal(ev.filter(e => e.k === 'turn.end').length, 2);
  p.interrupt();
  assert.equal(s.stdin.at(-1).request.subtype, 'interrupt');
  s.h.err('not logged in\n');
  assert.equal(p.status, 'blocked');
  s.exit(1);
  assert.deepEqual(ev.at(-1), { k: 'lane.status', status: 'blocked', reason: 'claude exited (1)' });
});

test('session id comes only from the init line; lines() splits and flushes', () => {
  assert.equal(sessionOf({ type: 'system', subtype: 'hook_response', session_id: 'x' }), undefined);
  assert.equal(sessionOf({ type: 'assistant', session_id: 'x' }), undefined);
  assert.equal(sessionOf(lines[0]), lines[0].session_id);
  const got: string[] = [], l = splitLines(x => got.push(x));
  l.push('a\r\nb'); l.push('c\n\nd'); l.end();
  assert.deepEqual(got, ['a', 'bc', '', 'd']);
});

test('laneArgs: hooks + mcp files, mode, resume, brief, validated model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-lane-'));
  const a = laneArgs(dir, { MURMUR_LANE: 'L' }, { mode: 'request', resume: 'R', brief: 'b', model: 'opus' });
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'default']);
  assert.deepEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2), ['--resume', 'R']);
  assert.equal(a.at(-1), 'opus');
  assert.match(a[a.indexOf('--append-system-prompt') + 1], /murmur-untrusted-data provenance="handoff"/);
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].timeout, 600);
  assert.ok(!laneArgs(dir, {}, { mode: 'full', model: '--dangerously-skip-permissions' }).includes('--model'));
  assert.ok(!laneArgs(dir, {}, { mode: 'full', model: 'a b' }).includes('--model'));
});
