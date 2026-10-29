-- Human restoration actors must remain attributable to an identity in this tenant.
-- Referenced memberships are historical records: hard deletion/key reassignment is
-- restricted. Revoking access belongs to authorization; it must preserve attribution.
ALTER TABLE restore_requests
  ADD CONSTRAINT restore_requests_requester_membership_fk
  FOREIGN KEY (organization_id, requested_by)
  REFERENCES organization_memberships (organization_id, user_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE restore_confirmations
  ADD CONSTRAINT restore_confirmations_actor_membership_fk
  FOREIGN KEY (organization_id, actor_id)
  REFERENCES organization_memberships (organization_id, user_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE operational_approvals
  ADD CONSTRAINT operational_approvals_actor_membership_fk
  FOREIGN KEY (organization_id, actor_id)
  REFERENCES organization_memberships (organization_id, user_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX restore_requests_requester_idx ON restore_requests (organization_id, requested_by);
CREATE INDEX restore_confirmations_actor_idx ON restore_confirmations (organization_id, actor_id);
CREATE INDEX operational_approvals_actor_idx ON operational_approvals (organization_id, actor_id);
