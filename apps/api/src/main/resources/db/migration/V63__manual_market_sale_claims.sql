-- Purchases made before this migration were credited immediately. Fence them off
-- explicitly; neither their old nominal price nor their ledger may mint a second payout.
ALTER TABLE economy_market_listings
    ADD COLUMN sale_owner_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
    ADD COLUMN sale_proceeds_coins bigint,
    ADD COLUMN sale_buyer_public_id varchar(40),
    ADD COLUMN sale_buyer_name varchar(100),
    ADD COLUMN sale_claimed_at timestamptz;

UPDATE economy_market_listings SET sale_claimed_at=closed_at WHERE status='sold';

ALTER TABLE economy_market_listings ADD CONSTRAINT economy_market_sale_state_ck CHECK (
    (status <> 'sold' AND sale_owner_id IS NULL AND sale_proceeds_coins IS NULL
        AND sale_buyer_public_id IS NULL AND sale_buyer_name IS NULL AND sale_claimed_at IS NULL)
    OR (status='sold' AND sale_owner_id IS NULL AND sale_proceeds_coins IS NULL
        AND sale_buyer_public_id IS NULL AND sale_buyer_name IS NULL AND sale_claimed_at IS NOT NULL)
    OR (status='sold' AND currency_scale=10 AND sale_owner_id IS NOT NULL
        AND sale_proceeds_coins IS NOT NULL AND sale_proceeds_coins BETWEEN 0 AND total_price
        AND sale_buyer_name IS NOT NULL AND length(sale_buyer_name) BETWEEN 1 AND 100
        AND (sale_buyer_public_id IS NULL OR length(sale_buyer_public_id) BETWEEN 1 AND 40)
        AND (sale_claimed_at IS NULL OR sale_claimed_at >= closed_at))
);

CREATE INDEX economy_market_pending_sale_owner ON economy_market_listings(sale_owner_id, closed_at DESC, id DESC)
    WHERE status='sold' AND sale_claimed_at IS NULL;

-- A public buyer snapshot is visible only to the proceeds owner. Account deletion
-- must also remove it from persistent receipts; private avatar storage keys never enter it.
CREATE FUNCTION redact_deleted_market_buyer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
        UPDATE economy_market_listings
        SET sale_buyer_public_id=NULL, sale_buyer_name='Удалённый профиль'
        WHERE sale_buyer_public_id=OLD.public_id AND sale_proceeds_coins IS NOT NULL;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER app_users_redact_market_buyer_after_delete
    AFTER UPDATE OF deleted_at OR DELETE ON app_users
    FOR EACH ROW EXECUTE FUNCTION redact_deleted_market_buyer();
