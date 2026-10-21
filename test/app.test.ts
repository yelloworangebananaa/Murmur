// `npm start` as the host: prints one link, the browser side (setup + Connect) pairs this computer, the node comes up.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const freePort = () => new Promise<number>(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const home = mkdtempSync(join(tmpdir(), 'murmur-app-'));
const [hubPort, nodePort] = [await freePort(), await freePort()];
const apps: ReturnType<typeof spawn>[] = [];
after(() => { for (const a of apps) a.kill('SIGTERM'); });
function start(env: Record<string, string>) {
  const a = spawn(process.execPath, [resolve(import.meta.dirname, '../src/app.ts')], {
    env: { ...process.env, MURMUR_NO_OPEN: '1', MURMUR_HOST: '127.0.0.1', MURMUR_CLAUDE_BIN: `node ${resolve(import.meta.dirname, 'fake-claude.ts')}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apps.push(a);
  const log = { out: '' };
  a.stdout!.on('data', d => (log.out += d));
  a.stderr!.on('data', d => (log.out += d));
  return log;
}
const host = start({ MURMUR_HOME: home, MURMUR_PORT: String(hubPort), MURMUR_NODE_PORT: String(nodePort) });
const H = (cookie = '') => ({ 'content-type': 'application/json', 'x-murmur-csrf': '1', ...(cookie ? { cookie } : {}) });
let hub = '', ownerCookie = '';

async function until<T>(what: string, fn: () => T, ms = 15000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${apps.length} app(s) running`); await new Promise(r => setTimeout(r, 50)); }
}

test('host first run: one link, one-click connect, node running', async () => {
  const link = (await until('link', () => /Open (http:\S+)/.exec(host.out)))[1];
  const m = /#\/\?code=([0-9a-f]+)&then=\/device\/([A-Z0-9-]+)$/.exec(link);
  assert.ok(m, link);
  hub = new URL(link).origin;
  // what the browser does: create the owner, then click "Connect this computer"
  const r = await fetch(`${hub}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-murmur-csrf': '1' }, body: JSON.stringify({ code: m[1], name: 'owner', password: 'long enough 1' }) });
  assert.equal(r.status, 200);
  const cookie = ownerCookie = r.headers.getSetCookie()[0].split(';')[0];
  const ok = await fetch(`${hub}/api/device/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-murmur-csrf': '1', cookie }, body: JSON.stringify({ userCode: m[2] }) });
  assert.equal(ok.status, 200);
  await until('running', () => host.out.includes('murmur: running'));
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.hubUrl, hub);
  assert.equal(cfg.hosted, true);
  assert.ok(cfg.deviceToken);
  const devices = await (await fetch(`${hub}/api/devices`, { headers: { cookie } })).json() as any[];
  assert.equal(devices.length, 1);
});

test('teammate: npm start with the invite link joins, one click connects their computer', async () => {
  const w = await (await fetch(`${hub}/api/workspaces`, { method: 'POST', headers: H(ownerCookie), body: JSON.stringify({ name: 'demo', gitRemote: 'https://example.test/demo.git' }) })).json() as any;
  const inv = await (await fetch(`${hub}/api/workspaces/${w.id}/invites`, { method: 'POST', headers: H(ownerCookie), body: JSON.stringify({}) })).json() as any;
  const mate = start({ MURMUR_HOME: mkdtempSync(join(tmpdir(), 'murmur-mate-')), MURMUR_JOIN: inv.url, MURMUR_NODE_PORT: String(await freePort()) });
  const link = (await until('mate link', () => /Open (http:\S+)/.exec(mate.out)))[1];
  const m = new RegExp(`^${hub}/#/invite/${inv.token}\\?then=/device/([A-Z0-9-]+)$`).exec(link);
  assert.ok(m, link);
  assert.ok(!mate.out.includes('hub running'), 'a teammate does not host a hub');
  const acc = await fetch(`${hub}/api/invites/${inv.token}/accept`, { method: 'POST', headers: H(), body: JSON.stringify({ name: 'mate', password: 'long enough 2' }) });
  assert.equal(acc.status, 200);
  const cookie = acc.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await fetch(`${hub}/api/device/approve`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ userCode: m[1] }) })).status, 200);
  await until('mate running', () => mate.out.includes('murmur: running'));
  const ws = await (await fetch(`${hub}/api/workspaces/${w.id}`, { headers: { cookie: ownerCookie } })).json() as any;
  assert.deepEqual(ws.members.map((x: any) => x.name).sort(), ['mate', 'owner']);
});
