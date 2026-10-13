-- Both currencies change denomination, never buying power. Catalog v3 uses ten
-- nominal units for one retired unit. This migration must precede new API writers.
-- Audit amounts/signatures and original claim JSON remain immutable: their unit is
-- recorded separately and current readers project it without crediting wallets.
ALTER TABLE economy_ledger ADD COLUMN currency_scale smallint NOT NULL DEFAULT 1 CHECK (currency_scale IN (1,10));
ALTER TABLE economy_ledger ALTER COLUMN currency_scale SET DEFAULT 10;
ALTER TABLE economy_conversion_audit ADD COLUMN currency_scale smallint NOT NULL DEFAULT 1 CHECK (currency_scale IN (1,10));
ALTER TABLE economy_conversion_audit ALTER COLUMN currency_scale SET DEFAULT 10;
ALTER TABLE game_reward_claims ADD COLUMN currency_scale smallint NOT NULL DEFAULT 1 CHECK (currency_scale IN (1,10));
ALTER TABLE game_reward_claims ALTER COLUMN currency_scale SET DEFAULT 10;
ALTER TABLE game_achievement_reward_claims ADD COLUMN currency_scale smallint NOT NULL DEFAULT 1 CHECK (currency_scale IN (1,10));
ALTER TABLE game_achievement_reward_claims ALTER COLUMN currency_scale SET DEFAULT 10;
ALTER TABLE economy_market_listings ADD COLUMN currency_scale smallint NOT NULL DEFAULT 1 CHECK (currency_scale IN (1,10));
ALTER TABLE economy_market_listings ALTER COLUMN currency_scale SET DEFAULT 10;

-- Frozen V1/V2 conversion functions stay unchanged for historical migrations.
CREATE FUNCTION economy_currency_nominal_state(value jsonb) RETURNS jsonb
LANGUAGE SQL IMMUTABLE STRICT AS $$
    SELECT CASE WHEN coalesce(value->>'currencyScale','1')='10' THEN value ELSE
        value || jsonb_build_object('currencyScale',10,
            'wallet',(value->'wallet') || jsonb_build_object(
                'coins',(value->'wallet'->>'coins')::bigint*10,
                'pearls',(value->'wallet'->>'pearls')::bigint*10),
            'migration',(value->'migration') || jsonb_build_object(
                'coinsGranted',(value->'migration'->>'coinsGranted')::bigint*10),
            'jobs',coalesce((SELECT jsonb_agg(jsonb_set(job,'{cost,coins}',
                    to_jsonb((job->'cost'->>'coins')::bigint*10)) ORDER BY ordinal)
                FROM jsonb_array_elements(value->'jobs') WITH ORDINALITY AS ordered(job,ordinal)),'[]'::jsonb)) END
$$;
CREATE FUNCTION economy_v3_initial_state(legacy jsonb) RETURNS jsonb
LANGUAGE SQL IMMUTABLE STRICT AS $$ SELECT economy_currency_nominal_state(economy_v2_initial_state(legacy)) $$;

-- Old unnamed wallet CHECKs are located by their definition; unrelated storage,
-- schema and job constraints are preserved, irrespective of PostgreSQL numbering.
DO $$ DECLARE constraint_name text; BEGIN
    FOR constraint_name IN SELECT conname FROM pg_constraint
        WHERE conrelid='economy_profiles'::regclass AND contype='c'
          AND position('wallet' IN pg_get_constraintdef(oid))>0
    LOOP EXECUTE format('ALTER TABLE economy_profiles DROP CONSTRAINT %I',constraint_name); END LOOP;
    IF EXISTS(SELECT 1 FROM economy_profiles WHERE coalesce(state->>'currencyScale','1') NOT IN ('1','10')) THEN
        RAISE EXCEPTION 'Unsupported saved currency denomination';
    END IF;
END $$;
ALTER TABLE economy_profiles ADD CONSTRAINT economy_profiles_wallet_nominal_ck CHECK (
    (jsonb_typeof(state->'wallet')='object') IS TRUE
    AND (((state->'wallet'->>'coins')::bigint BETWEEN 0 AND 10000000000)) IS TRUE
    AND (((state->'wallet'->>'pearls')::bigint BETWEEN 0 AND 10000000000)) IS TRUE
);
UPDATE economy_profiles SET state=economy_currency_nominal_state(state),
    revision=least(9007199254740991,revision+1),updated_at=clock_timestamp()
WHERE coalesce(state->>'currencyScale','1')='1';
ALTER TABLE economy_profiles ADD CONSTRAINT economy_profiles_currency_scale_ck CHECK ((state->>'currencyScale'='10') IS TRUE);

ALTER TABLE economy_conversion_audit DROP CONSTRAINT economy_conversion_audit_coins_granted_check;
ALTER TABLE economy_conversion_audit ADD CONSTRAINT economy_conversion_audit_coins_nominal_ck CHECK (coins_granted BETWEEN 0 AND 500*currency_scale);
ALTER TABLE economy_ledger DROP CONSTRAINT economy_ledger_pearls_check;
ALTER TABLE economy_ledger ADD CONSTRAINT economy_ledger_pearls_nominal_ck CHECK (pearls BETWEEN -10000000000 AND 10000000000);
ALTER TABLE game_achievement_reward_claims DROP CONSTRAINT game_achievement_reward_claims_pearls_check;
ALTER TABLE game_achievement_reward_claims ADD CONSTRAINT game_achievement_reward_claims_pearls_nominal_ck CHECK (pearls BETWEEN 1 AND 10000000000);
ALTER TABLE economy_market_listings DROP CONSTRAINT economy_market_listings_total_price_check;
ALTER TABLE economy_market_listings ADD CONSTRAINT economy_market_listings_price_nominal_ck CHECK (total_price BETWEEN 1 AND 10000000000);
-- Only live offers are operational money. Closed offers retain their original
-- price/denomination for audit and are projected on read; item escrow is unchanged.
UPDATE economy_market_listings SET total_price=total_price*10,currency_scale=10 WHERE status='active' AND currency_scale=1;
ALTER TABLE economy_market_listings ADD CONSTRAINT economy_market_listings_live_nominal_ck CHECK (
    status<>'active' OR (currency_scale=10 AND total_price%10=0));
