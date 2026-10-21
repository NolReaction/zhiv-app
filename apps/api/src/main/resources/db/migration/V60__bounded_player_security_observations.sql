-- Fixed three aggregates per account, not a per-request event log.
ALTER TABLE app_users ADD COLUMN security_signal_at timestamptz;

CREATE TABLE player_security_observations (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    code text NOT NULL CHECK (code IN ('ECONOMY_REQUEST_TAMPER','MARKET_OWNERSHIP_DENIED','BARTER_OWNERSHIP_DENIED')),
    total_count bigint NOT NULL CHECK (total_count BETWEEN 1 AND 9007199254740991),
    pending_count bigint NOT NULL CHECK (pending_count BETWEEN 0 AND total_count),
    first_at timestamptz NOT NULL,
    last_at timestamptz NOT NULL CHECK (last_at >= first_at),
    window_started_at timestamptz NOT NULL,
    activated_at timestamptz,
    reviewed_at timestamptz,
    last_action text NOT NULL CHECK (length(last_action) BETWEEN 1 AND 80 AND last_action ~ '^[a-z_]+:[a-z_]+$'),
    last_request_id uuid NOT NULL,
    recent_request_ids uuid[] NOT NULL CHECK (cardinality(recent_request_ids) BETWEEN 1 AND 16 AND array_ndims(recent_request_ids)=1),
    PRIMARY KEY (user_id,code)
);

CREATE INDEX app_users_security_review_idx ON app_users(security_signal_at DESC) WHERE deleted_at IS NULL AND security_signal_at IS NOT NULL;
