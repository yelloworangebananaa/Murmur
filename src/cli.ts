#!/usr/bin/env node
// murmur CLI: start | login | bind | doctor | status
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { createNode } from './node/daemon.ts';
import { murmurHome, readConfig, updateConfig, postJson as post } from './node/config.ts';
import { exec, claudeInfo } from './claude.ts';
import { NODE_PORT } from './shared.ts';

const { positionals: [cmd, ...rest], values } = parseArgs({ allowPositionals: true, options: { hub: { type: 'string' }, port: { type: 'string' } } });
const home = murmurHome();
const config = readConfig(home);
const die = (msg: string): never => { console.error(msg); process.exit(1); };
async function checkClaude() {
  const c = await claudeInfo();
  console.log(`claude: ${c.version ?? 'NOT FOUND'}; auth: ${c.authed ? 'ok' : 'NOT LOGGED IN (run `claude` and log in)'}`);
  return !!c.version && c.authed;
}

if (cmd === 'start') {
  const port = Number(values.port ?? config.port ?? NODE_PORT);
  const node = await createNode({ home, port, hubUrl: values.hub });
  console.log(`murmur node on ${node.url}${values.hub ?? config.hubUrl ? ` (hub ${values.hub ?? config.hubUrl})` : ' (no hub)'}`);
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => node.close().then(() => process.exit(0)));
} else if (cmd === 'login') {
  const hub = (rest[0] ?? die('usage: murmur login <hubUrl>')).replace(/\/$/, '');
  const s = await post(`${hub}/api/device/start`, { name: hostname() });
  if (s.status !== 200) die(`hub refused: ${s.json.error ?? s.status}`);
  console.log(`Open ${s.json.verifyUrl} and enter code ${s.json.userCode}`);
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    const p = await post(`${hub}/api/device/poll`, { deviceCode: s.json.deviceCode });
    if (p.status === 428) continue;
    if (p.status !== 200) die(p.status === 410 ? 'code expired, run login again' : `login failed: ${p.json.error ?? p.status}`);
    updateConfig(home, c => ({ ...c, hubUrl: hub, deviceId: p.json.deviceId, deviceToken: p.json.deviceToken, bindings: c.bindings ?? {} }));
    console.log(`logged in as device ${p.json.deviceId}`);
    break;
  }
} else if (cmd === 'bind') {
  const [wsId, clone] = rest;
  if (!wsId || !clone) die('usage: murmur bind <workspaceId> <clonePath>');
  if (!config.deviceToken) die('run `murmur login <hubUrl>` first');
  const clonePath = resolve(clone);
  const remote = await exec(['git', '-C', clonePath, 'remote', 'get-url', 'origin']);
  if (!remote.ok) die(`no origin remote in ${clonePath}`);
  const r = await post(`${config.hubUrl}/api/workspaces/${wsId}/bind`, { clonePath, remote: remote.out }, config.deviceToken);
  if (r.status !== 200) die(`bind failed: ${r.json.error ?? r.status}`);
  updateConfig(home, c => ({ ...c, bindings: { ...c.bindings, [wsId]: clonePath } }));
  console.log(`bound ${wsId} → ${clonePath}`);
  await checkClaude();
} else if (cmd === 'doctor') {
  const ok = await checkClaude();
  const g = await exec(['git', '--version']);
  const [maj, min] = (g.out.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  const gitOk = maj > 2 || (maj === 2 && min >= 38);
  console.log(`git: ${g.out || 'NOT FOUND'}${gitOk ? '' : ' (need ≥ 2.38 for merge-tree --write-tree)'}`);
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;
  console.log(`node: ${process.version}${nodeOk ? '' : ' (need ≥ 24)'}`);
  process.exit(ok && gitOk && nodeOk ? 0 : 1);
} else if (cmd === 'status') {
  const port = Number(values.port ?? config.port ?? NODE_PORT);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-murmur-token': readFileSync(join(home, 'node-token'), 'utf8').trim() } });
    console.log(JSON.stringify(await r.json()));
  } catch (e: any) { die(`node not running on port ${port}: ${e.message}`); }
} else {
  die('usage: murmur start [--hub URL] [--port N] | login <hubUrl> | bind <workspaceId> <clonePath> | doctor | status');
}
