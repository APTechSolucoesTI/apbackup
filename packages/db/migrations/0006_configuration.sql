ALTER TABLE servers ADD COLUMN archived_at timestamptz;
ALTER TABLE resources ADD COLUMN archived_at timestamptz;
ALTER TABLE system_profiles ADD COLUMN archived_at timestamptz;
ALTER TABLE destinations ADD COLUMN archived_at timestamptz;
ALTER TABLE plans ADD COLUMN archived_at timestamptz;

-- A pending import must not invent a protocol or backup engine.
ALTER TABLE destinations ALTER COLUMN kind DROP NOT NULL;
ALTER TABLE repositories ALTER COLUMN engine DROP NOT NULL;
-- Preserve legacy destination IDs while introducing their still-unconfigured repository reference.
INSERT INTO repositories(organization_id,destination_id,external_identity,engine)
SELECT d.organization_id,d.id,'destination:'||d.id::text,NULL FROM destinations d
WHERE NOT EXISTS(SELECT 1 FROM repositories r WHERE r.organization_id=d.organization_id AND r.destination_id=d.id);
ALTER TABLE destinations DROP CONSTRAINT active_destination_configured;
ALTER TABLE destinations ADD CONSTRAINT active_destination_configured CHECK (
 status <> 'ativo' OR (kind IS NOT NULL AND nullif(trim(root_path),'') IS NOT NULL AND credential_id IS NOT NULL)
);
CREATE UNIQUE INDEX destinations_live_name_unique ON destinations(organization_id,lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX plans_live_name_unique ON plans(organization_id,server_id,lower(name)) WHERE archived_at IS NULL;
CREATE INDEX servers_live_idx ON servers(organization_id,created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX resources_live_idx ON resources(organization_id,server_id) WHERE archived_at IS NULL;
CREATE INDEX profiles_live_idx ON system_profiles(organization_id,server_id) WHERE archived_at IS NULL;
CREATE INDEX destinations_live_idx ON destinations(organization_id,created_at DESC) WHERE archived_at IS NULL;

CREATE FUNCTION reject_profile_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Profile versions are immutable; append a new version' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER profile_versions_immutable BEFORE UPDATE OR DELETE ON profile_versions FOR EACH ROW EXECUTE FUNCTION reject_profile_version_mutation();
CREATE TRIGGER profile_resources_immutable BEFORE UPDATE OR DELETE ON profile_resources FOR EACH ROW EXECUTE FUNCTION reject_profile_version_mutation();

ALTER TABLE executions ADD COLUMN profile_version_id uuid;
ALTER TABLE executions ADD CONSTRAINT executions_profile_version_fk FOREIGN KEY(organization_id,profile_version_id) REFERENCES profile_versions(organization_id,id);
CREATE INDEX executions_profile_version_idx ON executions(organization_id,profile_version_id);
-- Existing executions are intentionally not backfilled from mutable current plans.
CREATE FUNCTION pin_execution_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan_version uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.profile_version_id IS DISTINCT FROM OLD.profile_version_id THEN
   RAISE EXCEPTION 'Execution profile version is immutable' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.plan_id IS NOT NULL THEN
  SELECT profile_version_id INTO plan_version FROM plans WHERE organization_id=NEW.organization_id AND id=NEW.plan_id FOR SHARE;
  IF NEW.profile_version_id IS NULL THEN NEW.profile_version_id=plan_version;
  ELSIF NEW.profile_version_id IS DISTINCT FROM plan_version THEN
   RAISE EXCEPTION 'Execution must pin the selected plan version' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER executions_profile_version_pin BEFORE INSERT OR UPDATE OF profile_version_id ON executions FOR EACH ROW EXECUTE FUNCTION pin_execution_profile_version();
