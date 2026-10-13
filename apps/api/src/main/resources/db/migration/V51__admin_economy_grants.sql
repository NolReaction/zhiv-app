-- Keep the immutable audit as the one global idempotency fence for admin writes.
ALTER TABLE admin_actions ADD COLUMN accepted_revision bigint;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_revision_ck CHECK (
    (action='grant_economy' AND accepted_revision IS NOT NULL AND accepted_revision BETWEEN 0 AND 9007199254740991)
    OR (action<>'grant_economy' AND accepted_revision IS NULL)
);
ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_reward_ck;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_reward_ck CHECK (
    (action='revoke_sessions' AND actor_public_id<>target_public_id AND reward_id IS NULL AND granted IS NULL AND payload IS NULL)
    OR (action='grant_item' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN ('flower','leaf_bed','keepsakes','leaf_garland') AND payload IS NULL)
    OR (action='grant_achievement' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN
        ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series',
         'ten_thousand_series','linked_email','saved_recovery_code','full_collection',
         'first_path','familiar_trails','explorer','master_recipes','home_builder','river_atlas','first_sale','lucky_find') AND payload IS NULL)
    OR (action IN ('grant_resource','grant_world_item','grant_find','set_tag','ban','unban','watch','unwatch','clear_signal')
        AND reward_id IS NULL AND granted IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
        AND changed IS NOT NULL AND (action NOT IN ('ban','unban') OR actor_public_id<>target_public_id))
    OR (action IN ('grant_economy','promo_create','promo_update','promo_delete')
        AND reward_id IS NULL AND granted IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
        AND changed IS NOT NULL AND affected_sessions=0)
);
