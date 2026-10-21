// Static checks for the web UI: files exist, wiring, module syntax, no HTML sinks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = new URL('../src/hub/web/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), 'utf8');

test('index.html references /app.js as a module and /app.css', () => {
  const html = read('index.html');
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/app\.css">/);
  assert.doesNotMatch(html, /https?:\/\//, 'no external (CDN/font) URLs');
});

test('app.css exists and is a dark theme', () => {
  assert.match(read('app.css'), /color-scheme: dark/);
});

for (const file of ['app.js', 'fx.js']) {
  test(`${file} parses as an ES module`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'murmur-web-'));
    try {
      const f = join(tmp, file.replace(/\.js$/, '.mjs'));
      writeFileSync(f, read(file));
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test(`${file} has no HTML-string sinks`, () => {
    const js = read(file);
    for (const re of [/innerHTML\s*=/, /insertAdjacentHTML/, /outerHTML\s*=/, /document\.write/, /\beval\(/, /new Function/]) {
      assert.doesNotMatch(js, re);
    }
  });
}

test('app.js mounts the WebGL backdrops from fx.js', () => {
  assert.match(read('index.html'), /<canvas id="bg"/);
  assert.match(read('app.js'), /import \{ dotMatrix, particleDrift, tornado \} from '\/fx\.js'/);
});

test('app.js wires every spec route and the CSRF header', () => {
  const js = read('app.js');
  for (const r of ['setup', 'login', 'invite', 'device', 'board', 'memory', 'people', '\\/s\\/']) assert.match(js, new RegExp(r));
  assert.match(js, /'x-murmur-csrf': '1'/);
  assert.match(js, /\/ws\/ui\?workspace=/);
});
