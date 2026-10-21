import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from '../src/room/agent.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'murmur-claude-'));

test('room turn: stop() kills a child that ignores SIGTERM', async () => {
  const dir = tmp(), script = join(dir, 'stubborn.mjs');
  writeFileSync(script, `process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000);`);
  const out: string[] = [];
  const t = runTurn({ template: `'${process.execPath}' '${script}'`, prompt: 'hi', cwd: dir, onOut: (_k, s) => out.push(s) });
  for (let i = 0; i < 100 && !out.length; i++) await new Promise(r => setTimeout(r, 50));
  const t0 = Date.now();
  t.stop();
  const done = await Promise.race([t.done.then(() => true), new Promise(r => setTimeout(r, 6000, false))]);
  assert.equal(done, true, 'turn never ended');
  assert.ok(Date.now() - t0 < 5000);
});
