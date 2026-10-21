-- No historical local tutorial status grants money. A deliberate new completion
-- uses the normal locked reward transaction and its immutable request receipt.
ALTER TABLE game_reward_claims DROP CONSTRAINT game_reward_claims_kind_check;
ALTER TABLE game_reward_claims ADD CONSTRAINT game_reward_claims_kind_check
    CHECK (kind IN ('daily','achievement','onboarding'));
ALTER TABLE game_daily_rewards ADD COLUMN onboarding_claimed_at timestamptz;
-- Origin keeps both immutable receipts when two previously rewarded accounts merge.
-- The sticky account marker above also prevents a fresh post-merge claim.
CREATE UNIQUE INDEX game_onboarding_reward_one_per_origin
    ON game_reward_claims(user_id,origin_user_id) WHERE kind='onboarding';
