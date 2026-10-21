-- Coin denomination remains ×10; pearls move from ×10 to ×50 without changing
-- purchasing power. Keep immutable historical claims, signatures and ledger data.
ALTER TABLE economy_ledger ADD COLUMN pearl_scale smallint;
UPDATE economy_ledger SET pearl_scale=currency_scale;
ALTER TABLE economy_ledger ALTER COLUMN pearl_scale SET NOT NULL;
ALTER TABLE economy_ledger ALTER COLUMN pearl_scale SET DEFAULT 50;
ALTER TABLE economy_ledger ADD CONSTRAINT economy_ledger_pearl_scale_ck CHECK (pearl_scale IN (1,10,50));
ALTER TABLE game_reward_claims ADD COLUMN pearl_scale smallint;
UPDATE game_reward_claims SET pearl_scale=currency_scale;
ALTER TABLE game_reward_claims ALTER COLUMN pearl_scale SET NOT NULL;
ALTER TABLE game_reward_claims ALTER COLUMN pearl_scale SET DEFAULT 50;
ALTER TABLE game_reward_claims ADD CONSTRAINT game_reward_claims_pearl_scale_ck CHECK (pearl_scale IN (1,10,50));
ALTER TABLE game_achievement_reward_claims ADD COLUMN pearl_scale smallint;
UPDATE game_achievement_reward_claims SET pearl_scale=currency_scale;
ALTER TABLE game_achievement_reward_claims ALTER COLUMN pearl_scale SET NOT NULL;
ALTER TABLE game_achievement_reward_claims ALTER COLUMN pearl_scale SET DEFAULT 50;
ALTER TABLE game_achievement_reward_claims ADD CONSTRAINT game_achievement_reward_claims_pearl_scale_ck CHECK (pearl_scale IN (1,10,50));

CREATE FUNCTION economy_pearl_nominal_state(value jsonb) RETURNS jsonb
LANGUAGE SQL IMMUTABLE STRICT AS $$
    WITH nominal AS (SELECT economy_currency_nominal_state(value) AS state)
    SELECT state || jsonb_build_object('pearlScale',50,
        'wallet',(state->'wallet') || jsonb_build_object('pearls',
            (value->'wallet'->>'pearls')::bigint *
            (50 / coalesce((value->>'pearlScale')::integer,(value->>'currencyScale')::integer,1))))
    FROM nominal
$$;
CREATE OR REPLACE FUNCTION economy_v3_initial_state(legacy jsonb) RETURNS jsonb
LANGUAGE SQL IMMUTABLE STRICT AS $$ SELECT economy_pearl_nominal_state(economy_v2_initial_state(legacy)) $$;

DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM economy_profiles WHERE coalesce(state->>'pearlScale',state->>'currencyScale','1') NOT IN ('1','10','50')) THEN
        RAISE EXCEPTION 'Unsupported saved pearl denomination';
    END IF;
END $$;
ALTER TABLE economy_profiles DROP CONSTRAINT economy_profiles_wallet_nominal_ck;
ALTER TABLE economy_profiles ADD CONSTRAINT economy_profiles_wallet_nominal_ck CHECK (
    (jsonb_typeof(state->'wallet')='object') IS TRUE
    AND (((state->'wallet'->>'coins')::bigint BETWEEN 0 AND 10000000000)) IS TRUE
    AND (((state->'wallet'->>'pearls')::bigint BETWEEN 0 AND 50000000000)) IS TRUE
);
UPDATE economy_profiles SET state=economy_pearl_nominal_state(state),
    revision=least(9007199254740991,revision+1),updated_at=clock_timestamp()
WHERE coalesce(state->>'pearlScale','')<>'50';
ALTER TABLE economy_profiles ADD CONSTRAINT economy_profiles_pearl_scale_ck CHECK ((state->>'pearlScale'='50') IS TRUE);
ALTER TABLE economy_ledger DROP CONSTRAINT economy_ledger_pearls_nominal_ck;
ALTER TABLE economy_ledger ADD CONSTRAINT economy_ledger_pearls_nominal_ck CHECK (pearls BETWEEN -50000000000 AND 50000000000);
ALTER TABLE game_achievement_reward_claims DROP CONSTRAINT game_achievement_reward_claims_pearls_nominal_ck;
ALTER TABLE game_achievement_reward_claims ADD CONSTRAINT game_achievement_reward_claims_pearls_nominal_ck CHECK (pearls BETWEEN 1 AND 50000000000);
