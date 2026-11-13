-- Native sessions use a distinct m1_ token namespace, hashed in app_sessions like web sessions.
-- This short-lived proof is bound to the approving browser session and S256 PKCE verifier.
CREATE TABLE mobile_authorization_codes (
    code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
    source_session_id uuid NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    challenge varchar(43) NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
    state_hash bytea NOT NULL CHECK (octet_length(state_hash) = 32),
    platform varchar(7) NOT NULL CHECK (platform IN ('ios', 'android')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '2 minutes',
    consumed_at timestamptz,
    UNIQUE(source_session_id, state_hash),
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX mobile_authorization_codes_expiry_idx ON mobile_authorization_codes(expires_at);
