ALTER TABLE app_users ADD COLUMN tag_text varchar(16);
ALTER TABLE app_users ADD COLUMN tag_color varchar(12);
ALTER TABLE app_users ADD COLUMN banned_at timestamptz;
ALTER TABLE app_users ADD COLUMN ban_reason varchar(240);
ALTER TABLE app_users ADD COLUMN tap_watchlisted boolean NOT NULL DEFAULT false;
ALTER TABLE app_users ADD COLUMN tap_analyzed_at timestamptz;
ALTER TABLE app_users ADD COLUMN tap_signal_at timestamptz;
ALTER TABLE app_users ADD CONSTRAINT app_users_tag_ck CHECK (
    (tag_text IS NULL AND tag_color IS NULL) OR
    (tag_text IS NOT NULL AND tag_text ~ '^[A-Za-zА-Яа-яЁё0-9_-]{1,16}$'
     AND tag_color IS NOT NULL AND tag_color IN ('red','orange','yellow','green','blue','purple','pink','white'))
);
ALTER TABLE app_users ADD CONSTRAINT app_users_ban_ck CHECK (
    (banned_at IS NULL AND ban_reason IS NULL) OR
    (banned_at IS NOT NULL AND ban_reason IS NOT NULL AND char_length(ban_reason) BETWEEN 8 AND 240)
);

ALTER TABLE admin_actions ADD COLUMN payload jsonb;
ALTER TABLE admin_actions ADD COLUMN changed boolean;
ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_reward_ck;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_reward_ck CHECK (
    (action='revoke_sessions' AND actor_public_id<>target_public_id AND reward_id IS NULL AND granted IS NULL AND payload IS NULL)
    OR (action='grant_item' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN ('flower','leaf_bed','keepsakes','leaf_garland') AND payload IS NULL)
    OR (action='grant_achievement' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN
        ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series','ten_thousand_series','linked_email','saved_recovery_code') AND payload IS NULL)
    OR (action IN ('grant_resource','grant_world_item','grant_find','set_tag','ban','unban','watch','unwatch','clear_signal')
        AND reward_id IS NULL AND granted IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
        AND changed IS NOT NULL AND (action NOT IN ('ban','unban') OR actor_public_id<>target_public_id))
);

-- A final database guard also covers future login providers and old recovery
-- implementations. Account locks serialize session creation with administrator bans.
CREATE FUNCTION guard_banned_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_banned_at timestamptz;
BEGIN
    -- Revocation must not acquire a session-to-account lock: administrative
    -- writes already lock accounts before sessions, and revocation is always safe.
    IF NEW.revoked_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT banned_at INTO account_banned_at FROM app_users WHERE id=NEW.user_id FOR NO KEY UPDATE;
    IF account_banned_at IS NOT NULL THEN
        RAISE EXCEPTION 'account is banned' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER app_sessions_ban_guard BEFORE INSERT OR UPDATE OF user_id, revoked_at ON app_sessions
    FOR EACH ROW EXECUTE FUNCTION guard_banned_session();

-- One row per nonempty second, never one row per tap. Server delivery and
-- client-reported event time are deliberately separate. Retention: two hours.
CREATE TABLE game_tap_activity_seconds (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    bucket_at timestamptz NOT NULL,
    received_taps bigint NOT NULL DEFAULT 0 CHECK (received_taps>=0),
    rejected_taps bigint NOT NULL DEFAULT 0 CHECK (rejected_taps>=0),
    event_taps bigint NOT NULL DEFAULT 0 CHECK (event_taps>=0),
    delayed_taps bigint NOT NULL DEFAULT 0 CHECK (delayed_taps>=0),
    legacy_taps bigint NOT NULL DEFAULT 0 CHECK (legacy_taps>=0),
    interval_count bigint NOT NULL DEFAULT 0 CHECK (interval_count>=0),
    interval_sum_ms double precision NOT NULL DEFAULT 0,
    interval_squared_sum_ms double precision NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id,bucket_at)
);
CREATE INDEX game_tap_activity_retention_idx ON game_tap_activity_seconds(bucket_at);
