-- Permanent item knowledge is seeded only from confirmed historical ownership.
-- No pending job rewards, payments, wallets, frozen terms or market lots are rewritten.
-- V52 follows B49 -> V50 -> V51 and the immutable historical V1-V51 path.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM public.economy_profiles WHERE revision>=9007199254740991) THEN
        RAISE EXCEPTION 'Cannot fence V52 item knowledge: an economy revision is exhausted';
    END IF;
END $$;

WITH known(item_id) AS (VALUES
        ('ancient_core'),
        ('beams'),
        ('berries'),
        ('berry_compote'),
        ('berry_fish'),
        ('bricks'),
        ('charcoal'),
        ('clay'),
        ('cloth'),
        ('crumb_bait'),
        ('cut_stone'),
        ('dried_berries'),
        ('epic_fish'),
        ('fiber'),
        ('firefly_bait'),
        ('fish_common'),
        ('fish_epic'),
        ('fish_legendary'),
        ('fish_rare'),
        ('fish_soup'),
        ('fish_uncommon'),
        ('glass'),
        ('glow_bait'),
        ('grilled_fish'),
        ('hardwood'),
        ('hearty_fish'),
        ('iron_ingot'),
        ('legendary_fish'),
        ('living_resin'),
        ('metal_parts'),
        ('moon_crystal'),
        ('ore'),
        ('planks'),
        ('reinforced_parts'),
        ('resin'),
        ('rope'),
        ('sand'),
        ('smoked_fish'),
        ('star_bait'),
        ('stone'),
        ('strawberries'),
        ('tools'),
        ('wood'),
        ('worm_bait')
), fish_aliases(item_id,canonical_id) AS (VALUES
        ('fish','fish_common'),
        ('fish_bream','fish_uncommon'),
        ('fish_dace','fish_uncommon'),
        ('fish_eel','fish_rare'),
        ('fish_mirror_koi','fish_epic'),
        ('fish_mooncarp','fish_rare'),
        ('fish_pike','fish_rare'),
        ('fish_reedperch','fish_uncommon'),
        ('fish_rudd','fish_common'),
        ('fish_shark','fish_legendary'),
        ('fish_silverfin','fish_common'),
        ('fish_sturgeon','fish_epic')
), historical AS (
    SELECT e.user_id,item.key AS item_id FROM public.economy_profiles e
        CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e.state->'inventory')='object'
            THEN e.state->'inventory' ELSE '{}'::jsonb END) item
        WHERE CASE WHEN jsonb_typeof(item.value)='number' THEN (item.value#>>'{}')::numeric>0 ELSE false END
    UNION SELECT e.user_id,item.value AS item_id FROM public.economy_profiles e
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.state->'unlockedItems')='array'
            THEN e.state->'unlockedItems' ELSE '[]'::jsonb END) item
    UNION SELECT e.user_id,item.key AS item_id FROM public.economy_profiles e
        CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e.state->'fishing'->'catches')='object'
            THEN e.state->'fishing'->'catches' ELSE '{}'::jsonb END) item
        WHERE CASE WHEN jsonb_typeof(item.value)='number' THEN (item.value#>>'{}')::numeric>0 ELSE false END
    UNION SELECT l.user_id,item.key AS item_id FROM public.economy_ledger l
        CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(l.items)='object' THEN l.items ELSE '{}'::jsonb END) item
        WHERE CASE WHEN jsonb_typeof(item.value)='number' THEN (item.value#>>'{}')::numeric>0 ELSE false END
    UNION SELECT seller_id,item_id FROM public.economy_market_listings WHERE status='active'
    UNION SELECT seller_id,offered_item_id FROM public.economy_barter_offers WHERE status='active'
), canonical AS (
    SELECT DISTINCT h.user_id,k.item_id FROM historical h
        LEFT JOIN fish_aliases f ON f.item_id=h.item_id
        JOIN known k ON k.item_id=coalesce(f.canonical_id,h.item_id)
), knowledge AS (
    SELECT user_id,jsonb_agg(item_id ORDER BY item_id) AS items FROM canonical GROUP BY user_id
)
UPDATE public.economy_profiles e SET state=e.state || jsonb_build_object(
    'marketSlots',CASE WHEN jsonb_typeof(e.state->'marketSlots')='number' THEN
        CASE WHEN (e.state->>'marketSlots')::numeric BETWEEN 5 AND 10
            AND (e.state->>'marketSlots')::numeric=trunc((e.state->>'marketSlots')::numeric)
            THEN to_jsonb((e.state->>'marketSlots')::numeric::integer) ELSE '5'::jsonb END
        ELSE '5'::jsonb END,
    'unlockedItems',coalesce(k.items,'[]'::jsonb),
    'itemUnlockVersion',1),revision=e.revision+1,updated_at=clock_timestamp()
FROM (SELECT p.user_id,k.items FROM public.economy_profiles p LEFT JOIN knowledge k ON k.user_id=p.user_id) k
WHERE k.user_id=e.user_id;

-- Required-recipe progress and current source availability are projected by the shared
-- TypeScript/Kotlin helper without writing on GET, then persisted with a successful command.
-- A fresh or reset profile never inherits advanced knowledge merely from gifted inventory.
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
                'version',2,'step',0,'ingredientsClaimed',true,'completed',false,
                'terms',jsonb_build_object('id','tutorial_first_order','residentId','builder',
                    'name','Первая малина',
                    'description','Вырасти и собери две малины для первого заказа. Учебная просьба не исчезнет.',
                    'items',jsonb_build_object('berries',2),'coins',30)))
        END) || jsonb_build_object('marketSlots',5,'unlockedItems','[]'::jsonb,'itemUnlockVersion',1)
    FROM initial
$$;
