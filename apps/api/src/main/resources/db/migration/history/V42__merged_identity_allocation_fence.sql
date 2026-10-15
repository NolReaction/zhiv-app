-- A method used in a merge must not manufacture fresh reward-bearing profiles
-- while the profile that received its progress still exists. Keep only its digest.
-- Older retirements lack a reliable merge target and intentionally remain unbound.
ALTER TABLE account_identity_retirements
    ADD COLUMN merged_into_user_id uuid REFERENCES app_users(id);
CREATE INDEX account_identity_retirements_merged_idx
    ON account_identity_retirements(merged_into_user_id)
    WHERE merged_into_user_id IS NOT NULL;
