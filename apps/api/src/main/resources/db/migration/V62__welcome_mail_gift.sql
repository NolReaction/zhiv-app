-- Only the explicit welcome letter has a manually claimable gift. Historical
-- admin attachments remain receipts of already applied grants/corrections.
ALTER TABLE player_mail_messages ADD COLUMN welcome_claimed_at timestamptz;
ALTER TABLE player_mail_messages ADD CONSTRAINT player_mail_welcome_claim_ck
    CHECK (welcome_claimed_at IS NULL OR (source_key='welcome:v1' AND type='event' AND attachments IS NULL));

-- No currency is credited by this migration. Delivery is lazy and owner-bound;
-- the account-persistent mail row is the one-time fence, including game resets.
