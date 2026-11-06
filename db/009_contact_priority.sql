ALTER TABLE customer_contacts ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
ALTER TABLE customer_contacts ADD COLUMN IF NOT EXISTS contact_priority smallint;
ALTER TABLE customer_contacts ADD COLUMN IF NOT EXISTS left_at date;
ALTER TABLE customer_contacts ADD COLUMN IF NOT EXISTS job_title text;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_one_active_primary_idx ON customer_contacts(customer_id) WHERE is_primary AND status='active';
