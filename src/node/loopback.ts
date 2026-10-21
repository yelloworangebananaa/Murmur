// How lane-side processes (hook.ts, mcp.ts) call their node: lane id and lane-scoped token from the env the node gave claude.
import { readFileSync } from 'node:fs';
import { NODE_PORT } from '../shared.ts';

export async function callNode(path: string, body: string, signal?: AbortSignal, env: Record<string, string | undefined> = process.env) {
  return fetch(`${env.MURMUR_NODE_URL ?? `http://127.0.0.1:${NODE_PORT}`}${path}`, {
    method: 'POST', body, signal,
    headers: { 'content-type': 'application/json', 'x-murmur-lane': env.MURMUR_LANE ?? '', 'x-murmur-token': readFileSync(env.MURMUR_NODE_TOKEN_FILE ?? '', 'utf8').trim() },
  });
}
