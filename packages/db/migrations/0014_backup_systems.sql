-- Product folders reference existing plans; no backups or schedules are activated here.
ALTER TABLE plans ADD CONSTRAINT plans_org_server_id_unique UNIQUE(organization_id,server_id,id);
CREATE TABLE backup_systems (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, server_id uuid NOT NULL,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
 scope_notes text NOT NULL DEFAULT '' CHECK(length(scope_notes)<=4000), sort_order integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,server_id,id), UNIQUE(organization_id,server_id,name),
 FOREIGN KEY(organization_id,server_id) REFERENCES servers(organization_id,id)
);
CREATE TABLE system_plan_links (
 organization_id uuid NOT NULL, server_id uuid NOT NULL, system_id uuid NOT NULL, plan_id uuid NOT NULL,
 component_kind text NOT NULL CHECK(component_kind IN ('application','database','files')),
 label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 160),
 scope_note text NOT NULL DEFAULT '' CHECK(length(scope_note)<=2000), shared boolean NOT NULL DEFAULT false,
 PRIMARY KEY(organization_id,system_id,plan_id,component_kind),
 FOREIGN KEY(organization_id,server_id,system_id) REFERENCES backup_systems(organization_id,server_id,id),
 FOREIGN KEY(organization_id,server_id,plan_id) REFERENCES plans(organization_id,server_id,id)
);
CREATE INDEX system_plan_links_plan_idx ON system_plan_links(organization_id,plan_id);
CREATE TABLE backup_system_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, system_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 100),
 plan_ids uuid[] NOT NULL CHECK(cardinality(plan_ids)>0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,system_id,idempotency_key),
 FOREIGN KEY(organization_id,system_id) REFERENCES backup_systems(organization_id,id)
);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON backup_systems FOR EACH ROW EXECUTE FUNCTION platform_touch_updated_at();
ALTER TABLE backup_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_plan_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_system_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON backup_systems,system_plan_links,backup_system_runs FROM PUBLIC;
COMMENT ON TABLE backup_systems IS 'Server-only, organization-scoped product folders. Authenticated API enforces read/configure permissions; no public Data API access.';
COMMENT ON TABLE backup_system_runs IS 'Atomic manual batch snapshot. Reusing a request cannot enqueue newly linked plans.';
