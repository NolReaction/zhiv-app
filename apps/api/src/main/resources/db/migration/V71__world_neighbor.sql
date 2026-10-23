-- A world character is deliberately not an app_users identity. All lifetime and
-- daily fences live outside economy_profiles so reset cannot replenish them.
ALTER TABLE economy_market_listings ADD COLUMN sale_buyer_character_id text
    CHECK (sale_buyer_character_id IS NULL OR (sale_buyer_character_id='berest' AND status='sold' AND buyer_id IS NULL AND sale_buyer_public_id IS NULL));
CREATE TABLE neighbor_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740990),
    settings jsonb NOT NULL CHECK (jsonb_typeof(settings)='object'),
    paused_reason text,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE neighbor_shop_cycles (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    cycle_day date NOT NULL,
    offers jsonb NOT NULL CHECK (jsonb_typeof(offers)='array' AND jsonb_array_length(offers)<=3),
    purchased_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(purchased_items)='array'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id,cycle_day)
);
CREATE TABLE neighbor_identity (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    first_buy_consumed boolean NOT NULL DEFAULT false
);
-- Existing confirmed real sales also consume the one-time newcomer relief.
-- Fresh databases still contain no seeded character/account or config rows.
INSERT INTO neighbor_identity(user_id,first_buy_consumed)
    SELECT DISTINCT seller_id,true FROM economy_market_listings WHERE status='sold';
CREATE TABLE neighbor_daily_usage (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    trade_day date NOT NULL,
    used_lots bigint NOT NULL DEFAULT 0 CHECK (used_lots BETWEEN 0 AND 10000000000),
    spent_coins bigint NOT NULL DEFAULT 0 CHECK (spent_coins BETWEEN 0 AND 10000000000),
    PRIMARY KEY(user_id,trade_day)
);
CREATE TABLE neighbor_global_usage (
    trade_day date PRIMARY KEY,
    spent_coins bigint NOT NULL DEFAULT 0 CHECK (spent_coins BETWEEN 0 AND 10000000000)
);
CREATE TABLE neighbor_receipts (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    signature text NOT NULL,
    message text NOT NULL,
    accepted_revision bigint NOT NULL CHECK (accepted_revision>=0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id,request_id)
);
CREATE TABLE neighbor_purchases (
    id uuid PRIMARY KEY,
    -- Retain the immutable trade snapshot even if a gameplay reset removes its lot.
    listing_id uuid NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    item_id text NOT NULL,
    quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 99),
    total_price bigint NOT NULL CHECK (total_price BETWEEN 1 AND 150),
    proceeds_coins bigint NOT NULL CHECK (proceeds_coins BETWEEN 0 AND total_price),
    source text NOT NULL CHECK (source IN ('auto','manual')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX neighbor_purchases_owner_date ON neighbor_purchases(user_id,created_at DESC);
CREATE INDEX neighbor_market_candidates ON economy_market_listings(created_at,id) WHERE status='active' AND total_price<=150;
-- Keep all previous immutable audit variants, extending the existing allowlist.
ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_reward_ck;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_reward_ck CHECK (
    (action='revoke_sessions' AND actor_public_id<>target_public_id AND reward_id IS NULL AND granted IS NULL AND payload IS NULL)
    OR (action='grant_item' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN ('flower','leaf_bed','keepsakes','leaf_garland') AND (payload IS NULL OR jsonb_typeof(payload)='object'))
    OR (action='grant_achievement' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN
        ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series',
         'ten_thousand_series','linked_email','saved_recovery_code','full_collection',
         'first_path','familiar_trails','explorer','master_recipes','home_builder','river_atlas','first_sale','lucky_find','patient_angler','campfire_cook','helpful_neighbor','generous_garden') AND (payload IS NULL OR jsonb_typeof(payload)='object'))
    OR (action IN ('grant_resource','grant_world_item','grant_find','set_tag','ban','unban','watch','unwatch','clear_signal')
        AND reward_id IS NULL AND granted IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
        AND changed IS NOT NULL AND (action NOT IN ('ban','unban') OR actor_public_id<>target_public_id))
    OR (action IN ('grant_economy','adjust_economy','mail_broadcast','promo_create','promo_update','promo_delete','neighbor_settings','neighbor_buy')
        AND reward_id IS NULL AND granted IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
        AND changed IS NOT NULL AND affected_sessions=0)
);
