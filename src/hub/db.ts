import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ':memory:' gives a throwaway db for in-process tests.
export function openDb(dataDir: string) {
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dataDir === ':memory:' ? dataDir : join(dataDir, 'hub.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  // Columns added after release: CREATE TABLE IF NOT EXISTS leaves older dbs without them.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('lane') WHERE name='integrate_pending'`).get()) db.exec('ALTER TABLE lane ADD COLUMN integrate_pending INTEGER NOT NULL DEFAULT 0');
  return db;
}

// One writer process: BEGIN IMMEDIATE makes every CAS read+write atomic. Re-entrant.
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Cached prepared statements; undefined params become NULL.
export function q(db: DatabaseSync) {
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const st = (sql: string) => { let s = cache.get(sql); if (!s) cache.set(sql, s = db.prepare(sql)); return s; };
  const p = (a: unknown[]) => a.map(x => (x === undefined ? null : typeof x === 'boolean' ? Number(x) : x)) as SQLInputValue[];
  return {
    get: (sql: string, ...a: unknown[]): any => st(sql).get(...p(a)),
    all: (sql: string, ...a: unknown[]): any[] => st(sql).all(...p(a)),
    run: (sql: string, ...a: unknown[]) => st(sql).run(...p(a)),
  };
}
