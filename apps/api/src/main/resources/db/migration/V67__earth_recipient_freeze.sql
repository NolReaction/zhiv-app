-- Recipient preferences are durable; each frozen grant keeps at most one
-- ephemeral already-authorized point, never a route or a public privacy flag.
ALTER TABLE earth_sharing_recipients ADD COLUMN frozen boolean NOT NULL DEFAULT false;
ALTER TABLE earth_sharing_recipients ADD COLUMN live_after timestamptz;
CREATE UNLOGGED TABLE earth_frozen_locations (
    owner_user_id uuid NOT NULL,
    circle_id uuid NOT NULL,
    publisher_session_id uuid NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90 AND latitude<>'NaN'::float8),
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180 AND longitude<>'NaN'::float8),
    accuracy_meters double precision NOT NULL CHECK (accuracy_meters BETWEEN 0 AND 100000 AND accuracy_meters<>'NaN'::float8),
    precision text NOT NULL CHECK (precision IN ('APPROXIMATE','PRECISE')),
    updated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz NOT NULL,
    PRIMARY KEY(owner_user_id,circle_id),
    FOREIGN KEY(owner_user_id,circle_id) REFERENCES earth_sharing_recipients(owner_user_id,circle_id) ON DELETE CASCADE,
    CHECK (expires_at>updated_at AND expires_at<=updated_at+interval '24 hours'),
    CHECK (updated_at<=accepted_at),
    CHECK (precision<>'APPROXIMATE' OR accuracy_meters>=1500)
);
CREATE INDEX earth_frozen_locations_expiry_idx ON earth_frozen_locations(expires_at);
CREATE INDEX earth_frozen_locations_publisher_idx ON earth_frozen_locations(publisher_session_id);
CREATE OR REPLACE FUNCTION earth_revoke_archived_circle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind='DIRECT' AND NEW.archived_at IS NOT NULL THEN
        DELETE FROM earth_frozen_locations WHERE owner_user_id IN
            (SELECT owner_user_id FROM earth_sharing_recipients WHERE circle_id=NEW.id);
        DELETE FROM earth_latest_locations WHERE user_id IN
            (SELECT owner_user_id FROM earth_sharing_recipients WHERE circle_id=NEW.id);
        UPDATE earth_sharing_settings SET revision=least(revision+1,9007199254740990),
            publication_epoch=NULL,publisher_session_id=NULL,last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL
            WHERE user_id IN(SELECT owner_user_id FROM earth_sharing_recipients WHERE circle_id=NEW.id);
        DELETE FROM earth_sharing_recipients WHERE circle_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION earth_revoke_inactive_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL OR NEW.banned_at IS NOT NULL THEN
        UPDATE earth_sharing_settings SET mode='OFF',revision=least(revision+1,9007199254740990),sharing_until=NULL,
            publication_epoch=NULL,publisher_session_id=NULL,last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL
            WHERE user_id=NEW.id;
        DELETE FROM earth_frozen_locations WHERE owner_user_id IN
            (SELECT owner_user_id FROM earth_sharing_recipients WHERE recipient_user_id=NEW.id);
        DELETE FROM earth_latest_locations WHERE user_id IN
            (SELECT owner_user_id FROM earth_sharing_recipients WHERE recipient_user_id=NEW.id);
        UPDATE earth_sharing_settings SET revision=least(revision+1,9007199254740990),
            publication_epoch=NULL,publisher_session_id=NULL,last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL
            WHERE user_id IN(SELECT owner_user_id FROM earth_sharing_recipients WHERE recipient_user_id=NEW.id);
        DELETE FROM earth_sharing_recipients WHERE owner_user_id=NEW.id OR recipient_user_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION earth_revoke_session_publisher() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.revoked_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NEW.user_id<>OLD.user_id THEN
        DELETE FROM earth_frozen_locations WHERE publisher_session_id=NEW.id;
        DELETE FROM earth_latest_locations WHERE publisher_session_id=NEW.id;
        UPDATE earth_sharing_settings SET publication_epoch=NULL,publisher_session_id=NULL,
            last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL WHERE publisher_session_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
