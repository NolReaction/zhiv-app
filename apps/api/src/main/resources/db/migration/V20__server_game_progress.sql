-- Only server-accepted batches contribute to these counters. Legacy local totals
-- and diagnostic /game-events payloads are deliberately not imported.
CREATE TABLE game_profiles (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
    lifetime_taps bigint NOT NULL DEFAULT 0 CHECK (lifetime_taps BETWEEN 0 AND 9007199254740991),
    best_series bigint NOT NULL DEFAULT 0 CHECK (best_series BETWEEN 0 AND lifetime_taps),
    leaderboard_opt_in boolean NOT NULL DEFAULT false,
    visibility_version bigint NOT NULL DEFAULT 0 CHECK (visibility_version BETWEEN 0 AND 9007199254740991),
    bucket_tokens double precision NOT NULL DEFAULT 60 CHECK (bucket_tokens BETWEEN 0 AND 60),
    bucket_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE game_monthly_scores (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    taps bigint NOT NULL CHECK (taps BETWEEN 0 AND 9007199254740991),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, month)
);
CREATE INDEX game_monthly_ranking_idx ON game_monthly_scores(month, taps DESC, updated_at, user_id);

CREATE TABLE game_sessions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    auth_session_id uuid NOT NULL,
    request_id uuid NOT NULL,
    month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence BETWEEN 0 AND 9007199254740990),
    last_tap_count integer NOT NULL DEFAULT 0 CHECK (last_tap_count BETWEEN 0 AND 60),
    last_accepted integer NOT NULL DEFAULT 0 CHECK (last_accepted BETWEEN 0 AND last_tap_count),
    last_run_id uuid,
    last_batch_at timestamptz,
    run_id uuid,
    run_updated_at timestamptz,
    continuation_claimed boolean NOT NULL DEFAULT false,
    run_taps bigint NOT NULL DEFAULT 0 CHECK (run_taps BETWEEN 0 AND 9007199254740991),
    UNIQUE(user_id, request_id),
    FOREIGN KEY(auth_session_id, user_id) REFERENCES app_sessions(id, user_id) ON DELETE RESTRICT,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
    CHECK (expires_at <= ((month + interval '1 month')::timestamp AT TIME ZONE 'UTC')),
    CHECK (month = date_trunc('month', created_at AT TIME ZONE 'UTC')::date),
    CHECK ((last_sequence = 0 AND last_run_id IS NULL AND last_batch_at IS NULL AND last_tap_count = 0 AND run_taps = 0)
        OR (last_sequence > 0 AND last_run_id IS NOT NULL AND last_batch_at IS NOT NULL AND last_tap_count > 0)),
    CHECK (last_batch_at IS NULL OR (last_batch_at >= created_at AND last_batch_at < expires_at)),
    CHECK ((run_taps = 0 AND run_id IS NULL AND run_updated_at IS NULL)
        OR (run_taps > 0 AND run_id IS NOT NULL AND run_updated_at IS NOT NULL)),
    CHECK (run_updated_at IS NULL OR (run_updated_at >= created_at AND run_updated_at < expires_at))
);
CREATE INDEX game_sessions_user_expiry_idx ON game_sessions(user_id, expires_at);
