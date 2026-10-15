-- A listing owns its finite lot until one atomic sale or cancellation.
-- Prices are for the whole lot, in earned coins; premium currency is excluded.
CREATE TABLE economy_market_listings (
    id uuid PRIMARY KEY,
    seller_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    buyer_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    item_id text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 80),
    quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 99),
    total_price bigint NOT NULL CHECK (total_price BETWEEN 1 AND 1000000000),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at timestamptz,
    CHECK (buyer_id IS NULL OR buyer_id <> seller_id),
    CHECK ((status = 'active' AND closed_at IS NULL AND buyer_id IS NULL)
        OR (status = 'sold' AND closed_at IS NOT NULL)
        OR (status = 'cancelled' AND closed_at IS NOT NULL AND buyer_id IS NULL))
);
CREATE INDEX economy_market_active_feed ON economy_market_listings(created_at DESC, id DESC) WHERE status = 'active';
CREATE INDEX economy_market_seller_active ON economy_market_listings(seller_id, created_at DESC) WHERE status = 'active';

CREATE TABLE economy_market_receipts (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    signature text NOT NULL,
    message text NOT NULL,
    accepted_revision bigint NOT NULL CHECK (accepted_revision >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id, request_id)
);
