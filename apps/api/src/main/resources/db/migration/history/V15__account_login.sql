-- Login identities belong to the existing profile; normal login never revokes other sessions.
CREATE TABLE account_login_identities (
    provider varchar(16) NOT NULL CHECK (provider IN ('telegram', 'email')),
    subject varchar(254) NOT NULL,
    user_id uuid NOT NULL REFERENCES app_users(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (provider, subject),
    UNIQUE (user_id, provider)
);

CREATE TABLE account_login_flows (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    browser_hash bytea NOT NULL CHECK (octet_length(browser_hash) = 32),
    provider varchar(16) NOT NULL CHECK (provider IN ('telegram', 'email')),
    intent varchar(16) NOT NULL CHECK (intent IN ('login', 'register', 'link')),
    session_hash bytea,
    display_name varchar(50),
    subject varchar(254),
    verifier varchar(128),
    nonce varchar(128),
    code_hash bytea,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
    consumed_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK (intent <> 'link' OR session_hash IS NOT NULL)
);
CREATE INDEX account_login_flows_expiry_idx ON account_login_flows(expires_at);
CREATE INDEX account_login_flows_email_idx ON account_login_flows(subject, created_at) WHERE provider = 'email';
