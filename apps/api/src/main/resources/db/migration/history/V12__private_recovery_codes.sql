
-- V9 stays immutable for existing installations. Friend recovery is retired.
UPDATE account_recovery_attempts SET status = 'CANCELLED', terminal_at = GREATEST(clock_timestamp(), created_at)
 WHERE status IN ('PENDING', 'APPROVED');
-- Runtime no longer has privileges on retired friend-recovery tables.
-- Remove the cross-feature hook before an ordinary circle archive can invoke it.
DROP TRIGGER circles_revoke_recovery_contacts ON circles;
DROP FUNCTION revoke_recovery_for_archived_direct_circle();

CREATE TABLE account_recovery_codes (
    code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    consumed_at timestamptz,
    recovery_session_id uuid REFERENCES app_sessions(id) ON DELETE RESTRICT,
    retry_hash bytea CHECK (retry_hash IS NULL OR octet_length(retry_hash) = 32),
    CHECK ((consumed_at IS NULL AND recovery_session_id IS NULL AND retry_hash IS NULL)
        OR (consumed_at IS NOT NULL AND recovery_session_id IS NOT NULL AND retry_hash IS NOT NULL))
);
CREATE UNIQUE INDEX account_recovery_codes_active_user_idx
 ON account_recovery_codes(user_id) WHERE revoked_at IS NULL AND consumed_at IS NULL;
