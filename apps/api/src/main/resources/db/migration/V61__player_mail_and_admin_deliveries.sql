-- Persistent account-bound letters. They describe changes already applied by
-- their originating transaction and never expose a second reward claim.
CREATE TABLE player_mail_messages (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 160 AND source_key ~ '^[a-z]+:[A-Za-z0-9:_-]+$'),
    type text NOT NULL CHECK (type IN ('admin_notice','admin_grant','event','balance_correction')),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title=btrim(title)),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000 AND body=btrim(body)),
    notify boolean NOT NULL DEFAULT false,
    attachments jsonb CHECK (attachments IS NULL OR (jsonb_typeof(attachments)='object' AND octet_length(attachments::text)<=32768)),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    read_at timestamptz,
    UNIQUE(user_id,source_key)
);
CREATE INDEX player_mail_messages_inbox_idx ON player_mail_messages(user_id,created_at DESC,id DESC);
CREATE INDEX player_mail_messages_unread_idx ON player_mail_messages(user_id,created_at DESC,id DESC) WHERE read_at IS NULL;
CREATE INDEX player_mail_messages_notify_idx ON player_mail_messages(user_id,created_at DESC,id DESC) WHERE notify AND read_at IS NULL;

-- The immutable admin_actions row remains the global requestId fence. A saved
-- count and fixed fanout prevent reselecting a new audience after a lost reply.
CREATE TABLE admin_mail_broadcasts (
    request_id uuid PRIMARY KEY REFERENCES admin_actions(request_id) ON DELETE CASCADE,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title=btrim(title)),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000 AND body=btrim(body)),
    audience text NOT NULL CHECK (audience IN ('all','players')),
    notify boolean NOT NULL,
    recipient_count bigint NOT NULL CHECK (recipient_count BETWEEN 0 AND 10000),
    created_at timestamptz NOT NULL
);
CREATE INDEX admin_mail_broadcasts_history_idx ON admin_mail_broadcasts(created_at DESC,request_id DESC);

ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_revision_ck;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_revision_ck CHECK (
    (action IN ('grant_economy','adjust_economy') AND accepted_revision IS NOT NULL AND accepted_revision BETWEEN 0 AND 9007199254740991)
    OR (action NOT IN ('grant_economy','adjust_economy') AND accepted_revision IS NULL)
);
ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_reward_ck;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_reward_ck CHECK (
    (action='revoke_sessions' AND actor_public_id<>target_public_id AND reward_id IS NULL AND granted IS NULL AND payload IS NULL)
    OR (action='grant_item' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN ('flower','leaf_bed','keepsakes','leaf_garland') AND (payload IS NULL OR jsonb_typeof(payload)='object'))
    OR (action='grant_achievement' AND affected_sessions=0 AND granted IS NOT NULL AND reward_id IS NOT NULL AND reward_id IN
        ('seven_day_streak','thousand_taps','five_friends','thirty_day_streak','ten_thousand_taps','hundred_series',
         'ten_thousand_series','linked_email','saved_recovery_code','full_collection',
         'first_path','familiar_trails','explorer','master_recipes','home_builder','river_atlas','first_sale','lucky_find') AND (payload IS NULL OR jsonb_typeof(payload)='object'))
    OR (action IN ('grant_resource','grant_world_item','grant_find','set_tag','ban','unban','watch','unwatch','clear_signal')
        AND reward_id IS NULL AND granted IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
        AND changed IS NOT NULL AND (action NOT IN ('ban','unban') OR actor_public_id<>target_public_id))
    OR (action IN ('grant_economy','adjust_economy','mail_broadcast','promo_create','promo_update','promo_delete')
        AND reward_id IS NULL AND granted IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
        AND changed IS NOT NULL AND affected_sessions=0)
);

ALTER TABLE notification_events DROP CONSTRAINT notification_events_category_check;
ALTER TABLE notification_events ADD CONSTRAINT notification_events_category_check
    CHECK (category IN ('construction','exploration','production','checkin','mail'));

-- Source synchronization keeps the original pending/delivered mail fence.
-- It never recreates mail events after subscription changes or account merges.
CREATE OR REPLACE FUNCTION notification_sync_sources_at(p_user uuid, p_now timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    jobs jsonb; job jsonb; last_check timestamptz; check_key text;
    actor_finishes timestamptz; legacy_journey boolean; harvest boolean;
    indefinite_wait boolean; actor_wait boolean; wait_until timestamptz;
    ready_since timestamptz; ready_at timestamptz; attempt_at timestamptz;
    previous notification_events%ROWTYPE;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM notification_preferences WHERE user_id=p_user) THEN RETURN; END IF;
    SELECT coalesce(state->'jobs','[]'::jsonb) INTO jobs FROM economy_profiles WHERE user_id=p_user;
    jobs := coalesce(jobs,'[]'::jsonb);
    SELECT max((j->>'finishesAt')::timestamptz) INTO actor_finishes
        FROM jsonb_array_elements(jobs) j
        WHERE (j->>'kind'='exploration' AND j->>'actorId' IS DISTINCT FROM 'miner')
            OR (j->>'kind'='production' AND j->>'targetId'='quarry');
    SELECT coalesce(jsonb_array_length(state->'journeys'),0)>0 INTO legacy_journey FROM world_profiles WHERE user_id=p_user;
    SELECT last_check_in_at INTO last_check FROM account_check_in_summary(p_user);
    check_key := CASE WHEN last_check IS NULL THEN NULL ELSE 'checkin:' || extract(epoch FROM last_check)::text END;
    DELETE FROM notification_events e WHERE e.user_id=p_user AND (
        (category='checkin' AND source_key IS DISTINCT FROM check_key) OR
        (category NOT IN ('checkin','mail') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jobs) j WHERE 'job:' || (j->>'id')=e.source_key)) OR
        (category='mail' AND NOT EXISTS(SELECT 1 FROM player_mail_messages m WHERE m.user_id=p_user AND m.notify AND m.read_at IS NULL AND 'mail:'||m.id::text=e.source_key))
    );
    IF NOT EXISTS(SELECT 1 FROM notification_subscriptions n JOIN app_sessions s ON s.id=n.session_id
        WHERE n.user_id=p_user AND s.user_id=p_user AND s.revoked_at IS NULL AND s.expires_at>p_now) THEN RETURN; END IF;
    FOR job IN SELECT j FROM jsonb_array_elements(jobs) j WHERE j->>'kind' IN ('construction','exploration','production') LOOP
        SELECT * INTO previous FROM notification_events WHERE user_id=p_user AND source_key='job:' || (job->>'id');
        ready_at := greatest((job->>'finishesAt')::timestamptz, nullif(job->'collection'->>'finishesAt','')::timestamptz);
        harvest := coalesce(job->'collection'->>'kind'='berry_harvest' AND job->'collection'->>'startedAt' IS NULL,false);
        actor_wait := false; wait_until := NULL; ready_since := NULL;
        IF harvest THEN
            indefinite_wait := coalesce(legacy_journey,false) OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(jobs) j WHERE j->>'id'<>job->>'id' AND j->'collection'->>'startedAt' IS NOT NULL
            );
            actor_wait := indefinite_wait OR coalesce(actor_finishes>p_now,false);
            ready_at := greatest(ready_at,actor_finishes);
            IF actor_wait THEN
                wait_until := CASE WHEN indefinite_wait THEN NULL ELSE actor_finishes END;
            ELSIF coalesce(previous.waiting_for_actor,false) THEN
                -- Known return uses its actual timer, early cancellation uses
                -- now, and an indefinite ownership ends with its source write.
                ready_since := greatest(ready_at,coalesce(least(previous.actor_wait_until,p_now),p_now));
            ELSIF previous.harvest_ready_at IS NOT NULL THEN
                ready_since := greatest(ready_at,previous.harvest_ready_at);
            ELSIF ready_at<=p_now THEN
                ready_since := ready_at;
            END IF;
            IF ready_since>p_now THEN ready_since := NULL; END IF;
            ready_at := coalesce(ready_since,ready_at);
        END IF;
        attempt_at := CASE WHEN actor_wait AND wait_until IS NULL THEN greatest(ready_at,p_now+interval '5 minutes') ELSE ready_at END;
        INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at,harvest_ready_at,waiting_for_actor,actor_wait_until)
        VALUES(p_user,'job:' || (job->>'id'),job->>'kind',ready_at,attempt_at,ready_since,actor_wait,wait_until)
        ON CONFLICT(user_id,source_key) DO UPDATE SET
            due_at=EXCLUDED.due_at,
            next_attempt_at=CASE WHEN notification_events.due_at IS DISTINCT FROM EXCLUDED.due_at
                OR notification_events.waiting_for_actor IS DISTINCT FROM EXCLUDED.waiting_for_actor
                THEN EXCLUDED.next_attempt_at ELSE notification_events.next_attempt_at END,
            harvest_ready_at=EXCLUDED.harvest_ready_at,
            waiting_for_actor=EXCLUDED.waiting_for_actor,
            actor_wait_until=EXCLUDED.actor_wait_until
            WHERE notification_events.state IN ('pending','sending');
    END LOOP;
    IF last_check IS NOT NULL THEN
        INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at)
        VALUES(p_user,check_key,'checkin',last_check+interval '24 hours 1 second',last_check+interval '24 hours 1 second')
        ON CONFLICT(user_id,source_key) DO NOTHING;
    END IF;
END $$;
