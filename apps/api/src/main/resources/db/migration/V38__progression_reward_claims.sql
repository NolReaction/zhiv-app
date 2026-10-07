-- Existing ownership is a finite grandfather grant. Future admin awards are cosmetic
-- until verified gameplay reaches the actual tier; claiming never rewrites ownership.
ALTER TABLE game_achievements ADD COLUMN reward_eligible boolean NOT NULL DEFAULT true;
ALTER TABLE game_achievement_tiers ADD COLUMN reward_eligible boolean NOT NULL DEFAULT true;

CREATE TABLE game_daily_rewards (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    next_step smallint NOT NULL DEFAULT 1 CHECK (next_step BETWEEN 1 AND 7),
    last_claim_at timestamptz,
    last_claim_date date,
    CHECK ((last_claim_at IS NULL) = (last_claim_date IS NULL)),
    CHECK (last_claim_at IS NULL OR last_claim_date = (last_claim_at AT TIME ZONE 'UTC')::date)
);
CREATE TABLE game_reward_claims (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    origin_user_id uuid NOT NULL,
    signature text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('daily','achievement')),
    daily_date date,
    claim jsonb NOT NULL CHECK (jsonb_typeof(claim)='object'),
    accepted_revision bigint NOT NULL CHECK (accepted_revision BETWEEN 0 AND 9007199254740991),
    claimed_at timestamptz NOT NULL,
    PRIMARY KEY(user_id,request_id),
    CHECK ((kind='daily') = (daily_date IS NOT NULL)),
    CHECK (daily_date IS NULL OR daily_date=(claimed_at AT TIME ZONE 'UTC')::date)
);
CREATE UNIQUE INDEX game_daily_reward_one_per_date ON game_reward_claims(user_id,origin_user_id,daily_date) WHERE kind='daily';
CREATE TABLE game_achievement_reward_claims (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    achievement_id text NOT NULL,
    level smallint NOT NULL CHECK (level BETWEEN 1 AND 4),
    pearls bigint NOT NULL CHECK (pearls BETWEEN 1 AND 1000000000),
    claimed_at timestamptz NOT NULL,
    PRIMARY KEY(user_id,achievement_id,level),
    CHECK ((achievement_id='explorer' AND level<=3) OR (achievement_id='home_builder' AND level<=4)
       OR (achievement_id='master_recipes' AND level<=2)
       OR (achievement_id IN ('seven_day_streak','thousand_taps','five_friends','ten_thousand_series','linked_email',
           'saved_recovery_code','first_path','familiar_trails','river_atlas','first_sale','lucky_find') AND level=1))
);
