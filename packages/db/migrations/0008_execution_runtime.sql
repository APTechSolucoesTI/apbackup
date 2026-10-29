-- Durable control plane. Lease fences survive deletion/release through a global sequence.
CREATE SEQUENCE runtime_fencing_seq AS bigint;
CREATE TABLE execution_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
 execution_id uuid NOT NULL, state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','claimed','waiting','done')),
 worker_id text, holder uuid, claim_until timestamptz, heartbeat_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,execution_id),
 FOREIGN KEY(organization_id,execution_id) REFERENCES executions(organization_id,id)
);
CREATE INDEX execution_jobs_claim_idx ON execution_jobs(state,created_at);
CREATE TABLE resource_fences (
 organization_id uuid NOT NULL,resource_id uuid NOT NULL,highest bigint NOT NULL CHECK(highest>0),
 PRIMARY KEY(organization_id,resource_id), FOREIGN KEY(organization_id,resource_id) REFERENCES resources(organization_id,id)
);
ALTER TABLE execution_events ADD COLUMN sequence bigint;
ALTER TABLE execution_events ADD COLUMN source_key text;
WITH numbered AS(SELECT id,row_number() OVER(PARTITION BY execution_id ORDER BY created_at,id) n FROM execution_events)
UPDATE execution_events e SET sequence=n.n,source_key=e.id::text FROM numbered n WHERE n.id=e.id;
ALTER TABLE execution_events ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE execution_events ALTER COLUMN source_key SET NOT NULL;
CREATE FUNCTION sequence_runtime_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM executions WHERE organization_id=NEW.organization_id AND id=NEW.execution_id FOR UPDATE;
 IF NEW.sequence IS NULL THEN SELECT coalesce(max(sequence),0)+1 INTO NEW.sequence FROM execution_events WHERE organization_id=NEW.organization_id AND execution_id=NEW.execution_id; END IF;
 IF NEW.source_key IS NULL THEN NEW.source_key=NEW.id::text; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sequence_runtime_event BEFORE INSERT ON execution_events FOR EACH ROW EXECUTE FUNCTION sequence_runtime_event();
CREATE UNIQUE INDEX execution_events_sequence_unique ON execution_events(organization_id,execution_id,sequence);
CREATE UNIQUE INDEX execution_events_source_unique ON execution_events(organization_id,execution_id,source_key);
CREATE FUNCTION immutable_runtime_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Execution events are append-only'; END $$;
CREATE TRIGGER immutable_runtime_event BEFORE UPDATE OR DELETE ON execution_events FOR EACH ROW EXECUTE FUNCTION immutable_runtime_event();
CREATE TABLE agent_enrollments (
 digest text PRIMARY KEY,organization_id uuid NOT NULL,server_id uuid NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz,
 FOREIGN KEY(organization_id,server_id) REFERENCES servers(organization_id,id)
);
ALTER TABLE agents ADD COLUMN identity_digest text UNIQUE;
CREATE TABLE agent_commands (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,execution_id uuid NOT NULL,agent_id uuid NOT NULL,resource_id uuid NOT NULL,profile_version_id uuid NOT NULL,
 fencing_token bigint NOT NULL CHECK(fencing_token>0),body jsonb NOT NULL CHECK(platform_public_json_valid(body)),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','delivered','completed','unknown')),
 result jsonb CHECK(result IS NULL OR platform_public_json_valid(result)),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,execution_id) REFERENCES executions(organization_id,id),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents(organization_id,id),
 FOREIGN KEY(organization_id,resource_id) REFERENCES resources(organization_id,id),
 FOREIGN KEY(organization_id,profile_version_id) REFERENCES profile_versions(organization_id,id),
 UNIQUE(organization_id,execution_id,resource_id)
);
CREATE INDEX agent_commands_poll_idx ON agent_commands(agent_id,state,created_at);
-- These tables are server-only; no browser/database role receives privileges.
REVOKE ALL ON execution_jobs,resource_fences,agent_enrollments,agent_commands FROM PUBLIC;
