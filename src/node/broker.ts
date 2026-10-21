// PreToolUse permission broker: gate the call, ask the hub, wait for a teammate's decision bound to these exact arguments.
// Fail policy, all of it:
//   node unreachable from hook.ts   -> no opinion, claude's own --permission-mode applies (fail open; see hook.ts)
//   no hub configured               -> gated calls denied
//   hub answers 4xx                 -> denied with the hub's message
//   hub 5xx or unreachable          -> per capability, the lane's failMode (gate.failDecision)
//   no decision in time / shutdown  -> denied
import { argsHash, sanitize, type LaneMode } from '../shared.ts';
import { classify, decide, targetPaths, failDecision } from './gate.ts';

// Timeouts, outermost first. claude kills the hook at HOOK_TIMEOUT_S; the hook stops waiting on the node 10 s
// earlier so it still answers; the node's hub call plus the teammate wait end well inside that.
export const HOOK_TIMEOUT_S = 600;
export const HOOK_FETCH_MS = HOOK_TIMEOUT_S * 1000 - 10_000;
export const HUB_MS = 10_000;
export const APPROVAL_MS = Math.min(120_000, HOOK_FETCH_MS - HUB_MS);

export type Decision = { decision: 'allow' | 'deny'; reason: string };
export type GateLane = { id: string; mode: LaneMode; worktree: string; failMode: Record<string, 'open' | 'closed'> };
export type HubPost = (path: string, body: unknown, timeoutMs: number) => Promise<any>; // throws {status} on HTTP errors

export const hookOutput = (d: Decision | null) => d
  ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } }) } : {};

export function createBroker(hub?: HubPost) {
  const pending = new Map<string, { laneId: string; hash: string; done: (d: Decision) => void }>();
  const deny = (reason: string): Decision => ({ decision: 'deny', reason });

  // null = no opinion.
  async function pretool(l: GateLane, b: any): Promise<Decision | null> {
    const tool = String(b?.tool_name ?? ''), input = b?.tool_input ?? {};
    const caps = classify(tool, input);
    if (!caps.length) return null;
    const t = targetPaths(tool, input, l.worktree);
    const gated = decide(l.mode, caps, { outsideWorktree: t.outsideWorktree }) === 'gate';
    if (!hub) return gated ? deny('Murmur: this action needs a teammate approval and no hub is connected') : null;
    let r: any;
    try {
      r = await hub(`/api/lanes/${l.id}/pretool`, { tool, toolUseId: b.tool_use_id, input, capabilities: caps, target: t.paths[0] ?? null, paths: t.paths, gated, reason: `${tool}: ${caps.join(', ')}` }, HUB_MS);
    } catch (e: any) {
      if (e.status && e.status < 500) return deny(`Murmur: ${e.message}`);
      if (!gated) return null;
      const fd = failDecision(caps, l.failMode);
      return { decision: fd, reason: `Murmur hub unreachable; failing ${fd === 'allow' ? 'open' : 'closed'} for ${caps.join(', ')}` };
    }
    if (r?.decision === 'allow' || r?.decision === 'deny') return { decision: r.decision, reason: sanitize(r.reason ?? '') };
    if (r?.decision !== 'pending' || !r.approvalId) return null;
    const id = String(r.approvalId), hash = argsHash(tool, input);
    return new Promise<Decision>(res => {
      const timer = setTimeout(() => { pending.delete(id); res(deny(`Murmur: approval timed out after ${APPROVAL_MS / 1000} s`)); }, APPROVAL_MS);
      pending.set(id, { laneId: l.id, hash, done: x => { clearTimeout(timer); res(x); } });
    });
  }

  // approval.decided from the hub. Single use; a decision for other arguments is a deny.
  function decided(d: any) {
    const a = pending.get(d?.approvalId);
    if (!a || a.laneId !== d.laneId) return;
    pending.delete(d.approvalId);
    a.done(d.argsHash !== a.hash ? deny('Murmur: approval does not match these arguments')
      : { decision: d.decision === 'allow' ? 'allow' : 'deny', reason: sanitize(d.reason ?? `Murmur: ${d.decision === 'allow' ? 'approved' : 'denied'} by a teammate`) });
  }

  function close() {
    for (const a of pending.values()) a.done(deny('Murmur node shutting down'));
    pending.clear();
  }

  return { pretool, decided, close };
}
