-- Runtime campaign definitions override packaged JSON by permanent campaign ID.
-- Tombstones remain: deleting a campaign never restores its packaged version or receipts.
CREATE TABLE managed_promo_codes (
    promo_id text PRIMARY KEY CHECK (promo_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
    code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
    version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    CHECK (definition->>'id'=promo_id AND definition->>'code'=code)
);
CREATE INDEX promo_redemptions_campaign_idx ON promo_redemptions(promo_id);
