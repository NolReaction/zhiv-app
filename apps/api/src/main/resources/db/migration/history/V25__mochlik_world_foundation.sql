-- Versioned aggregate for the bounded personal world. Economy effects and
-- command receipts are separate, transactional records; no client-owned balances.
CREATE TABLE world_profiles (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
    state jsonb NOT NULL CHECK ((jsonb_typeof(state) = 'object' AND state->>'schemaVersion' = '1') IS TRUE),
    tap_day date NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,
    tap_sparks integer NOT NULL DEFAULT 0 CHECK (tap_sparks BETWEEN 0 AND 60),
    tap_remainder integer NOT NULL DEFAULT 0 CHECK (tap_remainder BETWEEN 0 AND 4),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((jsonb_typeof(state->'resources'->'sparks') = 'number' AND (state->'resources'->>'sparks')::bigint BETWEEN 0 AND 9007199254740991) IS TRUE),
    CHECK ((jsonb_typeof(state->'resources'->'wood') = 'number' AND (state->'resources'->>'wood')::bigint BETWEEN 0 AND 9007199254740991) IS TRUE),
    CHECK ((jsonb_typeof(state->'resources'->'stone') = 'number' AND (state->'resources'->>'stone')::bigint BETWEEN 0 AND 9007199254740991) IS TRUE)
);
CREATE TABLE world_commands (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    signature text NOT NULL,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id, request_id)
);
CREATE TABLE world_ledger (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    source_key text NOT NULL,
    kind text NOT NULL,
    sparks bigint NOT NULL DEFAULT 0,
    wood bigint NOT NULL DEFAULT 0,
    stone bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id, source_key)
);
CREATE INDEX world_ledger_history ON world_ledger(user_id, created_at DESC);
