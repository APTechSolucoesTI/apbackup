-- Existing full-database bindings retain an empty schema scope.
ALTER TABLE postgresql_bindings ADD COLUMN schema_names text[] NOT NULL DEFAULT '{}';
DO $$ DECLARE constraint_name text; BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='postgresql_bindings'::regclass AND contype='u' LOOP
  EXECUTE format('ALTER TABLE postgresql_bindings DROP CONSTRAINT %I',constraint_name);
 END LOOP;
END $$;
ALTER TABLE postgresql_bindings ADD CONSTRAINT postgresql_binding_scope_unique UNIQUE(organization_id,connection_id,database_name,schema_names);
ALTER TABLE postgresql_bindings DROP CONSTRAINT postgresql_bindings_database_name_check;
ALTER TABLE postgresql_bindings ADD CONSTRAINT postgresql_binding_database_scope CHECK(database_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$' AND lower(database_name) NOT IN('template0','template1'));
CREATE TRIGGER immutable_dokploy_connection BEFORE UPDATE OR DELETE ON connections FOR EACH ROW WHEN (OLD.kind='dokploy') EXECUTE FUNCTION immutable_postgresql_configuration();
CREATE TABLE dokploy_native_runs (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,connection_id uuid NOT NULL,
 idempotency_key text NOT NULL,selection jsonb NOT NULL CHECK(platform_public_json_valid(selection)),
 provider_context jsonb NOT NULL CHECK(platform_public_json_valid(provider_context)),
 baseline jsonb NOT NULL CHECK(platform_public_json_valid(baseline)),
 status text NOT NULL CHECK(status IN('requested','accepted','artifact_observed','unknown')),
 artifacts jsonb NOT NULL DEFAULT '[]' CHECK(platform_public_json_valid(artifacts)),
 created_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz,
 UNIQUE(organization_id,idempotency_key),
 FOREIGN KEY(organization_id,connection_id) REFERENCES connections(organization_id,id)
);
CREATE UNIQUE INDEX dokploy_native_active_config ON dokploy_native_runs(organization_id,connection_id,(selection->>'kind'),(selection->>'configurationId')) WHERE status IN('requested','accepted','unknown');
CREATE INDEX dokploy_native_pending ON dokploy_native_runs(created_at) WHERE status IN('requested','accepted');
ALTER TABLE dokploy_native_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON dokploy_native_runs FROM PUBLIC;
COMMENT ON TABLE dokploy_native_runs IS 'Native provider observation only; never a verified recovery point. Unknown mutations are not replayed.';
