-- Author is always resolved from the session, never supplied by the browser.
CREATE TABLE player_feedback (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    client_request_id uuid NOT NULL UNIQUE,
    category varchar(16) NOT NULL CHECK (category IN ('bug','suggestion','other')),
    message text NOT NULL CHECK (char_length(message) BETWEEN 10 AND 3000),
    status varchar(16) NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','resolved')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX player_feedback_owner_created_idx ON player_feedback(user_id, created_at DESC);
CREATE INDEX player_feedback_created_idx ON player_feedback(created_at DESC, id DESC);
CREATE INDEX player_feedback_status_created_idx ON player_feedback(status, created_at DESC, id DESC);

-- Store receipts separately so retrying an earlier moderation operation cannot undo a newer one.
CREATE TABLE player_feedback_actions (
    request_id uuid PRIMARY KEY,
    feedback_id uuid NOT NULL REFERENCES player_feedback(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    status varchar(16) NOT NULL CHECK (status IN ('new','reviewed','resolved')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
