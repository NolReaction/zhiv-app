-- Preserve already agreed seller proceeds; only newly created listings carry the catalog fee.
ALTER TABLE economy_market_listings ADD COLUMN seller_fee_bps integer NOT NULL DEFAULT 0
    CHECK (seller_fee_bps BETWEEN 0 AND 10000);

-- This fence is independent of economy_profiles: resetting a farm cannot restore today's allowance.
-- Amounts use catalog base sale prices, not negotiated prices or premium balances.
CREATE TABLE economy_market_daily_turnover (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    trade_day date NOT NULL,
    buys_value bigint NOT NULL DEFAULT 0 CHECK (buys_value BETWEEN 0 AND 10000000000),
    sales_value bigint NOT NULL DEFAULT 0 CHECK (sales_value BETWEEN 0 AND 10000000000),
    barter_used bigint NOT NULL DEFAULT 0 CHECK (barter_used BETWEEN 0 AND 10000000000),
    PRIMARY KEY(user_id, trade_day)
);
