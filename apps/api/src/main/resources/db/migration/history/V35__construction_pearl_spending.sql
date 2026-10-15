-- Existing audit rows remain valid: pearls had no spending command before V35.
-- Wallet debit, construction completion and this delta commit in one transaction.
ALTER TABLE economy_ledger ADD COLUMN pearls bigint NOT NULL DEFAULT 0
    CHECK (pearls BETWEEN -1000000000 AND 1000000000);
