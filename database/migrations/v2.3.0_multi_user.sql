-- Multi-user account isolation
-- owner_id on files; users table for D1-native storage (userStore also supports settings-key fallback)

-- files.owner_id: nullable; NULL = unowned / admin / legacy (admin-only in list)
ALTER TABLE files ADD COLUMN owner_id TEXT;

CREATE INDEX IF NOT EXISTS idx_files_owner_id ON files(owner_id);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    disabled INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_disabled ON users(disabled);

CREATE TRIGGER IF NOT EXISTS update_users_updated_at
    AFTER UPDATE ON users
    BEGIN
        UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
