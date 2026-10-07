-- Authenticated play sessions are separate from login sessions. An expired ID
-- is retained as a replay tombstone: retrying resume never revives it.
CREATE TABLE game_presence_clients (
    presence_id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    auth_session_id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    last_active_at timestamptz NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','disconnected','suspended')),
    sequence bigint NOT NULL DEFAULT 0 CHECK (sequence BETWEEN 0 AND 9007199254740990),
    last_kind varchar(16) NOT NULL DEFAULT 'resume' CHECK (last_kind IN ('resume','heartbeat','suspend')),
    last_active boolean NOT NULL DEFAULT true,
    FOREIGN KEY (auth_session_id,user_id) REFERENCES app_sessions(id,user_id) ON DELETE CASCADE,
    CHECK (last_seen_at >= created_at AND last_active_at BETWEEN created_at AND last_seen_at)
);
CREATE INDEX game_presence_clients_user_idx ON game_presence_clients(user_id,created_at);
CREATE INDEX game_presence_clients_live_idx ON game_presence_clients(auth_session_id,last_seen_at) WHERE status='active';

-- Account lock + recent multirange make confirmed intervals an exact union
-- across tabs/devices, including late delivery from an earlier-started tab.
CREATE TABLE game_presence_accounts (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    credited_until timestamptz NOT NULL,
    credited_spans tstzmultirange NOT NULL DEFAULT '{}'::tstzmultirange
);
CREATE TABLE game_presence_daily (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    day date NOT NULL,
    online_millis bigint NOT NULL DEFAULT 0 CHECK (online_millis BETWEEN 0 AND 86400000),
    flagged_at timestamptz,
    PRIMARY KEY(user_id,day),
    CHECK (flagged_at IS NULL OR online_millis > 72000000)
);
CREATE INDEX game_presence_daily_day_idx ON game_presence_daily(day,user_id);
CREATE INDEX game_presence_daily_flagged_idx ON game_presence_daily(day DESC,flagged_at DESC) WHERE flagged_at IS NOT NULL;
