-- Lower only the recognized standard stock tariff. Administrator price/budget
-- overrides, issued daily offers, receipts and accrued usage remain unchanged.
UPDATE neighbor_settings
SET settings = settings || '{"sellPriceBps":12500}'::jsonb,
    version = version + 1, updated_at = clock_timestamp()
WHERE settings @> '{"sellPriceBps":22500,"buyPriceBps":20000,"dailyBudgetCoins":10000,"maxLotCoins":5000,"globalDailyBudgetCoins":10000000}'::jsonb;

-- Expand only the complete former ordinary pool, independently of price tuning.
-- Experimental dishes stay discoverable by cooking and never enter this stock.
UPDATE neighbor_settings
SET settings = jsonb_set(settings, '{allowedItemIds}', (settings->'allowedItemIds') || '["berry_tea","forest_pan"]'::jsonb),
    version = version + 1, updated_at = clock_timestamp()
WHERE CASE WHEN jsonb_typeof(settings->'allowedItemIds') = 'array' THEN
    jsonb_array_length(settings->'allowedItemIds') = 67
    AND settings->'allowedItemIds' @> '["berries","wood","stone","ore","fiber","planks","rope","metal_parts","dried_berries","smoked_fish","clay","sand","charcoal","iron_ingot","bricks","glass","hardwood","resin","cloth","beams","tools","reinforced_parts","cut_stone","crumb_bait","worm_bait","glow_bait","firefly_bait","star_bait","grilled_fish","fish_soup","berry_fish","hearty_fish","epic_fish","legendary_fish","strawberries","berry_compote","trail_ration","research_gear","blueberries","currants","blackberries","cranberries","strawberry_compote","blueberry_compote","currant_jelly","blackberry_preserve","cranberry_glaze","spice_bait","dusk_bait","quartz","limestone","ceramic_jar","mortar","glass_bottle","lens","packed_berries","trade_crate","field_kit","stone_tile","bottled_compote","berry_gift","grilled_silverfin","smoked_bream","mooncarp_blueberries","pike_berry_sauce","eel_in_jar","festive_sturgeon"]'::jsonb
    AND settings->'allowedItemIds' <@ '["berries","wood","stone","ore","fiber","planks","rope","metal_parts","dried_berries","smoked_fish","clay","sand","charcoal","iron_ingot","bricks","glass","hardwood","resin","cloth","beams","tools","reinforced_parts","cut_stone","crumb_bait","worm_bait","glow_bait","firefly_bait","star_bait","grilled_fish","fish_soup","berry_fish","hearty_fish","epic_fish","legendary_fish","strawberries","berry_compote","trail_ration","research_gear","blueberries","currants","blackberries","cranberries","strawberry_compote","blueberry_compote","currant_jelly","blackberry_preserve","cranberry_glaze","spice_bait","dusk_bait","quartz","limestone","ceramic_jar","mortar","glass_bottle","lens","packed_berries","trade_crate","field_kit","stone_tile","bottled_compote","berry_gift","grilled_silverfin","smoked_bream","mooncarp_blueberries","pike_berry_sauce","eel_in_jar","festive_sturgeon"]'::jsonb
    ELSE false END;
