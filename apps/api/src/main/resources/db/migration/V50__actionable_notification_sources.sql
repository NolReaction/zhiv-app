-- Keep the first actionable time of a ripe harvest separate from its growth
-- timer. Actor waits must not expire a crop, or repeatedly renew a free crop.
ALTER TABLE notification_events
    ADD COLUMN harvest_ready_at timestamptz,
    ADD COLUMN waiting_for_actor boolean NOT NULL DEFAULT false,
    ADD COLUMN actor_wait_until timestamptz;

-- The worker supplies its clock; economy/world triggers use the DB clock.
-- One stable source key covers ripening and collection, never reviving a
-- delivered, dismissed or uncertain source during the phase transition.
CREATE FUNCTION notification_sync_sources_at(p_user uuid, p_now timestamptz) RETURNS void LANGUAGE plpgsql AS $$
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
        WHERE j->>'kind'='exploration' OR (j->>'kind'='production' AND j->>'targetId'='quarry');
    SELECT coalesce(jsonb_array_length(state->'journeys'),0)>0 INTO legacy_journey FROM world_profiles WHERE user_id=p_user;
    SELECT last_check_in_at INTO last_check FROM account_check_in_summary(p_user);
    check_key := CASE WHEN last_check IS NULL THEN NULL ELSE 'checkin:' || extract(epoch FROM last_check)::text END;
    DELETE FROM notification_events e WHERE e.user_id=p_user AND (
        (category='checkin' AND source_key IS DISTINCT FROM check_key) OR
        (category<>'checkin' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jobs) j WHERE 'job:' || (j->>'id')=e.source_key))
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

CREATE OR REPLACE FUNCTION notification_sync_sources(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM notification_sync_sources_at(p_user,clock_timestamp()); END $$;

-- A legacy journey holds the actor even after its timer until claimed. Record
-- its removal at the actual write, instead of renewing freshness each poll.
CREATE TRIGGER notification_legacy_journey_inserted AFTER INSERT ON world_profiles
    FOR EACH ROW WHEN (coalesce(jsonb_array_length(NEW.state->'journeys'),0)>0)
    EXECUTE FUNCTION notification_economy_changed();
CREATE TRIGGER notification_legacy_journey_changed AFTER UPDATE OF state ON world_profiles
    FOR EACH ROW WHEN (OLD.state->'journeys' IS DISTINCT FROM NEW.state->'journeys')
    EXECUTE FUNCTION notification_economy_changed();

-- Backfill existing subscribed profiles once. Ripe crops and plain garden fiber
-- must not depend on the player reopening the game to discover their source.
DO $$
DECLARE subscribed_user uuid;
BEGIN
    FOR subscribed_user IN
        SELECT DISTINCT n.user_id FROM notification_subscriptions n
        JOIN app_sessions s ON s.id=n.session_id AND s.user_id=n.user_id
        WHERE s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    LOOP
        PERFORM notification_sync_sources(subscribed_user);
    END LOOP;
END $$;
