-- Retain retired IDs in storage and append-only audit, without reinterpreting ownership.
ALTER TABLE game_achievements DROP CONSTRAINT game_achievements_id_ck;
ALTER TABLE game_achievements ADD CONSTRAINT game_achievements_id_ck CHECK (achievement_id IN
    ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series',
     'ten_thousand_series','linked_email','saved_recovery_code'));

ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_reward_ck;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_reward_ck CHECK (
    (action='revoke_sessions' AND actor_public_id<>target_public_id AND reward_id IS NULL AND granted IS NULL)
    OR (action='grant_item' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL
        AND reward_id IN ('flower','leaf_bed','keepsakes','leaf_garland'))
    OR (action='grant_achievement' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL
        AND reward_id IN ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series',
                         'ten_thousand_series','linked_email','saved_recovery_code'))
);

INSERT INTO game_achievements(user_id,achievement_id)
SELECT p.user_id,'ten_thousand_series' FROM game_profiles p JOIN app_users u ON u.id=p.user_id
WHERE u.deleted_at IS NULL AND p.best_series>=10000
UNION ALL
SELECT i.user_id,'linked_email' FROM account_login_identities i JOIN app_users u ON u.id=i.user_id
WHERE u.deleted_at IS NULL AND i.provider='email'
UNION ALL
SELECT u.id,'saved_recovery_code' FROM app_users u WHERE u.deleted_at IS NULL
AND EXISTS (SELECT 1 FROM account_recovery_codes c WHERE c.user_id IN (SELECT user_id FROM account_history_user_ids(u.id)))
ON CONFLICT DO NOTHING;
