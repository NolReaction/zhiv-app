-- Decorative life has its own revision: saving a pet never changes game rewards.
CREATE TABLE forest_memory (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
    snapshot jsonb CHECK (snapshot IS NULL OR (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 65536)),
    updated_at timestamptz,
    lease_client_id uuid,
    lease_session_hash bytea,
    lease_token uuid,
    lease_expires_at timestamptz,
    CHECK ((snapshot IS NULL) = (updated_at IS NULL)),
    CHECK ((lease_client_id IS NULL AND lease_session_hash IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
        OR (lease_client_id IS NOT NULL AND lease_session_hash IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

-- Only hashes and accepted revisions are kept; no repeated 32KB snapshots in receipts.
-- The repository trims this table to the last 64 commands per account in the same transaction.
CREATE TABLE forest_memory_receipts (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    signature bytea NOT NULL CHECK (octet_length(signature) = 32),
    session_hash bytea NOT NULL,
    accepted_revision bigint NOT NULL CHECK (accepted_revision BETWEEN 0 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, request_id)
);
CREATE INDEX forest_memory_receipts_recent_idx ON forest_memory_receipts(user_id, accepted_revision DESC);
