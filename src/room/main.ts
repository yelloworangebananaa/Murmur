#!/usr/bin/env node
// `npm start`: runs this computer's Murmur and opens it in the browser. Create or join a room there.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createPeer } from './peer.ts';

const e = process.env;
const peer = await createPeer({ home: e.MURMUR_HOME ?? join(homedir(), '.murmur'), port: e.MURMUR_UI_PORT ? Number(e.MURMUR_UI_PORT) : undefined,
  hubPort: e.MURMUR_PORT ? Number(e.MURMUR_PORT) : undefined, hubHost: e.MURMUR_HOST });
console.log(`\n  Murmur is running: ${peer.url}\n  Keep this window open while you work. Ctrl+C to stop.\n`);
if (!e.MURMUR_NO_OPEN && process.stdout.isTTY) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [peer.url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', peer.url]] : ['xdg-open', [peer.url]];
  execFile(cmd, args, () => {});
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => { await peer.close(); process.exit(0); });
