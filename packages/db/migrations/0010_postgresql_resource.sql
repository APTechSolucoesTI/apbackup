-- R1: one database, existing catalog and durable execution queue.
ALTER TYPE destination_kind ADD VALUE IF NOT EXISTS 'local';
ALTER TABLE connections ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(platform_public_json_valid(configuration));
ALTER TABLE repositories ADD COLUMN native_repository_id text CHECK(native_repository_id IS NULL OR native_repository_id ~ '^[a-f0-9]{64}$');
ALTER TABLE destination_results ADD COLUMN postgresql_evidence jsonb CHECK(postgresql_evidence IS NULL OR platform_public_json_valid(postgresql_evidence));
CREATE TABLE postgresql_bindings (
 organization_id uuid NOT NULL,profile_version_id uuid NOT NULL,resource_id uuid NOT NULL,
 connection_id uuid NOT NULL,database_name text NOT NULL CHECK(database_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$' AND lower(database_name) NOT IN('postgres','template0','template1')),
 PRIMARY KEY(organization_id,profile_version_id),UNIQUE(organization_id,connection_id,database_name),
 FOREIGN KEY(organization_id,profile_version_id) REFERENCES profile_versions(organization_id,id),
 FOREIGN KEY(organization_id,resource_id) REFERENCES resources(organization_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES connections(organization_id,id)
);
CREATE FUNCTION immutable_postgresql_configuration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PostgreSQL history is immutable; create a new connection or version'; END $$;
CREATE TRIGGER immutable_postgresql_binding BEFORE UPDATE OR DELETE ON postgresql_bindings FOR EACH ROW EXECUTE FUNCTION immutable_postgresql_configuration();
CREATE TRIGGER immutable_postgresql_connection BEFORE UPDATE OR DELETE ON connections FOR EACH ROW WHEN (OLD.kind='postgresql') EXECUTE FUNCTION immutable_postgresql_configuration();
CREATE UNIQUE INDEX one_point_per_execution ON recovery_points(organization_id,execution_id);
ALTER TABLE postgresql_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON postgresql_bindings FROM PUBLIC;
COMMENT ON TABLE postgresql_bindings IS 'Server-only, immutable database identity per profile version. Catalog service authorization scopes every query by organization.';
