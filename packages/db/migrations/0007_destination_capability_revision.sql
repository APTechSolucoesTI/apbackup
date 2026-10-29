-- Assessments prove one exact destination configuration, never later connection changes.
ALTER TABLE destinations ADD COLUMN configuration_revision integer NOT NULL DEFAULT 1 CHECK(configuration_revision>0);
ALTER TABLE connector_capabilities ADD COLUMN configuration_revision integer NOT NULL DEFAULT 1 CHECK(configuration_revision>0);
ALTER TABLE connector_capabilities DROP CONSTRAINT connector_capabilities_organization_id_destination_id_connector_version_unique;
ALTER TABLE connector_capabilities ADD CONSTRAINT connector_capabilities_revision_unique UNIQUE(organization_id,destination_id,connector_version,configuration_revision);
CREATE FUNCTION bump_destination_configuration_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.kind,NEW.host,NEW.root_path,NEW.credential_id) IS DISTINCT FROM ROW(OLD.kind,OLD.host,OLD.root_path,OLD.credential_id) THEN
  NEW.configuration_revision=OLD.configuration_revision+1;
 ELSE NEW.configuration_revision=GREATEST(OLD.configuration_revision,NEW.configuration_revision);
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER destination_configuration_revision BEFORE UPDATE ON destinations FOR EACH ROW EXECUTE FUNCTION bump_destination_configuration_revision();
-- Engine is configured together with protocol/path by the service; direct engine changes need invalidation too.
CREATE FUNCTION bump_destination_engine_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.engine IS DISTINCT FROM OLD.engine THEN
  UPDATE destinations SET configuration_revision=configuration_revision+1 WHERE organization_id=NEW.organization_id AND id=NEW.destination_id;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER repository_engine_revision AFTER UPDATE OF engine ON repositories FOR EACH ROW EXECUTE FUNCTION bump_destination_engine_revision();
