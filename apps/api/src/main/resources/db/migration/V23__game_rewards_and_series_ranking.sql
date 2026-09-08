-- Permanent ownership is independent of tap totals, streaks, and ranking consent.
CREATE TABLE game_items (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    item_id varchar(32) NOT NULL CHECK (item_id IN ('flower','leaf_bed','keepsakes','leaf_garland')),
    unlocked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id,item_id)
);
ALTER TABLE game_achievements DROP CONSTRAINT game_achievements_id_ck;
ALTER TABLE game_achievements ADD CONSTRAINT game_achievements_id_ck CHECK (achievement_id IN
    ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series'));

INSERT INTO game_items(user_id,item_id)
SELECT u.id,t.id FROM app_users u
CROSS JOIN LATERAL rolling_check_in_streak(u.id,clock_timestamp()) s
CROSS JOIN (VALUES ('flower',3),('leaf_bed',7),('keepsakes',14),('leaf_garland',30)) t(id,days)
WHERE u.deleted_at IS NULL AND s.longest_days>=t.days ON CONFLICT DO NOTHING;
INSERT INTO game_achievements(user_id,achievement_id)
SELECT u.id,'thirty_day_streak' FROM app_users u
CROSS JOIN LATERAL rolling_check_in_streak(u.id,clock_timestamp()) s
WHERE u.deleted_at IS NULL AND s.longest_days>=30
UNION ALL
SELECT p.user_id,'ten_thousand_taps' FROM game_profiles p JOIN app_users u ON u.id=p.user_id
WHERE u.deleted_at IS NULL AND p.lifetime_taps>=10000
UNION ALL
SELECT p.user_id,'hundred_series' FROM game_profiles p JOIN app_users u ON u.id=p.user_id
WHERE u.deleted_at IS NULL AND p.best_series>=100
ON CONFLICT DO NOTHING;

ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_action_check;
ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_check;
ALTER TABLE admin_actions ADD COLUMN reward_id varchar(32), ADD COLUMN granted boolean;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_reward_ck CHECK (
    (action='revoke_sessions' AND actor_public_id<>target_public_id AND reward_id IS NULL AND granted IS NULL)
    OR (action='grant_item' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL
        AND reward_id IN ('flower','leaf_bed','keepsakes','leaf_garland'))
    OR (action='grant_achievement' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL
        AND reward_id IN ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series'))
);
CREATE INDEX game_profiles_series_rank_idx ON game_profiles(best_series DESC,user_id) WHERE leaderboard_opt_in AND best_series>0;
