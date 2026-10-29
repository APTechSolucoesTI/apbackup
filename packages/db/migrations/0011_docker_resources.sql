-- R2: agent-owned discovery, immutable resource bindings, existing queue and Restic evidence.
CREATE TABLE docker_catalogs (
 organization_id uuid NOT NULL,agent_id uuid NOT NULL,server_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(platform_public_json_valid(body)), received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,agent_id),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents(organization_id,id),
 FOREIGN KEY(organization_id,server_id) REFERENCES servers(organization_id,id)
);
CREATE TABLE docker_bindings (
 organization_id uuid NOT NULL,profile_version_id uuid NOT NULL,resource_id uuid NOT NULL,server_id uuid NOT NULL,
 selection jsonb NOT NULL CHECK(platform_public_json_valid(selection)),
 PRIMARY KEY(organization_id,profile_version_id),
 UNIQUE(organization_id,server_id,selection),
 FOREIGN KEY(organization_id,profile_version_id) REFERENCES profile_versions(organization_id,id),
 FOREIGN KEY(organization_id,resource_id) REFERENCES resources(organization_id,id),
 FOREIGN KEY(organization_id,server_id) REFERENCES servers(organization_id,id)
);
CREATE TRIGGER immutable_docker_binding BEFORE UPDATE OR DELETE ON docker_bindings FOR EACH ROW EXECUTE FUNCTION immutable_postgresql_configuration();
ALTER TABLE destination_results ADD COLUMN docker_evidence jsonb CHECK(docker_evidence IS NULL OR platform_public_json_valid(docker_evidence));
ALTER TABLE docker_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE docker_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON docker_catalogs,docker_bindings FROM PUBLIC;
CREATE INDEX docker_catalog_server ON docker_catalogs(organization_id,server_id,received_at DESC);
COMMENT ON TABLE docker_catalogs IS 'Server-only authenticated agent metadata; no environment, secrets or daemon host paths. Queries tenant-scoped.';
COMMENT ON TABLE docker_bindings IS 'Immutable selected resource identity. Application restore excludes all database operations.';
