-- Keep every historical ownership/audit ID while expanding the current catalogue.
ALTER TABLE game_achievements DROP CONSTRAINT game_achievements_id_ck;
ALTER TABLE game_achievements ADD CONSTRAINT game_achievements_id_ck CHECK (achievement_id IN
 ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series',
  'ten_thousand_series','linked_email','saved_recovery_code','full_collection',
  'first_path','familiar_trails','explorer','master_recipes','home_builder','river_atlas','first_sale','lucky_find'));

CREATE TABLE game_achievement_tiers (
    user_id uuid NOT NULL,
    achievement_id varchar(32) NOT NULL,
    level integer NOT NULL,
    unlocked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id,achievement_id,level),
    FOREIGN KEY(user_id,achievement_id) REFERENCES game_achievements(user_id,achievement_id) ON DELETE CASCADE,
    CONSTRAINT game_achievement_tiers_level_ck CHECK (
        (achievement_id IN ('first_path','familiar_trails','river_atlas','first_sale','lucky_find') AND level=1)
        OR (achievement_id='explorer' AND level BETWEEN 1 AND 3)
        OR (achievement_id='master_recipes' AND level BETWEEN 1 AND 2)
        OR (achievement_id='home_builder' AND level BETWEEN 1 AND 4)
    )
);

ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_reward_ck;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_reward_ck CHECK (
    (action='revoke_sessions' AND actor_public_id<>target_public_id AND reward_id IS NULL AND granted IS NULL AND payload IS NULL)
    OR (action='grant_item' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN ('flower','leaf_bed','keepsakes','leaf_garland') AND payload IS NULL)
    OR (action='grant_achievement' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN
        ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series',
         'ten_thousand_series','linked_email','saved_recovery_code','full_collection',
         'first_path','familiar_trails','explorer','master_recipes','home_builder','river_atlas','first_sale','lucky_find') AND payload IS NULL)
    OR (action IN ('grant_resource','grant_world_item','grant_find','set_tag','ban','unban','watch','unwatch','clear_signal')
        AND reward_id IS NULL AND granted IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
        AND changed IS NOT NULL AND (action NOT IN ('ban','unban') OR actor_public_id<>target_public_id))
);

-- Route/recipe provenance is absent from historical claim receipts. Their new
-- counters intentionally start empty; verified totals are reconciled by the server.
