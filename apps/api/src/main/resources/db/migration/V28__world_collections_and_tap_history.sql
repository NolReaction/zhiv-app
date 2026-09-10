-- Add the new medal without invalidating retired achievements or audit records.
ALTER TABLE game_achievements DROP CONSTRAINT game_achievements_id_ck;
ALTER TABLE game_achievements ADD CONSTRAINT game_achievements_id_ck CHECK (achievement_id IN
 ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series',
  'ten_thousand_series','linked_email','saved_recovery_code','full_collection'));

ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_reward_ck;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_reward_ck CHECK (
    (action='revoke_sessions' AND actor_public_id<>target_public_id AND reward_id IS NULL AND granted IS NULL AND payload IS NULL)
    OR (action='grant_item' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN ('flower','leaf_bed','keepsakes','leaf_garland') AND payload IS NULL)
    OR (action='grant_achievement' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN
        ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series','ten_thousand_series','linked_email','saved_recovery_code','full_collection') AND payload IS NULL)
    OR (action IN ('grant_resource','grant_world_item','grant_find','set_tag','ban','unban','watch','unwatch','clear_signal')
        AND reward_id IS NULL AND granted IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
        AND changed IS NOT NULL AND (action NOT IN ('ban','unban') OR actor_public_id<>target_public_id))
);

-- Durable minute aggregates; precise seconds still expire after two hours.
CREATE TABLE game_tap_activity_minutes (
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
    review_signal boolean NOT NULL DEFAULT false,
    watchlisted boolean NOT NULL DEFAULT false,
    PRIMARY KEY(user_id,bucket_at)
);
CREATE INDEX game_tap_history_retention_idx ON game_tap_activity_minutes(bucket_at);

INSERT INTO game_tap_activity_minutes(user_id,bucket_at,received_taps,rejected_taps,event_taps,delayed_taps,legacy_taps,interval_count,interval_sum_ms,interval_squared_sum_ms)
SELECT user_id,date_trunc('minute',bucket_at),sum(received_taps),sum(rejected_taps),sum(event_taps),sum(delayed_taps),sum(legacy_taps),sum(interval_count),sum(interval_sum_ms),sum(interval_squared_sum_ms)
FROM game_tap_activity_seconds GROUP BY user_id,date_trunc('minute',bucket_at);
