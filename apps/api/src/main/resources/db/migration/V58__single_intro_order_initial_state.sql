-- Change only future initial states. Existing profiles, pinned orders, receipts,
-- wallets and revisions are deliberately untouched; shared domain rules adapt old courses.
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
                'version',3,'step',0,'ingredientsClaimed',true,'completed',false,
                'terms',jsonb_build_object('id','tutorial_first_order','residentId','builder',
                    'name','Первая малина',
                    'description','Вырасти и собери одну малину. Шишколап покажет, как выполнять просьбы жителей.',
                    'items',jsonb_build_object('berries',1),'coins',15)))
        END) || jsonb_build_object('marketSlots',5,'unlockedItems','[]'::jsonb,'itemUnlockVersion',1)
    FROM initial
$$;
