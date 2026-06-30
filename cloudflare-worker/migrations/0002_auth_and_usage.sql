CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  quota_daily INTEGER NOT NULL DEFAULT 200,
  quota_minute INTEGER NOT NULL DEFAULT 20
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'Chrome extension',
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  token_id INTEGER,
  scope TEXT NOT NULL DEFAULT 'panel',
  mode TEXT NOT NULL DEFAULT 'grammar',
  input_length INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (token_id) REFERENCES api_tokens(id)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  admin_email TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash
  ON api_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user_status
  ON api_tokens(user_id, status);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
  ON usage_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_token_created
  ON usage_events(token_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_hash
  ON admin_sessions(session_hash);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
  ON admin_sessions(expires_at);
