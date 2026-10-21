#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHub } from './server.ts';
import { HUB_PORT } from '../shared.ts';

const e = process.env;
const hub = await createHub({ dataDir: e.MURMUR_DATA ?? './murmur-data', port: Number(e.MURMUR_PORT ?? HUB_PORT), host: e.MURMUR_HOST ?? '127.0.0.1', publicUrl: e.MURMUR_PUBLIC_URL });
console.log(`murmur-hub listening on ${hub.url}`);

// One link to continue from. On first run it carries the setup code in the #fragment, which
// the browser never sends to the server; the landing page pre-fills it.
const base = (e.MURMUR_PUBLIC_URL ?? hub.url.replace(/\/\/(0\.0\.0\.0|\[::\])(?=:)/, '//localhost')).replace(/\/$/, '');
const link = hub.setupCode ? `${base}/#/?code=${hub.setupCode}` : `${base}/`;
console.log(`\n  Open ${link}\n`);
if (process.stdout.isTTY && !e.MURMUR_NO_OPEN) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [link]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : ['xdg-open', [link]];
  execFile(cmd, args, () => {}); // best effort; the printed link is the fallback
}

for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, () => hub.close().then(() => process.exit(0)));
