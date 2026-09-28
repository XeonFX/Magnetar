-- Accounts are Google identities; sessions and device tokens are stored only as SHA-256 hashes.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  online INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX devices_user ON devices(user_id);

-- A pairing lives ten minutes. The device token sits here only until the device collects it.
CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  poll_secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT,
  device_token TEXT
);
