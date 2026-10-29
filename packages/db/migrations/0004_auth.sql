ALTER TABLE users ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE organization_memberships ADD COLUMN revoked_at timestamptz;
CREATE TABLE auth_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 ip_address text, user_agent text, reauthenticated_at timestamptz, mfa_verified_at timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE auth_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 account_id text NOT NULL, provider_id text NOT NULL, password text,
 access_token text, refresh_token text, id_token text,
 access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider_id, account_id)
);
CREATE INDEX auth_accounts_user_idx ON auth_accounts(user_id);
CREATE TABLE auth_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);
CREATE TABLE auth_two_factors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 secret text NOT NULL, backup_codes text NOT NULL, verified boolean NOT NULL DEFAULT false,
 failed_verification_count integer NOT NULL DEFAULT 0, locked_until timestamptz
);
CREATE TABLE auth_rate_limits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE, count integer NOT NULL, last_request bigint NOT NULL
);
-- Private catalog: no browser/Data API role has access. Server enforces tenant permissions.
REVOKE ALL ON auth_sessions,auth_accounts,auth_verifications,auth_two_factors,auth_rate_limits FROM PUBLIC;
