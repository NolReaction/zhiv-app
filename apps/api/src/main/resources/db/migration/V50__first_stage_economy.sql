-- Only future profiles receive the first-stage starter and four-order tutorial.
-- Existing saved profiles, frozen jobs and ledger entries are left untouched.
CREATE OR REPLACE FUNCTION public.economy_v4_initial_state(legacy jsonb, include_starting_pack boolean DEFAULT true)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
    WITH initial AS (SELECT economy_v3_initial_state(legacy) AS state)
    SELECT CASE WHEN NOT include_starting_pack THEN state ELSE
        state || jsonb_build_object(
            'wallet',jsonb_build_object('coins',(state->'wallet'->>'coins')::bigint+100,'pearls',0),
            'inventory',(state->'inventory') || jsonb_build_object(
                'wood',coalesce((state->'inventory'->>'wood')::bigint,0)+3,
                'stone',coalesce((state->'inventory'->>'stone')::bigint,0)+5),
            'tutorialOrder',jsonb_build_object(
                'version',2,'step',0,'ingredientsClaimed',true,'completed',false,
                'terms',jsonb_build_object('id','tutorial_first_order','residentId','builder',
                    'name','Первая малина',
                    'description','Вырасти и собери две малины для первого заказа. Учебная просьба не исчезнет.',
                    'items',jsonb_build_object('berries',2),'coins',30)))
        END FROM initial
$$;
