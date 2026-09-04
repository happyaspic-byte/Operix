CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','manager','engineer','sales','viewer')),
 password_hash text NOT NULL, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS login_attempts (id text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS customers (
 id text PRIMARY KEY, name text NOT NULL, industry text NOT NULL DEFAULT '', contact_name text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sites (
 id text PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id), name text NOT NULL, address text NOT NULL DEFAULT '', contact_name text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id,name)
);
CREATE TABLE IF NOT EXISTS assets (
 id text PRIMARY KEY, site_id text NOT NULL REFERENCES sites(id), name text NOT NULL, asset_tag text, product text NOT NULL CHECK(product IN ('everRun','ztC Endurance','ztC Edge','Server','Network','Storage')), model text NOT NULL DEFAULT '', software_version text NOT NULL DEFAULT '', serial text NOT NULL DEFAULT '', protection text NOT NULL DEFAULT 'unknown' CHECK(protection IN ('FT','HA','unknown','none')),
 status text NOT NULL DEFAULT 'unknown' CHECK(status IN ('normal','warning','critical','unknown','archived')), owner_id text REFERENCES users(id), management_ip text NOT NULL DEFAULT '', network_notes text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', observed_at date,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_tag_unique ON assets(lower(asset_tag)) WHERE asset_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_site_idx ON assets(site_id);
CREATE TABLE IF NOT EXISTS components (
 id text PRIMARY KEY, asset_id text NOT NULL REFERENCES assets(id), name text NOT NULL, role text NOT NULL DEFAULT '', model text NOT NULL DEFAULT '', serial text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'unknown', notes text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(asset_id,name)
);
CREATE TABLE IF NOT EXISTS vms (
 id text PRIMARY KEY, asset_id text NOT NULL REFERENCES assets(id), name text NOT NULL, purpose text NOT NULL DEFAULT '', os text NOT NULL DEFAULT '', vcpu integer NOT NULL DEFAULT 1 CHECK(vcpu>0), memory_gb integer NOT NULL DEFAULT 1 CHECK(memory_gb>0), disk_gb integer NOT NULL DEFAULT 1 CHECK(disk_gb>0), protection text NOT NULL DEFAULT 'unknown', notes text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(asset_id,name)
);
CREATE TABLE IF NOT EXISTS contracts (
 id text PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id), name text NOT NULL, kind text NOT NULL CHECK(kind IN ('maintenance','vendor_support','license')), counterparty text NOT NULL DEFAULT '', start_date date, end_date date, term text NOT NULL CHECK(term IN ('dated','perpetual','unknown')), renewal text NOT NULL DEFAULT 'not_started' CHECK(renewal IN ('not_started','contacted','quoted','renewed','ended')), owner_id text REFERENCES users(id), amount numeric(15,0), notes text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(term <> 'dated' OR end_date IS NOT NULL), CHECK(start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);
CREATE TABLE IF NOT EXISTS contract_assets (contract_id text NOT NULL REFERENCES contracts(id), asset_id text NOT NULL REFERENCES assets(id), PRIMARY KEY(contract_id,asset_id));
CREATE TABLE IF NOT EXISTS maintenance_plans (
 id text PRIMARY KEY, asset_id text NOT NULL REFERENCES assets(id), name text NOT NULL, start_date date NOT NULL, interval_months integer NOT NULL CHECK(interval_months IN (1,3,6,12)), next_index integer NOT NULL DEFAULT 0, assignee_id text REFERENCES users(id), checklist jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inspections (
 id text PRIMARY KEY, asset_id text NOT NULL REFERENCES assets(id), plan_id text REFERENCES maintenance_plans(id), name text NOT NULL, planned_date date NOT NULL, assignee_id text REFERENCES users(id), status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','in_progress','completed','cancelled')), checklist jsonb NOT NULL DEFAULT '[]', result text NOT NULL DEFAULT '', follow_up text NOT NULL DEFAULT '', completed_at timestamptz,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(plan_id,planned_date)
);
CREATE INDEX IF NOT EXISTS inspections_date_idx ON inspections(planned_date);
CREATE TABLE IF NOT EXISTS tickets (
 id text PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id), name text NOT NULL, severity text NOT NULL DEFAULT 'medium' CHECK(severity IN ('critical','high','medium','low')), status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting','resolved','closed')), assignee_id text REFERENCES users(id), description text NOT NULL DEFAULT '', vendor_case text NOT NULL DEFAULT '', resolution text NOT NULL DEFAULT '', evidence_level text NOT NULL DEFAULT 'observed' CHECK(evidence_level IN ('observed','internal','vendor')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ticket_assets (ticket_id text NOT NULL REFERENCES tickets(id), asset_id text NOT NULL REFERENCES assets(id), PRIMARY KEY(ticket_id,asset_id));
CREATE TABLE IF NOT EXISTS entries (
 id text PRIMARY KEY, entity_kind text NOT NULL CHECK(entity_kind IN ('inspections','tickets')), entity_id text NOT NULL, user_id text NOT NULL REFERENCES users(id), body text NOT NULL, evidence_level text NOT NULL CHECK(evidence_level IN ('observed','internal','vendor')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS documents (
 id text PRIMARY KEY, entity_kind text NOT NULL, entity_id text NOT NULL, name text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL, storage_key text NOT NULL UNIQUE, uploaded_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
 id text PRIMARY KEY, entity_kind text NOT NULL CHECK(entity_kind IN ('inspections','tickets')), entity_id text NOT NULL, revision integer NOT NULL, title text NOT NULL, snapshot jsonb NOT NULL, approved_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(entity_kind,entity_id,revision)
);
CREATE TABLE IF NOT EXISTS notifications (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), source_kind text NOT NULL, source_id text NOT NULL, fingerprint text NOT NULL, title text NOT NULL, body text NOT NULL, href text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id text PRIMARY KEY, user_id text REFERENCES users(id), action text NOT NULL, entity_kind text NOT NULL, entity_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_logs(entity_kind,entity_id,created_at);
CREATE TABLE IF NOT EXISTS import_batches (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), payload jsonb NOT NULL, committed_at timestamptz, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS job_runs (id text PRIMARY KEY, last_success timestamptz, last_error text, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO job_runs(id) VALUES ('scheduler') ON CONFLICT DO NOTHING;
