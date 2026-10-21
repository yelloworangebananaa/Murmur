// Hook script spawned by claude: `node hook.ts <Event>`. Forwards stdin JSON to the node, prints the node's answer.
import { callNode } from './loopback.ts';
import { HOOK_FETCH_MS } from './broker.ts';

const ev = process.argv[2] ?? '';
let body = '';
for await (const c of process.stdin) body += c;
let stdout = '', code = 0;
try {
  const r = await callNode(`/hook/${ev}`, body, AbortSignal.timeout(ev === 'PreToolUse' ? HOOK_FETCH_MS : 2500));
  const j: any = await r.json();
  stdout = j.stdout ?? ''; code = j.exit ?? 0;
} catch {}
// Fail open, on purpose: if the node is unreachable (or its answer unreadable) the hook has no opinion: empty stdout,
// exit 0, and claude's own --permission-mode applies (never bypassPermissions, see CLAUDE_MODE). Every other
// failure is decided in the node; see the fail policy in broker.ts.
process.stdout.write(stdout, () => process.exit(code));
