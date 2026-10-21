// ~/.murmur/config.json: hub URL, device token, workspace bindings. Shared by the CLI, the app and the node daemon,
// which may run at once (murmur bind while murmur start runs), so every write re-reads the file first.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const murmurHome = () => process.env.MURMUR_HOME ?? join(process.env.HOME ?? '.', '.murmur');
export const readConfig = (home: string): any => { try { return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')); } catch { return {}; } };

// ponytail: read-modify-write without a lock; two writers in the same millisecond can still race
export function updateConfig(home: string, fn: (c: any) => any): any {
  const c = fn(readConfig(home)), f = join(home, 'config.json');
  mkdirSync(home, { recursive: true });
  writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(f, 0o600); // mode only applies when the file is created
  return c;
}

export async function postJson(url: string, body: unknown, auth?: string) {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) } });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
}
