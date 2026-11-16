-- Mobile device registration is bound to the authenticated platform, never a label.
-- Existing sessions deliberately remain NULL and must reconnect for native push.
ALTER TABLE app_sessions ADD COLUMN mobile_platform varchar(7)
    CHECK (mobile_platform IN ('ios','android'));

CREATE TABLE native_notification_subscriptions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,
    platform varchar(7) NOT NULL CHECK (platform IN ('ios','android')),
    token varchar(4096) NOT NULL CHECK (length(token) BETWEEN 16 AND 4096),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(session_id,user_id) REFERENCES app_sessions(id,user_id) ON DELETE CASCADE,
    UNIQUE(session_id,platform)
);
CREATE INDEX native_notification_subscriptions_user ON native_notification_subscriptions(user_id,updated_at DESC);

CREATE FUNCTION native_notification_session_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.revoked_at IS NOT NULL OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.mobile_platform IS DISTINCT FROM OLD.mobile_platform THEN
        DELETE FROM native_notification_subscriptions WHERE session_id=OLD.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER native_notification_session_invalidated BEFORE UPDATE OF revoked_at,user_id,token_hash,mobile_platform ON app_sessions
    FOR EACH ROW EXECUTE FUNCTION native_notification_session_invalidated();

CREATE FUNCTION native_notification_account_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL OR NEW.banned_at IS NOT NULL THEN
        DELETE FROM native_notification_subscriptions WHERE user_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER native_notification_account_invalidated AFTER UPDATE OF deleted_at,banned_at ON app_users
    FOR EACH ROW EXECUTE FUNCTION native_notification_account_invalidated();

-- Retain the entire published actionable timer implementation. Native devices
-- schedule game timers locally; only check-in and newly authored mail use push.
ALTER FUNCTION notification_sync_sources_at(uuid,timestamptz) RENAME TO notification_sync_web_sources_at;
CREATE FUNCTION notification_sync_sources_at(p_user uuid,p_now timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE last_check timestamptz; check_key text;
BEGIN
    PERFORM notification_sync_web_sources_at(p_user,p_now);
    IF NOT EXISTS(SELECT 1 FROM notification_preferences WHERE user_id=p_user) THEN RETURN; END IF;
    IF NOT EXISTS(SELECT 1 FROM native_notification_subscriptions n
        JOIN app_sessions s ON s.id=n.session_id AND s.user_id=n.user_id AND s.mobile_platform=n.platform
        WHERE n.user_id=p_user AND s.revoked_at IS NULL AND s.expires_at>p_now) THEN RETURN; END IF;
    SELECT last_check_in_at INTO last_check FROM account_check_in_summary(p_user);
    IF last_check IS NOT NULL THEN
        check_key := 'checkin:' || extract(epoch FROM last_check)::text;
        INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at)
        VALUES(p_user,check_key,'checkin',last_check+interval '24 hours 1 second',last_check+interval '24 hours 1 second')
        ON CONFLICT(user_id,source_key) DO NOTHING;
    END IF;
END $$;
