ALTER TABLE destinations ADD COLUMN configuration jsonb;
ALTER TABLE destination_results ADD COLUMN removed_at timestamptz;
ALTER TABLE destination_results ADD COLUMN retention_pending boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION bump_destination_configuration_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.kind,NEW.host,NEW.root_path,NEW.credential_id,NEW.configuration) IS DISTINCT FROM ROW(OLD.kind,OLD.host,OLD.root_path,OLD.credential_id,OLD.configuration) THEN NEW.configuration_revision=OLD.configuration_revision+1;
 ELSE NEW.configuration_revision=GREATEST(OLD.configuration_revision,NEW.configuration_revision); END IF;
 RETURN NEW;
END $$;
CREATE TABLE repository_tasks (
 organization_id uuid NOT NULL, execution_id uuid NOT NULL, scope jsonb NOT NULL CHECK(platform_public_json_valid(scope)), decisions jsonb CHECK(decisions IS NULL OR platform_public_json_valid(decisions)),
 PRIMARY KEY(organization_id,execution_id),
 FOREIGN KEY(organization_id,execution_id) REFERENCES executions(organization_id,id)
);
ALTER TABLE repository_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON repository_tasks FROM PUBLIC;
CREATE INDEX destination_results_available_idx ON destination_results(organization_id,repository_id,recovery_point_id) WHERE removed_at IS NULL AND NOT retention_pending;
