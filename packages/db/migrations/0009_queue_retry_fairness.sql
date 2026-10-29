-- Blocked resources must not consume every coordinator poll.
ALTER TABLE execution_jobs ADD COLUMN retry_after timestamptz DEFAULT '-infinity'::timestamptz;
ALTER TABLE execution_jobs ADD COLUMN dispatch_attempts integer NOT NULL DEFAULT 0 CHECK(dispatch_attempts>=0);
ALTER TABLE execution_jobs ADD COLUMN blocked_reason text CHECK(blocked_reason IN('resource_busy','effect_unknown','dispatch_failed'));
CREATE INDEX execution_jobs_retry_idx ON execution_jobs(retry_after,created_at,id) WHERE state='ready';
COMMENT ON COLUMN execution_jobs.retry_after IS 'Ready jobs cannot be claimed before this instant. NULL on parked reconciliation jobs.';
