// Agent shell access: off by default (no shell, so no running tests or scripts); "full access" is a per-agent opt-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from '../src/room/agent.ts';
import { createCrew, type Turn } from '../src/room/crew.ts';

const def = (cli: string, cmd = '', fullAccess?: boolean) => ({ id: 'a', name: 'A', cli, cmd, fullAccess });

test('launch: claude has no shell by default, skips permission checks with full access', () => {
  const off = launch(def('claude', 'claude -p'));
  assert.match(off.template, /^claude -p --output-format stream-json/);
  assert.deepEqual(off.extra, ['--permission-mode', 'acceptEdits', '--disallowedTools=Bash']);
  assert.deepEqual(launch(def('claude', '', true)).extra, ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(launch({ ...def('claude'), model: 'opus' }).extra.slice(0, 2), ['--model', 'opus']);
});

test('launch: other CLIs map to their own switches; presets ignore a stale stored command', () => {
  assert.deepEqual(launch(def('codex')).extra, ['--sandbox', 'workspace-write']);
  assert.deepEqual(launch(def('codex', '', true)).extra, ['--dangerously-bypass-approvals-and-sandbox']);
  const g = launch(def('gemini', 'gemini --yolo')); // saved before access existed
  assert.doesNotMatch(g.template, /--yolo/);
  assert.deepEqual(g.extra, ['--approval-mode', 'auto_edit']);
  assert.deepEqual(launch(def('gemini', '', true)).extra, ['--yolo']);
  assert.equal(JSON.parse(launch(def('opencode')).env!.OPENCODE_PERMISSION).bash, 'deny');
  assert.equal(JSON.parse(launch(def('opencode', '', true)).env!.OPENCODE_PERMISSION).bash, 'allow');
  assert.deepEqual(launch(def('aider')).extra, ['--no-suggest-shell-commands']);
  assert.deepEqual(launch(def('custom', 'mycli --x {promptfile}', true)), { template: 'mycli --x {promptfile}', extra: [], env: undefined });
});

test('crew: turns launch with the agent\'s access', async () => {
  const seen: any[] = [];
  const turn: Turn = o => { seen.push(o); return { done: Promise.resolve(), stop() {} }; };
  const crew = createCrew({ turn, send: () => {}, room: () => ({ name: 'r', peers: [], agents: [], feed: [], cwd: '/x' }) });
  crew.load([def('claude', 'claude -p', true)]);
  crew.wake('a', { from: 'gio', text: 'go', hops: 0 });
  assert.deepEqual(seen[0].extra, ['--permission-mode', 'bypassPermissions']);
});
