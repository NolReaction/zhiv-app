-- Keep one last-known point for every pause, including GHOST, without exposing
-- the reason updates stopped. A new consent epoch always requires a fresh fix.
ALTER TABLE earth_latest_locations ADD COLUMN publisher_session_id uuid REFERENCES app_sessions(id) ON DELETE CASCADE;
UPDATE earth_latest_locations p SET publisher_session_id=s.publisher_session_id
    FROM earth_sharing_settings s WHERE s.user_id=p.user_id AND s.publication_epoch=p.publication_epoch;
DELETE FROM earth_latest_locations WHERE publisher_session_id IS NULL;
ALTER TABLE earth_latest_locations ALTER COLUMN publisher_session_id SET NOT NULL;
DO $$ DECLARE constraint_name text; BEGIN
    SELECT conname INTO STRICT constraint_name FROM pg_constraint
        WHERE conrelid='earth_latest_locations'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%expires_at%' AND pg_get_constraintdef(oid) LIKE '%updated_at%';
    EXECUTE format('ALTER TABLE earth_latest_locations DROP CONSTRAINT %I',constraint_name);
    SELECT conname INTO STRICT constraint_name FROM pg_constraint
        WHERE conrelid='earth_sharing_settings'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%sharing_until%';
    EXECUTE format('ALTER TABLE earth_sharing_settings DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE earth_latest_locations ADD CONSTRAINT earth_latest_location_retention
    CHECK (expires_at>updated_at AND expires_at<=updated_at+interval '24 hours');
ALTER TABLE earth_sharing_settings ADD CONSTRAINT earth_inactive_publication
    CHECK ((mode='SHARING' OR publication_epoch IS NULL) AND (mode<>'OFF' OR sharing_until IS NULL));
CREATE INDEX earth_latest_locations_publisher_idx ON earth_latest_locations(publisher_session_id);
CREATE OR REPLACE FUNCTION earth_settings_clear_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.mode='OFF' OR (NEW.publication_epoch IS NOT NULL AND NEW.publication_epoch IS DISTINCT FROM OLD.publication_epoch) THEN
        DELETE FROM earth_latest_locations WHERE user_id=NEW.user_id;
    END IF;
    IF NEW.mode='OFF' THEN DELETE FROM earth_sharing_recipients WHERE owner_user_id=NEW.user_id; END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION earth_revoke_archived_circle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind='DIRECT' AND NEW.archived_at IS NOT NULL THEN
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
        DELETE FROM earth_latest_locations WHERE publisher_session_id=NEW.id;
        UPDATE earth_sharing_settings SET publication_epoch=NULL,publisher_session_id=NULL,
            last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL WHERE publisher_session_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
