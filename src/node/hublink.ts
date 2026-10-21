// The node's link to its hub: one WebSocket carrying seq-numbered frames, an outbox replayed after every
// reconnect until the hub acks it, reconnect with backoff, and the hub's REST API under the same device token.
import { WebSocket } from 'ws';
import { NODE_REPORTS, type Frame, type NodeReports } from '../shared.ts';

// The socket seam: `ws` in production, an in-memory socket in tests.
export type Socket = { readonly readyState: number; send(s: string): void; close(): void; on(ev: string, fn: (...a: any[]) => void): unknown };
export type Dial = (url: string, headers: Record<string, string>) => Socket;
const dialWs: Dial = (url, headers) => new WebSocket(url, { headers });
const OUTBOX_MAX = 5000;

export function hubLink(o: { url: string; token: string; hello: () => object; onFrame: (f: Frame) => void; dial?: Dial }) {
  const auth = `Bearer ${o.token}`;
  let ws: Socket | undefined, seq = 0, outbox: Frame[] = [], attempt = 0, closed = false, retry: NodeJS.Timeout | undefined;
  const online = () => ws?.readyState === WebSocket.OPEN;
  const raw = (f: Frame) => { if (online()) ws!.send(JSON.stringify(f)); };
  const up = <T extends keyof NodeReports>(t: T, d: NodeReports[T]) => {
    if (!NODE_REPORTS.has(t)) throw new Error(`unknown frame ${t}`);
    const f = { t, seq: ++seq, d };
    outbox.push(f);
    if (outbox.length > OUTBOX_MAX) outbox.shift(); // ponytail: in-memory outbox, lost if the node dies offline
    raw(f);
  };

  function connect() {
    if (closed) return;
    const s = ws = (o.dial ?? dialWs)(o.url.replace(/^http/, 'ws') + '/ws/node', { authorization: auth });
    s.on('open', () => {
      attempt = 0;
      raw({ t: 'hello', d: o.hello() });
      for (const f of outbox) raw(f);
    });
    s.on('message', (m: unknown) => {
      let f: Frame;
      try { f = JSON.parse(String(m)); } catch { return; }
      if (f.t === 'ack') outbox = outbox.filter(x => x.seq! > (f.d ?? {}).seq);
      else if (f.t === 'ping') raw({ t: 'pong', d: {} });
      else o.onFrame(f);
    });
    s.on('close', () => { if (ws === s && !closed) retry = setTimeout(connect, Math.min(15000, 500 * 2 ** attempt++) + Math.random() * 500); });
    s.on('error', () => {});
  }

  // Throws Error & {status} on an HTTP error, a plain Error when the hub is unreachable.
  async function hub(method: string, path: string, body?: unknown, timeout = 10000): Promise<any> {
    const r = await fetch(o.url + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
      headers: { authorization: auth, 'content-type': 'application/json' },
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error ?? `hub HTTP ${r.status}`), { status: r.status });
    return j;
  }

  return { connect, up, raw, online, hub, close() { closed = true; clearTimeout(retry); ws?.close(); } };
}
