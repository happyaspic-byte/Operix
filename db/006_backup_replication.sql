ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS replicated_at timestamptz;
CREATE INDEX IF NOT EXISTS backup_runs_replication ON backup_runs(replicated_at DESC) WHERE status='completed' AND encrypted=true;
