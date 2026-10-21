// One authorization policy. Each route declares a Rule; authorize() is the only place that decides.
// Order: device principal, then resource (404), then login (401), membership and role (403), then lane checks.
import { ROLES, fail } from './check.ts';
import type { Kind } from './coord.ts';

export type Rule = {
  who: 'anyone' | 'user' | 'device'; // device = bearer token: the only routes a device may call
  role?: string;                      // minimum workspace role of the (device's) user
  on?: Kind;                          // resource the route acts on; its workspace is the one checked
  lane?: 'owner' | 'owner+ws' | 'device'; // lane owner (or a workspace owner), or the lane's own device
  csrf?: false;                       // cookie-less CLI routes exempt from the CSRF header
};
export type Who = { user?: { id: string; name: string }; device?: { id: string; user_id: string } };
type Look = { scope: (k: Kind, id: unknown) => { row: any; ws: string }; roleOf: (userId: string, ws: string) => string | undefined };

export function authorize(look: Look, rule: Rule, p: Who, id?: unknown): { row?: any; ws?: string; role?: string } {
  if (rule.who === 'device' && !p.device) fail(401, 'device token required');
  const me = () => p.user ?? fail(401, 'login required');
  if (!rule.on) { if (rule.who === 'user') me(); return {}; }
  const { row, ws } = look.scope(rule.on, id);
  let role: string | undefined;
  if (rule.role) {
    role = look.roleOf(me().id, ws) ?? fail(403, 'not a member of this workspace');
    if (ROLES.indexOf(role) < ROLES.indexOf(rule.role)) fail(403, `${rule.role} role required`);
  }
  if (rule.lane) {
    if (p.device && row.device_id !== p.device.id) fail(403, 'lane is not on this device');
    if (rule.lane !== 'device' && row.owner_user_id !== me().id && !(rule.lane === 'owner+ws' && role === 'owner')) fail(403, 'only the lane owner can do this');
  }
  return { row, ws, role };
}
