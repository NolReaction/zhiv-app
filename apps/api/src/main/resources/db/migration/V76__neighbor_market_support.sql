-- Upgrade the former standard economic envelope as one coherent unit. Partial
-- administrator price/budget overrides are preserved, as are issued offers,
-- purchases, receipts and accrued usage. A custom name/outfit/stock is untouched.
UPDATE neighbor_settings
SET settings = settings || '{"sellPriceBps":22500,"buyPriceBps":20000,"dailyBudgetCoins":10000,"maxLotCoins":5000,"globalDailyBudgetCoins":10000000}'::jsonb,
    version = version + 1, updated_at = clock_timestamp()
WHERE settings @> '{"sellPriceBps":12500,"buyPriceBps":10000,"dailyBudgetCoins":300,"maxLotCoins":150,"globalDailyBudgetCoins":10000}'::jsonb;
