-- One server-owned selection per player. Refreshing or buying cannot refill its slots.
-- Listings retain their original price/escrow; this table only controls discovery and buying.
CREATE TABLE economy_market_showcases (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    refresh_at timestamptz NOT NULL,
    listing_ids uuid[] NOT NULL,
    CHECK (cardinality(listing_ids) <= 12)
);
