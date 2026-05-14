CREATE TABLE IF NOT EXISTS grammar_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  mode TEXT NOT NULL,
  language TEXT NOT NULL,
  page_url TEXT,
  input_length INTEGER NOT NULL DEFAULT 0,
  corrected_length INTEGER NOT NULL DEFAULT 0,
  suggestion_count INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  input_preview TEXT,
  corrected_preview TEXT
);

CREATE INDEX IF NOT EXISTS idx_grammar_checks_created_at
  ON grammar_checks(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_grammar_checks_success
  ON grammar_checks(success, created_at DESC);
