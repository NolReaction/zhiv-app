-- Only future profile initialization receives this pack. Existing balances,
-- revisions, receipts and historical currency conversion functions stay intact.
-- Keep this initializer in parity with economy-catalog.json onboarding.starting*.
CREATE FUNCTION economy_v4_initial_state(legacy jsonb, include_starting_pack boolean DEFAULT true) RETURNS jsonb
LANGUAGE SQL IMMUTABLE STRICT AS $$
    WITH initial AS (SELECT economy_v3_initial_state(legacy) AS state)
    SELECT CASE WHEN NOT include_starting_pack THEN state ELSE
        state || jsonb_build_object(
            'wallet',jsonb_build_object('coins',(state->'wallet'->>'coins')::bigint+2500,'pearls',1000),
            'inventory',(state->'inventory') || jsonb_build_object(
                'fish',10,'wood',coalesce((state->'inventory'->>'wood')::bigint,0)+10,
                'stone',coalesce((state->'inventory'->>'stone')::bigint,0)+10))
        END FROM initial
$$;
