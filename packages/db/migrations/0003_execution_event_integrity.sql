-- A step-scoped event belongs to this exact execution, not merely the same tenant.
ALTER TABLE execution_steps
  ADD CONSTRAINT execution_steps_execution_identity_unique
  UNIQUE (organization_id, execution_id, id);
ALTER TABLE execution_events
  DROP CONSTRAINT execution_events_organization_id_step_id_execution_steps_organi;
ALTER TABLE execution_events
  ADD CONSTRAINT execution_events_execution_step_fk
  FOREIGN KEY (organization_id, execution_id, step_id)
  REFERENCES execution_steps (organization_id, execution_id, id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX execution_events_step_idx ON execution_events (organization_id, execution_id, step_id);
