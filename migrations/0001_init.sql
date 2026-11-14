-- Times are milliseconds since the epoch.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  lang TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  UNIQUE (provider, subject)
);

-- id is the SHA-256 of the cookie value, so a database leak gives no usable session.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- pattern is an email domain (school.be) or one address (a@b.be), lowercase.
CREATE TABLE allowed (
  pattern TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  uses_left INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL UNIQUE,
  shared INTEGER NOT NULL DEFAULT 0,
  copied_from TEXT,
  rev_seq INTEGER NOT NULL DEFAULT 0,
  snapshot_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX projects_owner ON projects (owner_id);

CREATE TABLE old_names (
  name TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  until INTEGER NOT NULL
);

-- kind is 'file' or 'folder'. A folder has an empty hash and size 0.
CREATE TABLE files (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, path)
);

-- manifest is a JSON list of {path, kind, hash, size}.
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  manifest TEXT NOT NULL
);
CREATE INDEX snapshots_project ON snapshots (project_id, created_at);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  handled_at INTEGER
);

-- Rate-limit counters. bucket is "<kind>:<window start>".
CREATE TABLE counters (
  user_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, bucket)
);
