CREATE TABLE IF NOT EXISTS orphan_log (
    r2_key TEXT PRIMARY KEY,
    orphaned_at TEXT NOT NULL,
    reason TEXT NOT NULL
);
