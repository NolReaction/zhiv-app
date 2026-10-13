ALTER TABLE app_users ADD COLUMN status_text varchar(120);
ALTER TABLE app_users ADD COLUMN status_updated_at timestamptz;
ALTER TABLE app_users ADD CONSTRAINT app_users_status_nullity CHECK ((status_text IS NULL) = (status_updated_at IS NULL));
ALTER TABLE app_users ADD CONSTRAINT app_users_status_shape CHECK (
    (status_text IS NULL AND status_updated_at IS NULL)
    OR (length(status_text) BETWEEN 1 AND 120 AND status_updated_at IS NOT NULL
        AND status_text !~ '[[:cntrl:]]')
);
CREATE TABLE user_status_write_keys (
    user_id uuid NOT NULL REFERENCES app_users(id),
    idempotency_key uuid NOT NULL,
    status_text varchar(120) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, idempotency_key)
);
