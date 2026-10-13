-- Preferences do not grant browser permission. Subscriptions belong to the
-- exact authenticated session, and are never carried into another identity.
CREATE TABLE notification_preferences (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    preferences jsonb NOT NULL,
    last_visible_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE notification_subscriptions (
    endpoint_hash bytea PRIMARY KEY CHECK(octet_length(endpoint_hash)=32),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,
    endpoint text NOT NULL CHECK(length(endpoint) BETWEEN 20 AND 2048),
    p256dh varchar(100) NOT NULL,
    auth varchar(40) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(session_id,user_id) REFERENCES app_sessions(id,user_id) ON DELETE CASCADE
);
CREATE INDEX notification_subscriptions_user ON notification_subscriptions(user_id,updated_at DESC);
CREATE INDEX notification_subscriptions_session ON notification_subscriptions(session_id);

-- At most one current row per live job (and last real check-in). Terminal rows
-- survive preference edits and unrelated state saves, until that source is gone.
CREATE TABLE notification_events (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    source_key text NOT NULL,
    category varchar(16) NOT NULL CHECK(category IN ('construction','exploration','production','checkin')),
    due_at timestamptz NOT NULL,
    next_attempt_at timestamptz NOT NULL,
    state varchar(16) NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','delivered','dismissed','uncertain')),
    attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
    batch_id uuid,
    PRIMARY KEY(user_id,source_key)
);
CREATE INDEX notification_events_due ON notification_events(next_attempt_at,user_id) WHERE state='pending';
CREATE TABLE notification_batches (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    reserved_at timestamptz NOT NULL,
    state varchar(16) NOT NULL CHECK(state IN ('sending','delivered','dismissed','failed','uncertain')),
    finished_at timestamptz
);
CREATE INDEX notification_batches_budget ON notification_batches(user_id,reserved_at DESC)
    WHERE state IN ('sending','delivered','uncertain');
CREATE INDEX notification_batches_cleanup ON notification_batches(reserved_at);
CREATE INDEX notification_batches_sending ON notification_batches(reserved_at) WHERE state='sending';

-- Invoked inside each economy commit. No timer scans every JSONB profile.
CREATE FUNCTION notification_sync_sources(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE jobs jsonb; last_check timestamptz; check_key text;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM notification_preferences WHERE user_id=p_user) THEN RETURN; END IF;
    SELECT coalesce(state->'jobs','[]'::jsonb) INTO jobs FROM economy_profiles WHERE user_id=p_user;
    jobs := coalesce(jobs,'[]'::jsonb);
    SELECT last_check_in_at INTO last_check FROM account_check_in_summary(p_user);
    check_key := CASE WHEN last_check IS NULL THEN NULL ELSE 'checkin:' || extract(epoch FROM last_check)::text END;
    DELETE FROM notification_events e WHERE e.user_id=p_user AND (
        (category='checkin' AND source_key IS DISTINCT FROM check_key) OR
        (category<>'checkin' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jobs) j WHERE 'job:' || (j->>'id')=e.source_key))
    );
    IF NOT EXISTS(SELECT 1 FROM notification_subscriptions n JOIN app_sessions s ON s.id=n.session_id
        WHERE n.user_id=p_user AND s.user_id=p_user AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RETURN; END IF;
    INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at)
    SELECT p_user,'job:' || (j->>'id'),j->>'kind',ready_at,ready_at
    FROM jsonb_array_elements(jobs) j
    CROSS JOIN LATERAL (SELECT CASE
        WHEN j->>'targetId'='garden'
            THEN nullif(j->'collection'->>'finishesAt','')::timestamptz
        ELSE (j->>'finishesAt')::timestamptz END AS ready_at) r
    WHERE j->>'kind' IN ('construction','exploration','production') AND ready_at IS NOT NULL
    ON CONFLICT(user_id,source_key) DO UPDATE SET due_at=EXCLUDED.due_at,
        next_attempt_at=CASE WHEN notification_events.due_at IS DISTINCT FROM EXCLUDED.due_at
            THEN EXCLUDED.due_at ELSE notification_events.next_attempt_at END
        WHERE notification_events.state IN ('pending','sending');
    -- A garden is not collectible when it merely ripens. Starting collection
    -- schedules its actual finish; removing/cancelling it removes the event.
    DELETE FROM notification_events e WHERE e.user_id=p_user AND e.category='production' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(jobs) j WHERE 'job:' || (j->>'id')=e.source_key
            AND j->>'targetId'='garden'
            AND j->'collection'->>'finishesAt' IS NULL
    );
    IF last_check IS NOT NULL THEN
        INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at)
        VALUES(p_user,check_key,'checkin',last_check+interval '24 hours 1 second',last_check+interval '24 hours 1 second')
        ON CONFLICT(user_id,source_key) DO NOTHING;
    END IF;
END $$;
CREATE FUNCTION notification_economy_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM notification_sync_sources(NEW.user_id); RETURN NEW; END $$;
CREATE TRIGGER notification_economy_changed AFTER INSERT OR UPDATE OF state ON economy_profiles
    FOR EACH ROW EXECUTE FUNCTION notification_economy_changed();
CREATE FUNCTION notification_checkin_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM notification_sync_sources(NEW.user_id); RETURN NEW; END $$;
CREATE TRIGGER notification_checkin_changed AFTER INSERT ON check_ins
    FOR EACH ROW EXECUTE FUNCTION notification_checkin_changed();

-- Logout, recovery, session transfer and deletion cannot retain a subscription.
CREATE FUNCTION notification_session_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.revoked_at IS NOT NULL OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
        DELETE FROM notification_subscriptions WHERE session_id=OLD.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_session_invalidated BEFORE UPDATE OF revoked_at,user_id,token_hash ON app_sessions
    FOR EACH ROW EXECUTE FUNCTION notification_session_invalidated();
CREATE FUNCTION notification_account_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL OR NEW.banned_at IS NOT NULL THEN
        DELETE FROM notification_subscriptions WHERE user_id=NEW.id;
        DELETE FROM notification_events WHERE user_id=NEW.id;
        DELETE FROM notification_preferences WHERE user_id=NEW.id;
        DELETE FROM notification_batches WHERE user_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_account_invalidated AFTER UPDATE OF deleted_at,banned_at ON app_users
    FOR EACH ROW EXECUTE FUNCTION notification_account_invalidated();

-- Merging can introduce the first check-in into an already subscribed target.
-- It must schedule that history even when no economic job will wake the worker.
CREATE FUNCTION notification_merge_history_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM notification_sync_sources(NEW.target_user_id);
    IF TG_OP='UPDATE' AND OLD.target_user_id IS DISTINCT FROM NEW.target_user_id THEN
        PERFORM notification_sync_sources(OLD.target_user_id);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_merge_history_changed AFTER INSERT OR UPDATE OF target_user_id ON account_merge_sources
    FOR EACH ROW EXECUTE FUNCTION notification_merge_history_changed();
