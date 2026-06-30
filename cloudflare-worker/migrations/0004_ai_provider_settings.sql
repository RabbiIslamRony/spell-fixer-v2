CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL DEFAULT 'openai',
  api_url TEXT,
  model TEXT,
  api_key_ciphertext TEXT
);

INSERT OR IGNORE INTO ai_settings (id, provider, api_url, model)
VALUES (1, 'openai', 'https://api.openai.com/v1/chat/completions', 'gpt-4.1-mini');
