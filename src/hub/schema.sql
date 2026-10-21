-- Murmur hub schema (architecture.md §3). Applied idempotently at startup.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS web_session (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS device (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  last_seen_at INTEGER, revoked_at INTEGER, claude_json TEXT);
CREATE TABLE IF NOT EXISTS device_code (device_code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  user_id TEXT, device_id TEXT, token TEXT, expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, git_remote TEXT NOT NULL,
  lease_policy TEXT NOT NULL DEFAULT 'warn' CHECK (lease_policy IN ('warn','enforce')),
  fail_mode_json TEXT NOT NULL DEFAULT '{"push":"closed","external":"closed","network":"closed","commit":"open","files":"open"}',
  require_second_person INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS member (workspace_id TEXT NOT NULL REFERENCES workspace(id), user_id TEXT NOT NULL REFERENCES user(id),
  role TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor','owner')), PRIMARY KEY (workspace_id, user_id));
CREATE TABLE IF NOT EXISTS invite (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, used_by TEXT);
CREATE TABLE IF NOT EXISTS binding (workspace_id TEXT NOT NULL REFERENCES workspace(id), device_id TEXT NOT NULL REFERENCES device(id),
  clone_path TEXT NOT NULL, verified_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, device_id));

CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), title TEXT NOT NULL,
  base_commit TEXT, branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','archived')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lane (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), owner_user_id TEXT NOT NULL,
  device_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude', mode TEXT NOT NULL CHECK (mode IN ('plan','request','allow','full')),
  status TEXT NOT NULL DEFAULT 'starting', status_reason TEXT, claude_session_id TEXT, snapshot_ref TEXT, snapshot_commit TEXT, snapshot_at INTEGER,
  handoff_brief TEXT, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, integrate_pending INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS plan_step (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), ord INTEGER NOT NULL,
  text TEXT NOT NULL, paths_json TEXT NOT NULL DEFAULT '[]', owner_lane_id TEXT,
  status TEXT NOT NULL DEFAULT 'unstarted' CHECK (status IN ('unstarted','ready','in_progress','done','blocked')), note TEXT,
  version INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS task (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '', paths_json TEXT NOT NULL DEFAULT '[]', acceptance TEXT NOT NULL DEFAULT '',
  col TEXT NOT NULL DEFAULT 'backlog' CHECK (col IN ('backlog','ready','in_progress','review','done')),
  assignee_user_id TEXT, claimed_by_lane_id TEXT, session_id TEXT, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS lease (workspace_id TEXT NOT NULL, path TEXT NOT NULL, lane_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, path));
CREATE TABLE IF NOT EXISTS lane_dirty (lane_id TEXT NOT NULL, path TEXT NOT NULL, added INTEGER NOT NULL, removed INTEGER NOT NULL,
  blob_sha TEXT, patch TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (lane_id, path));
CREATE TABLE IF NOT EXISTS conflict (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, lane_a TEXT NOT NULL, lane_b TEXT NOT NULL,
  ref_a TEXT, ref_b TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')), resolution TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS approval (id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, tool TEXT NOT NULL, target TEXT NOT NULL,
  capabilities_json TEXT NOT NULL, args_hash TEXT NOT NULL, reason TEXT, idem_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','allowed','denied','expired')),
  decided_by TEXT, decided_at INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rule (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL, path_glob TEXT NOT NULL DEFAULT '*',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT, from_lane_id TEXT, from_user_id TEXT,
  to_kind TEXT NOT NULL CHECK (to_kind IN ('lane','session','user','broadcast')), to_id TEXT, body TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS message_delivery (message_id TEXT NOT NULL, lane_id TEXT NOT NULL, delivered_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, lane_id));

CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, session_id TEXT, body TEXT NOT NULL,
  created_by_lane TEXT, created_by_user TEXT, pinned INTEGER NOT NULL DEFAULT 0, retired_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_ref (memory_id INTEGER NOT NULL REFERENCES memory(id), path TEXT NOT NULL, blob_sha TEXT, PRIMARY KEY (memory_id, path));
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(body, content='memory', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN INSERT INTO memory_fts(rowid, body) VALUES (new.id, new.body); END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF body ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, body) VALUES ('delete', old.id, old.body); INSERT INTO memory_fts(rowid, body) VALUES (new.id, new.body); END;

CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, session_id TEXT, lane_id TEXT,
  type TEXT NOT NULL, payload_json TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS event_ws ON event(workspace_id, seq);
