-- An offer escrows exactly one special item. No price, currencies or variable quantities.
CREATE TABLE economy_barter_offers (
    id uuid PRIMARY KEY,
    seller_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    buyer_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    offered_item_id text NOT NULL CHECK (length(offered_item_id) BETWEEN 1 AND 80),
    requested_item_id text NOT NULL CHECK (length(requested_item_id) BETWEEN 1 AND 80),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exchanged', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at timestamptz,
    CHECK (offered_item_id <> requested_item_id),
    CHECK (buyer_id IS NULL OR buyer_id <> seller_id),
    CHECK ((status = 'active' AND closed_at IS NULL AND buyer_id IS NULL)
        OR (status = 'exchanged' AND closed_at IS NOT NULL)
        OR (status = 'cancelled' AND closed_at IS NOT NULL AND buyer_id IS NULL))
);
CREATE INDEX economy_barter_active_feed ON economy_barter_offers(created_at DESC,id DESC) WHERE status='active';
CREATE INDEX economy_barter_seller_active ON economy_barter_offers(seller_id,created_at DESC) WHERE status='active';

CREATE TABLE economy_barter_receipts (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    signature text NOT NULL,
    message text NOT NULL,
    accepted_revision bigint NOT NULL CHECK (accepted_revision >= 0),
    offer jsonb NOT NULL CHECK (jsonb_typeof(offer) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id,request_id)
);

CREATE TABLE economy_barter_showcases (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    refresh_at timestamptz NOT NULL,
    offer_ids uuid[] NOT NULL,
    CHECK (cardinality(offer_ids) <= 6)
);
