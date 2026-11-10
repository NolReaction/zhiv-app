-- Preserve the award course already shown to every existing account, including
-- accounts that have not opened the rewards screen. Wallets and receipts stay intact.
ALTER TABLE game_daily_rewards ADD COLUMN achievement_reward_version smallint NOT NULL DEFAULT 6
    CHECK (achievement_reward_version IN (6,7));
INSERT INTO game_daily_rewards(user_id) SELECT id FROM app_users ON CONFLICT DO NOTHING;
ALTER TABLE game_daily_rewards ALTER COLUMN achievement_reward_version SET DEFAULT 7;

-- New milestones are append-only: existing tier IDs, targets and dates do not move.
ALTER TABLE game_achievement_tiers DROP CONSTRAINT game_achievement_tiers_level_ck;
ALTER TABLE game_achievement_tiers ADD CONSTRAINT game_achievement_tiers_level_ck CHECK (
    (achievement_id IN ('first_path','familiar_trails','river_atlas','first_sale','lucky_find') AND level=1)
    OR (achievement_id IN ('explorer','master_recipes','home_builder','patient_angler','campfire_cook','helpful_neighbor','generous_garden') AND level BETWEEN 1 AND 4)
);
ALTER TABLE game_achievement_reward_claims DROP CONSTRAINT game_achievement_reward_claims_check;
ALTER TABLE game_achievement_reward_claims ADD CONSTRAINT game_achievement_reward_claims_check CHECK (
    (achievement_id IN ('explorer','master_recipes','home_builder','patient_angler','campfire_cook','helpful_neighbor','generous_garden') AND level BETWEEN 1 AND 4)
    OR (achievement_id IN ('seven_day_streak','thousand_taps','five_friends','ten_thousand_series','linked_email',
        'saved_recovery_code','first_path','familiar_trails','river_atlas','first_sale','lucky_find') AND level=1)
);
