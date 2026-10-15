ALTER TABLE account_login_identities DROP CONSTRAINT account_login_identities_provider_check;
ALTER TABLE account_login_identities ADD CONSTRAINT account_login_identities_provider_check
    CHECK (provider IN ('telegram', 'email', 'vk'));
ALTER TABLE account_login_flows DROP CONSTRAINT account_login_flows_provider_check;
ALTER TABLE account_login_flows ADD CONSTRAINT account_login_flows_provider_check
    CHECK (provider IN ('telegram', 'email', 'vk'));

-- Created only after proof of identity. No app profile exists until a name is submitted.
CREATE TABLE account_registration_tickets (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    browser_hash bytea NOT NULL CHECK (octet_length(browser_hash) = 32),
    provider varchar(16) NOT NULL CHECK (provider IN ('telegram', 'email', 'vk')),
    subject varchar(254) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
    consumed_at timestamptz,
    CHECK (expires_at > created_at)
);
CREATE INDEX account_registration_tickets_expiry_idx ON account_registration_tickets(expires_at);
