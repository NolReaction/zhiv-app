-- Separate explicit location consent: check-in audience preferences never grant geo access.
CREATE TABLE earth_sharing_settings (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    mode text NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','SHARING','GHOST')),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
    precision text NOT NULL DEFAULT 'APPROXIMATE' CHECK (precision IN ('APPROXIMATE','PRECISE')),
    sharing_until timestamptz,
    publication_epoch uuid,
    publisher_session_id uuid REFERENCES app_sessions(id) ON DELETE CASCADE,
    last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence BETWEEN 0 AND 9007199254740990),
    last_captured_at timestamptz,
    last_accepted_at timestamptz,
    enable_bucket_at timestamptz,
    enable_bucket_count integer NOT NULL DEFAULT 0 CHECK (enable_bucket_count BETWEEN 0 AND 10),
    CHECK ((publication_epoch IS NULL) = (publisher_session_id IS NULL)),
    CHECK (mode='SHARING' OR (publication_epoch IS NULL AND sharing_until IS NULL))
);
CREATE TABLE earth_sharing_recipients (
    owner_user_id uuid NOT NULL REFERENCES earth_sharing_settings(user_id) ON DELETE CASCADE,
    circle_id uuid NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    recipient_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    PRIMARY KEY(owner_user_id,circle_id), UNIQUE(owner_user_id,recipient_user_id),
    CHECK(owner_user_id<>recipient_user_id)
);
CREATE INDEX earth_sharing_recipients_viewer_idx ON earth_sharing_recipients(recipient_user_id,owner_user_id);
-- Ephemeral single latest fix. No WAL history/standby replication; backups exclude its data too.
CREATE UNLOGGED TABLE earth_latest_locations (
    user_id uuid PRIMARY KEY REFERENCES earth_sharing_settings(user_id) ON DELETE CASCADE,
    publication_epoch uuid NOT NULL,
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90 AND latitude<>'NaN'::float8),
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180 AND longitude<>'NaN'::float8),
    accuracy_meters double precision NOT NULL CHECK (accuracy_meters BETWEEN 0 AND 100000 AND accuracy_meters<>'NaN'::float8),
    precision text NOT NULL CHECK (precision IN ('APPROXIMATE','PRECISE')),
    updated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz NOT NULL,
    CHECK (expires_at=updated_at+interval '120 seconds'),
    CHECK (updated_at<=accepted_at),
    CHECK (precision<>'APPROXIMATE' OR accuracy_meters>=1500)
);
CREATE INDEX earth_latest_locations_expiry_idx ON earth_latest_locations(expires_at);
CREATE FUNCTION earth_settings_clear_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.publication_epoch IS DISTINCT FROM OLD.publication_epoch OR NEW.mode<>'SHARING' THEN
        DELETE FROM earth_latest_locations WHERE user_id=NEW.user_id;
    END IF;
    IF NEW.mode='OFF' THEN DELETE FROM earth_sharing_recipients WHERE owner_user_id=NEW.user_id; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER earth_settings_clear_position AFTER UPDATE ON earth_sharing_settings
    FOR EACH ROW EXECUTE FUNCTION earth_settings_clear_position();
CREATE FUNCTION earth_revoke_archived_circle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind='DIRECT' AND NEW.archived_at IS NOT NULL THEN
        -- Revoke the publisher as well as this grant. A concurrent upload or an
        -- old settings form cannot silently keep the changed audience alive.
        UPDATE earth_sharing_settings SET revision=least(revision+1,9007199254740990),
            publication_epoch=NULL,publisher_session_id=NULL,last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL
            WHERE user_id IN(SELECT owner_user_id FROM earth_sharing_recipients WHERE circle_id=NEW.id);
        DELETE FROM earth_sharing_recipients WHERE circle_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER earth_revoke_archived_circle AFTER UPDATE OF archived_at ON circles
    FOR EACH ROW EXECUTE FUNCTION earth_revoke_archived_circle();
CREATE FUNCTION earth_revoke_inactive_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL OR NEW.banned_at IS NOT NULL THEN
        UPDATE earth_sharing_settings SET mode='OFF',revision=least(revision+1,9007199254740990),sharing_until=NULL,
            publication_epoch=NULL,publisher_session_id=NULL,last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL
            WHERE user_id=NEW.id;
        -- A recipient becoming inactive changes every explicit audience that
        -- included them, just like removing that friendship.
        UPDATE earth_sharing_settings SET revision=least(revision+1,9007199254740990),
            publication_epoch=NULL,publisher_session_id=NULL,last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL
            WHERE user_id IN(SELECT owner_user_id FROM earth_sharing_recipients WHERE recipient_user_id=NEW.id);
        DELETE FROM earth_sharing_recipients WHERE owner_user_id=NEW.id OR recipient_user_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER earth_revoke_inactive_user AFTER UPDATE OF deleted_at,banned_at ON app_users
    FOR EACH ROW EXECUTE FUNCTION earth_revoke_inactive_user();
CREATE FUNCTION earth_revoke_session_publisher() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.revoked_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NEW.user_id<>OLD.user_id THEN
        UPDATE earth_sharing_settings SET publication_epoch=NULL,publisher_session_id=NULL,
            last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL WHERE publisher_session_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER earth_revoke_session_publisher AFTER UPDATE OF revoked_at,expires_at,user_id ON app_sessions
    FOR EACH ROW EXECUTE FUNCTION earth_revoke_session_publisher();
