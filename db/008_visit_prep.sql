CREATE TABLE IF NOT EXISTS visit_prep_checks (
  inspection_id text NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  checked boolean NOT NULL DEFAULT false,
  updated_by text REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inspection_id, item_key)
);
