#!/usr/bin/env node
// murmur app: the one command people run. Hosts the team hub (on the machine that hosts) and runs
// this computer's node; everything after that happens in the browser by clicking.
//   npm start                  first run asks: paste an invite link to join, or Enter to host
//   npm start -- <invite link> join a team without the question
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { createHub } from './hub/server.ts';
import { createNode } from './node/daemon.ts';
import { murmurHome, readConfig, updateConfig, postJson as post } from './node/config.ts';
import { HUB_PORT } from './shared.ts';

const e = process.env, home = murmurHome();
mkdirSync(home, { recursive: true });
let config = readConfig(home);
// Replaces the whole file on purpose: joining another team or a dead pairing starts from a clean config.
const save = (c: any) => { config = updateConfig(home, () => c); };
const say = (s: string) => console.log(`murmur: ${s}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function openBrowser(url: string) {
  console.log(`\n  Open ${url}\n`);
  if (e.MURMUR_NO_OPEN || !process.stdout.isTTY) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => {}); // best effort; the printed link is the fallback
}
// Prefer a Tailscale address (100.64.0.0/10) so invites work across the internet; else the LAN address. Same as room/peer.ts.
const tailscale = (a: string) => { const [x, y] = a.split('.').map(Number); return x === 100 && y >= 64 && y < 128; };
const lanIp = () => {
  const v4 = Object.values(networkInterfaces()).flat().filter(i => i?.family === 'IPv4' && !i.internal).map(i => i!.address);
  return v4.find(tailscale) ?? v4[0] ?? '127.0.0.1';
};

// ---- decide: join someone's hub, or host one here ----
let joining: { hubUrl: string; then: string } | null = null;
let answer = process.argv[2] ?? e.MURMUR_JOIN;
if (answer === undefined && !config.hubUrl && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  answer = (await rl.question('\nPaste a Murmur invite link to join a team, or press Enter to host a new team on this computer:\n> ')).trim();
  rl.close();
}
if (answer) {
  let u: URL;
  try { u = new URL(answer); } catch { say(`not a link: ${answer}`); process.exit(1); }
  const route = u.hash.replace(/^#/, '').split('?')[0];
  joining = { hubUrl: u.origin, then: /^\/invite\/[A-Za-z0-9_-]+$/.test(route) ? route : '/' };
  if (config.hubUrl !== joining.hubUrl) save({ hubUrl: joining.hubUrl, bindings: {} });
}

// ---- host ----
let hub: Awaited<ReturnType<typeof createHub>> | null = null;
if (!joining && (!config.hubUrl || config.hosted)) {
  const port = Number(e.MURMUR_PORT ?? HUB_PORT);
  // Teammates on other machines must reach this hub, so listen on the LAN unless told otherwise.
  const host = e.MURMUR_HOST ?? '0.0.0.0';
  const publicUrl = (e.MURMUR_PUBLIC_URL ?? `http://${host === '0.0.0.0' ? lanIp() : host}:${port}`).replace(/\/$/, '');
  hub = await createHub({ dataDir: e.MURMUR_DATA ?? join(home, 'hub'), port, host, publicUrl });
  say(`hub running at ${publicUrl} (teammates open their invite links against this address)`);
  // Same hub, new LAN address: keep this computer's pairing.
  if (config.hubUrl !== publicUrl) save(config.hosted ? { ...config, hubUrl: publicUrl } : { hubUrl: publicUrl, hosted: true, bindings: {} });
}
const hubUrl: string = config.hubUrl;

// ---- connect this computer: device flow, approved with one click in the browser ----
if (config.deviceToken) {
  // A device token may only call lane routes, so a live one gets 403 here and a dead one 401.
  const r = await fetch(`${hubUrl}/api/devices`, { headers: { authorization: `Bearer ${config.deviceToken}` } }).catch(() => null);
  if (r?.status === 401) { say('this computer was disconnected from the hub; reconnecting'); save({ hubUrl, hosted: config.hosted, bindings: {} }); }
}
if (!config.deviceToken) {
  for (;;) {
    const s = await post(`${hubUrl}/api/device/start`, { name: hostname() }).catch(err => { say(`cannot reach ${hubUrl}: ${err.message}`); process.exit(1); });
    if (s.status !== 200) { say(`hub refused: ${s.json.error ?? s.status}`); process.exit(1); }
    const device = `/device/${s.json.userCode}`;
    openBrowser(hub?.setupCode ? `${hubUrl}/#/?code=${hub.setupCode}&then=${device}`
      : joining && joining.then !== '/' ? `${hubUrl}/#${joining.then}?then=${device}`
      : s.json.verifyUrl);
    say('waiting for you to click "Connect this computer" in the browser…');
    let p: any;
    do { await sleep(2000); p = await post(`${hubUrl}/api/device/poll`, { deviceCode: s.json.deviceCode }).catch(() => ({ status: 0 })); } while (p.status === 428 || p.status === 0);
    if (p.status === 200) { config = updateConfig(home, c => ({ ...c, deviceId: p.json.deviceId, deviceToken: p.json.deviceToken, bindings: c.bindings ?? {} })); break; }
    say('that link expired; opening a fresh one');
  }
  say('this computer is connected');
} else {
  openBrowser(joining && joining.then !== '/' ? `${hubUrl}/#${joining.then}` : `${hubUrl}/`);
}

// ---- run this computer's node ----
const node = await createNode({ home, hubUrl, port: e.MURMUR_NODE_PORT ? Number(e.MURMUR_NODE_PORT) : undefined });
say(`running. Keep this window open while you work; press Ctrl+C to stop.`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => { await node.close(); await hub?.close(); process.exit(0); });
