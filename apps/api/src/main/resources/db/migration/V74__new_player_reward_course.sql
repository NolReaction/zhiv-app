-- Existing rows keep their already promised v5/v6 course and wallet contents.
-- Only accounts whose course is created after this migration use the v7 budget.
ALTER TABLE game_daily_rewards DROP CONSTRAINT game_daily_rewards_catalog_version_check;
ALTER TABLE game_daily_rewards ADD CONSTRAINT game_daily_rewards_catalog_version_check
    CHECK (reward_catalog_version IN (5, 6, 7));
ALTER TABLE game_daily_rewards ALTER COLUMN reward_catalog_version SET DEFAULT 7;

-- Stored tutorial terms are untouched; only future initial states use v7.
CREATE OR REPLACE FUNCTION public.economy_v4_initial_state(legacy jsonb, include_starting_pack boolean DEFAULT true)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
    WITH initial AS (SELECT economy_v3_initial_state(legacy) AS state)
    SELECT (CASE WHEN NOT include_starting_pack THEN state ELSE
        state || jsonb_build_object(
            'wallet',jsonb_build_object('coins',(state->'wallet'->>'coins')::bigint+100,'pearls',0),
            'inventory',(state->'inventory') || jsonb_build_object(
                'wood',coalesce((state->'inventory'->>'wood')::bigint,0)+3,
                'stone',coalesce((state->'inventory'->>'stone')::bigint,0)+5),
            'tutorialOrder',jsonb_build_object(
                'version',3,'step',0,'ingredientsClaimed',true,'completed',false,'rewardVersion',7,
                'terms',jsonb_build_object('id','tutorial_first_order','residentId','builder',
                    'name','Первая малина',
                    'description','Вырасти и собери одну малину. Шишколап покажет, как выполнять просьбы жителей.',
                    'items',jsonb_build_object('berries',1),'coins',13)))
        END) || jsonb_build_object('marketSlots',5,'unlockedItems','[]'::jsonb,'itemUnlockVersion',1)
    FROM initial
$$;
