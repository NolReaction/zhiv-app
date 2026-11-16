-- Administrative values belong to the managed configuration, not hard-coded
-- gameplay limits. Keep only the storage/transport numeric representation here.
ALTER TABLE neighbor_shop_cycles DROP CONSTRAINT neighbor_shop_cycles_offers_check;
ALTER TABLE neighbor_shop_cycles ADD CONSTRAINT neighbor_shop_cycles_offers_check
    CHECK (jsonb_typeof(offers)='array');
ALTER TABLE neighbor_purchases DROP CONSTRAINT neighbor_purchases_total_price_check;
ALTER TABLE neighbor_purchases ADD CONSTRAINT neighbor_purchases_total_price_check
    CHECK (total_price BETWEEN 1 AND 10000000000);
ALTER TABLE neighbor_daily_usage DROP CONSTRAINT neighbor_daily_usage_used_lots_check;
ALTER TABLE neighbor_daily_usage ADD CONSTRAINT neighbor_daily_usage_used_lots_check
    CHECK (used_lots BETWEEN 0 AND 9007199254740991);
ALTER TABLE neighbor_daily_usage DROP CONSTRAINT neighbor_daily_usage_spent_coins_check;
ALTER TABLE neighbor_daily_usage ADD CONSTRAINT neighbor_daily_usage_spent_coins_check
    CHECK (spent_coins BETWEEN 0 AND 9007199254740991);
ALTER TABLE neighbor_global_usage DROP CONSTRAINT neighbor_global_usage_spent_coins_check;
ALTER TABLE neighbor_global_usage ADD CONSTRAINT neighbor_global_usage_spent_coins_check
    CHECK (spent_coins BETWEEN 0 AND 9007199254740991);
DROP INDEX neighbor_market_candidates;
CREATE INDEX neighbor_market_candidates ON economy_market_listings(created_at,id) WHERE status='active';

-- Upgrade each untouched default independently. Never replace administrator
-- names, prices, budgets, equipment, custom building levels or custom stock.
-- Personal shop cycles and their paid receipts remain exactly as issued.
WITH upgraded AS (
    SELECT singleton, settings ||
        CASE WHEN settings->'buildings'='{"home":3,"workshop":2,"quarry":2,"warehouse":2,"garden":2,"kiln":1,"dryer":1,"woodlot":2,"bridge":1,"lighthouse":0}'::jsonb
            THEN jsonb_build_object('buildings','{"home":5,"garden":5,"woodlot":5,"quarry":5,"workshop":5,"dryer":5,"kiln":5,"warehouse":10,"bridge":1,"lighthouse":1}'::jsonb)
            ELSE '{}'::jsonb END ||
        CASE WHEN jsonb_typeof(settings->'allowedItemIds')='array' THEN
            CASE WHEN jsonb_array_length(settings->'allowedItemIds')=9
                AND settings->'allowedItemIds' @> '["wood","stone","fiber","berries","planks","rope","clay","sand","ore"]'::jsonb
                AND settings->'allowedItemIds' <@ '["wood","stone","fiber","berries","planks","rope","clay","sand","ore"]'::jsonb
                THEN jsonb_build_object('allowedItemIds','["berries","wood","stone","ore","fiber","planks","rope","metal_parts","dried_berries","smoked_fish","clay","sand","charcoal","iron_ingot","bricks","glass","hardwood","resin","cloth","beams","tools","reinforced_parts","cut_stone","crumb_bait","worm_bait","glow_bait","firefly_bait","star_bait","grilled_fish","berry_fish","hearty_fish","epic_fish","legendary_fish","strawberries","berry_compote","trail_ration","research_gear","blueberries","currants","blackberries","cranberries","strawberry_compote","blueberry_compote","currant_jelly","blackberry_preserve","cranberry_glaze","spice_bait","dusk_bait"]'::jsonb)
                ELSE '{}'::jsonb END
            ELSE '{}'::jsonb END AS next_settings
    FROM neighbor_settings
)
UPDATE neighbor_settings saved
SET settings=upgraded.next_settings, version=saved.version+1, updated_at=clock_timestamp()
FROM upgraded
WHERE saved.singleton=upgraded.singleton AND saved.settings IS DISTINCT FROM upgraded.next_settings;
