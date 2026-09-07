-- A profile timezone changes only future check-in local dates. Historical rows remain append-only.
CREATE TABLE user_timezone_write_keys (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    idempotency_key uuid NOT NULL,
    timezone_id varchar(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, idempotency_key)
);
