// Input validators and row mapping shared by the hub core and its HTTP adapter.
import { sanitize, safeRelPath } from '../shared.ts';

export const fail = (status: number, error: string, current?: unknown): never => { throw Object.assign(new Error(error), { status, current }); };
export const ROLES = ['viewer', 'commenter', 'editor', 'owner'];

export function str(v: unknown, max: number, name: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(400, `${name} must be a non-empty string (≤${max})`);
  return v as string;
}
export const optStr = (v: unknown, max: number, name: string) => (v == null || v === '' ? undefined : str(v, max, name));
export function oneOf<T extends string>(v: unknown, list: readonly T[], name: string): T {
  if (!list.includes(v as T)) fail(400, `${name} must be one of ${list.join('|')}`);
  return v as T;
}
export function int(v: unknown, name: string): number {
  if (!Number.isSafeInteger(v)) fail(400, `${name} must be an integer`);
  return v as number;
}
export function paths(v: unknown, max = 200): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) fail(400, `paths must be an array (≤${max})`);
  return (v as unknown[]).map(p => safeRelPath(p) ?? fail(400, `bad path: ${sanitize(p, 100)}`));
}
const camelKey = (k: string) => k.replace(/_(\w)/g, (_, c) => c.toUpperCase());
export const camel = (r: any) => r && Object.fromEntries(Object.entries(r).map(([k, v]) => [camelKey(k), v]));
