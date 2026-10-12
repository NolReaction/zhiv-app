-- Keep claims independently of the mutable economy profile: resets cannot reissue gifts.
-- Code text is never persisted here; promo_id is the operator's permanent campaign ID.
CREATE TABLE promo_redemptions (
    user_id uuid NOT NULL REFERENCES app_users(id),
    origin_user_id uuid NOT NULL REFERENCES app_users(id),
    promo_id text NOT NULL,
    request_id uuid NOT NULL,
    title text NOT NULL,
    reward jsonb NOT NULL,
    accepted_revision bigint NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, promo_id),
    CHECK (length(promo_id) BETWEEN 3 AND 64),
    CHECK (accepted_revision BETWEEN 1 AND 9007199254740991)
);

CREATE INDEX promo_redemptions_request ON promo_redemptions(user_id, origin_user_id, request_id);
