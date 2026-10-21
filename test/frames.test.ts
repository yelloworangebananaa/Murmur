// Hub <-> node frame catalog: every frame one side sends, the other side handles. Static, so it catches drift
// on paths no e2e test reaches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NODE_COMMANDS, NODE_REPORTS } from '../src/shared.ts';
import { hubLink } from '../src/node/hublink.ts';

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const all = (s: string, re: RegExp) => new Set([...s.matchAll(re)].map(m => m[1]));
const cases = (s: string) => all(s, /case '([\w.]+)'/g);

test('every hub->node command is handled by the node', () => {
  const handled = new Set([...cases(src('node/daemon.ts')), ...all(src('node/hublink.ts'), /f\.t === '([\w.]+)'/g)]);
  for (const t of NODE_COMMANDS) assert.ok(handled.has(t), `node ignores ${t}`);
});

test('every node->hub report is handled by the hub', () => {
  const handled = cases(src('hub/server.ts'));
  for (const t of NODE_REPORTS) assert.ok(handled.has(t), `hub ignores ${t}`);
});

test('hub sends only catalogued commands, node sends only catalogued reports', () => {
  const sent = new Set(['lanes.ts', 'coord.ts', 'server.ts'].flatMap(f => [...all(src(`hub/${f}`), /\bsend\([^,]+, ['`]([\w.]+)/g)]));
  sent.delete('lane.'); // `lane.${t}` template: interrupt | stop
  assert.ok(sent.size >= 10, 'send() regex found too few call sites');
  for (const t of sent) assert.ok(NODE_COMMANDS.has(t as any), `hub sends uncatalogued ${t}`);
  for (const t of all(src('node/daemon.ts'), /\bup\('([\w.]+)'/g)) assert.ok(NODE_REPORTS.has(t as any), `node sends uncatalogued ${t}`);
});

test('hubLink refuses an uncatalogued report', () => {
  const link = hubLink({ url: 'ws://x', token: 't', hello: () => ({}), onFrame: () => {}, dial: () => ({ readyState: 0, send() {}, close() {}, on() {} }) });
  try { assert.throws(() => link.up('lane.bogus' as any, {}), /unknown frame/); } finally { link.close(); }
});
