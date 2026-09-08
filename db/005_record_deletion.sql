ALTER TABLE users ADD COLUMN department text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN job_title text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users ADD COLUMN deleted_by text REFERENCES users(id);
ALTER TABLE users ADD CONSTRAINT deleted_users_inactive CHECK (deleted_at IS NULL OR active=false);

ALTER TABLE inspections ADD COLUMN deleted_at timestamptz;
ALTER TABLE inspections ADD COLUMN deleted_by text REFERENCES users(id);
CREATE INDEX inspections_deleted_at_idx ON inspections(deleted_at) WHERE deleted_at IS NOT NULL;
