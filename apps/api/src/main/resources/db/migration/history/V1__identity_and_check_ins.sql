CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE app_users (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    public_id           varchar(14) NOT NULL UNIQUE,
    display_name        varchar(50) NOT NULL,
    timezone_id         varchar(64) NOT NULL DEFAULT 'Europe/Moscow',
    locale              varchar(16) NOT NULL DEFAULT 'ru',
    last_check_in_at    timestamptz,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at          timestamptz,

    CONSTRAINT app_users_public_id_format_ck CHECK (
        public_id ~ '^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$'
    ),
    CONSTRAINT app_users_display_name_ck CHECK (
        char_length(display_name) BETWEEN 1 AND 50
        AND display_name = btrim(display_name)
        AND display_name !~ '[[:cntrl:]]'
    ),
    CONSTRAINT app_users_dates_ck CHECK (
        updated_at >= created_at
        AND (deleted_at IS NULL OR deleted_at >= created_at)
    )
);

CREATE TABLE app_sessions (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id             uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    token_hash          bytea NOT NULL UNIQUE,
    device_label        varchar(120),
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_seen_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz,

    CONSTRAINT app_sessions_id_user_uq UNIQUE (id, user_id),
    CONSTRAINT app_sessions_token_hash_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT app_sessions_dates_ck CHECK (
        last_seen_at >= created_at
        AND expires_at > created_at
        AND (revoked_at IS NULL OR revoked_at >= created_at)
    )
);

CREATE INDEX app_sessions_user_active_idx
    ON app_sessions(user_id, last_seen_at DESC)
    WHERE revoked_at IS NULL;

CREATE INDEX app_sessions_expiry_idx
    ON app_sessions(expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE identity_bootstrap_keys (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    idempotency_hash    bytea NOT NULL UNIQUE,
    user_id             uuid NOT NULL,
    session_id          uuid NOT NULL UNIQUE,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at          timestamptz NOT NULL,

    CONSTRAINT identity_bootstrap_session_user_fk
        FOREIGN KEY (session_id, user_id) REFERENCES app_sessions(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT identity_bootstrap_hash_ck CHECK (octet_length(idempotency_hash) = 32),
    CONSTRAINT identity_bootstrap_expiry_ck CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '15 minutes'
    )
);

CREATE INDEX identity_bootstrap_expiry_idx ON identity_bootstrap_keys(expires_at);

CREATE TABLE check_ins (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id             uuid NOT NULL,
    session_id          uuid NOT NULL,
    idempotency_key     uuid NOT NULL,
    checked_at          timestamptz NOT NULL,
    next_allowed_at     timestamptz NOT NULL,
    timezone_id         varchar(64) NOT NULL,
    local_date          date NOT NULL,

    CONSTRAINT check_ins_id_user_uq UNIQUE (id, user_id),
    CONSTRAINT check_ins_user_fk
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE RESTRICT,
    CONSTRAINT check_ins_session_user_fk
        FOREIGN KEY (session_id, user_id)
        REFERENCES app_sessions(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT check_ins_idempotency_uq UNIQUE (user_id, idempotency_key),
    CONSTRAINT check_ins_cooldown_value_ck CHECK (
        next_allowed_at = checked_at + interval '30 seconds'
    ),
    CONSTRAINT check_ins_cooldown_excl EXCLUDE USING gist (
        user_id WITH =,
        tstzrange(checked_at, next_allowed_at, '[)') WITH &&
    )
);

CREATE INDEX check_ins_user_latest_idx
    ON check_ins(user_id, checked_at DESC);

CREATE INDEX check_ins_calendar_idx
    ON check_ins(user_id, local_date DESC, checked_at DESC);
