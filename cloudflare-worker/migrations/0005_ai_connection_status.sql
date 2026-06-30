ALTER TABLE ai_settings ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'not_checked';
ALTER TABLE ai_settings ADD COLUMN connection_checked_at TEXT;
ALTER TABLE ai_settings ADD COLUMN connection_message TEXT;
