ALTER TABLE circles
    ADD COLUMN creation_idempotency_key uuid,
    ADD CONSTRAINT circles_group_creation_key_ck CHECK (
        kind = 'GROUP' OR creation_idempotency_key IS NULL
    );

CREATE UNIQUE INDEX circles_group_creation_key_uq
    ON circles(created_by_user_id, creation_idempotency_key)
    WHERE kind = 'GROUP' AND creation_idempotency_key IS NOT NULL;

CREATE FUNCTION guard_group_creation_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.creation_idempotency_key IS DISTINCT FROM OLD.creation_idempotency_key THEN
        RAISE EXCEPTION 'group creation identity is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER circles_group_creation_key_guard
    BEFORE UPDATE ON circles
    FOR EACH ROW EXECUTE FUNCTION guard_group_creation_key();

ALTER TABLE circle_invites
    ADD COLUMN idempotency_key uuid DEFAULT uuidv7();

ALTER TABLE circle_invites
    ALTER COLUMN idempotency_key DROP DEFAULT,
    ALTER COLUMN idempotency_key SET NOT NULL,
    ADD CONSTRAINT circle_invites_idempotency_uq UNIQUE (
        inviter_user_id, idempotency_key
    );

-- V2 allowed more than one pending invite for the same person. Keep the
-- oldest invitation stable and revoke only legacy duplicates before adding
-- the stricter v0.3 invariant.
WITH duplicate_pending_invites AS (
    SELECT id
      FROM (
          SELECT id,
                 row_number() OVER (
                     PARTITION BY circle_id, invitee_user_id
                     ORDER BY created_at, id
                 ) AS position
            FROM circle_invites
           WHERE status = 'PENDING' AND invitee_user_id IS NOT NULL
      ) ranked
     WHERE ranked.position > 1
)
UPDATE circle_invites invite
   SET status = 'REVOKED', revoked_at = clock_timestamp()
 WHERE invite.id IN (SELECT id FROM duplicate_pending_invites);

CREATE UNIQUE INDEX circle_invites_pending_target_uq
    ON circle_invites(circle_id, invitee_user_id)
    WHERE status = 'PENDING' AND invitee_user_id IS NOT NULL;

-- Repair any hand-written/experimental legacy groups before enforcing that
-- the recorded creator is their sole active owner. Newly restored creator
-- memberships start private; the preference backfill below keeps them OFF.
UPDATE circle_memberships membership
   SET role = 'MEMBER'
  FROM circles circle
 WHERE circle.id = membership.circle_id
   AND circle.kind = 'GROUP'
   AND membership.left_at IS NULL
   AND membership.role = 'OWNER'
   AND membership.user_id <> circle.created_by_user_id;

UPDATE circle_memberships membership
   SET role = 'OWNER'
  FROM circles circle
 WHERE circle.id = membership.circle_id
   AND circle.kind = 'GROUP'
   AND circle.archived_at IS NULL
   AND membership.left_at IS NULL
   AND membership.user_id = circle.created_by_user_id
   AND membership.role <> 'OWNER';

INSERT INTO circle_memberships (
    circle_id, circle_kind, user_id, role, share_latest,
    history_visibility, joined_at
)
SELECT circle.id, 'GROUP', circle.created_by_user_id, 'OWNER', false,
       'FROM_JOIN', migration_time.at
  FROM circles circle
 CROSS JOIN LATERAL (SELECT clock_timestamp() AS at) migration_time
 WHERE circle.kind = 'GROUP'
   AND circle.archived_at IS NULL
   AND NOT EXISTS (
       SELECT 1
         FROM circle_memberships membership
        WHERE membership.circle_id = circle.id
          AND membership.user_id = circle.created_by_user_id
          AND membership.left_at IS NULL
   );

CREATE UNIQUE INDEX circle_memberships_active_owner_uq
    ON circle_memberships(circle_id)
    WHERE role = 'OWNER' AND left_at IS NULL;

CREATE FUNCTION assert_active_group_owner(target_circle_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM circles circle
         WHERE circle.id = target_circle_id
           AND circle.kind = 'GROUP'
           AND circle.archived_at IS NULL
           AND NOT EXISTS (
               SELECT 1
                 FROM circle_memberships membership
                WHERE membership.circle_id = circle.id
                  AND membership.user_id = circle.created_by_user_id
                  AND membership.role = 'OWNER'
                  AND membership.left_at IS NULL
           )
    ) THEN
        RAISE EXCEPTION 'active group must have its creator as OWNER' USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE FUNCTION enforce_membership_group_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM assert_active_group_owner(OLD.circle_id);
        RETURN OLD;
    END IF;
    PERFORM assert_active_group_owner(NEW.circle_id);
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER circle_memberships_owner_required
    AFTER INSERT OR UPDATE OR DELETE ON circle_memberships
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_membership_group_owner();

CREATE FUNCTION enforce_circle_group_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM assert_active_group_owner(OLD.id);
        RETURN OLD;
    END IF;
    PERFORM assert_active_group_owner(NEW.id);
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER circles_owner_required
    AFTER INSERT OR UPDATE OR DELETE ON circles
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_circle_group_owner();

INSERT INTO circle_sharing_preferences (
    circle_id, user_id, sharing_mode, enabled_since, created_at, updated_at
)
SELECT membership.circle_id, membership.user_id,
       CASE WHEN membership.share_latest THEN 'LATEST_ONLY' ELSE 'OFF' END,
       CASE WHEN membership.share_latest THEN migration_time.at ELSE NULL END,
       migration_time.at, migration_time.at
  FROM circle_memberships membership
  JOIN circles circle
    ON circle.id = membership.circle_id
   AND circle.kind = 'GROUP'
   AND circle.archived_at IS NULL
 CROSS JOIN LATERAL (SELECT clock_timestamp() AS at) migration_time
 WHERE membership.left_at IS NULL
ON CONFLICT (circle_id, user_id) DO UPDATE
SET sharing_mode = 'OFF', enabled_since = NULL
WHERE EXCLUDED.sharing_mode = 'OFF'
  AND circle_sharing_preferences.sharing_mode <> 'OFF';

CREATE FUNCTION guard_group_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role = 'OWNER' AND NOT EXISTS (
        SELECT 1
          FROM circles circle
         WHERE circle.id = NEW.circle_id
           AND circle.kind = 'GROUP'
           AND circle.created_by_user_id = NEW.user_id
    ) THEN
        RAISE EXCEPTION 'group OWNER must be the group creator' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.role = 'OWNER' AND NEW.role <> 'OWNER' THEN
        RAISE EXCEPTION 'group OWNER role is immutable' USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER circle_memberships_owner_guard
    BEFORE INSERT OR UPDATE ON circle_memberships
    FOR EACH ROW EXECUTE FUNCTION guard_group_owner();

CREATE FUNCTION guard_archived_group_profile() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.archived_at IS NOT NULL AND (
        NEW.title IS DISTINCT FROM OLD.title OR NEW.emoji IS DISTINCT FROM OLD.emoji
    ) THEN
        RAISE EXCEPTION 'archived group profile is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER circles_archived_profile_guard
    BEFORE UPDATE ON circles
    FOR EACH ROW EXECUTE FUNCTION guard_archived_group_profile();

CREATE OR REPLACE FUNCTION guard_circle_invite_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'PENDING' THEN
            RAISE EXCEPTION 'circle invite must start as PENDING' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.circle_id IS DISTINCT FROM OLD.circle_id
        OR NEW.circle_kind IS DISTINCT FROM OLD.circle_kind
        OR NEW.inviter_user_id IS DISTINCT FROM OLD.inviter_user_id
        OR NEW.invitee_user_id IS DISTINCT FROM OLD.invitee_user_id
        OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.granted_role IS DISTINCT FROM OLD.granted_role
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION 'circle invite identity is immutable' USING ERRCODE = '55000';
    END IF;

    IF OLD.status <> 'PENDING' THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'terminal circle invite is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status NOT IN ('PENDING', 'ACCEPTED', 'REVOKED') THEN
        RAISE EXCEPTION 'invalid circle invite transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'ACCEPTED' THEN
        IF clock_timestamp() >= OLD.expires_at
            OR NEW.accepted_at IS NULL
            OR NEW.accepted_at > clock_timestamp()
        THEN
            RAISE EXCEPTION 'expired or future-dated invite cannot be accepted' USING ERRCODE = '23514';
        END IF;
        PERFORM circle.id
          FROM circles circle
         WHERE circle.id = OLD.circle_id
           AND circle.kind = 'GROUP'
           AND circle.archived_at IS NULL
         FOR SHARE OF circle;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'invite group is not active' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.status = 'REVOKED'
        AND (NEW.revoked_at IS NULL OR NEW.revoked_at > clock_timestamp())
    THEN
        RAISE EXCEPTION 'invalid invite revocation time' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_check_in_audience() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    event_at timestamptz;
BEGIN
    SELECT checked_at
      INTO STRICT event_at
      FROM check_ins
     WHERE id = NEW.check_in_id
       AND user_id = NEW.actor_user_id;

    IF NEW.circle_kind = 'DIRECT' THEN
        PERFORM circle.id
          FROM circles circle
          JOIN circle_sharing_preferences preference
            ON preference.circle_id = circle.id
           AND preference.user_id = NEW.actor_user_id
           AND preference.sharing_mode <> 'OFF'
           AND preference.enabled_since <= event_at
           AND preference.updated_at <= event_at
         WHERE circle.id = NEW.circle_id
           AND circle.kind = 'DIRECT'
           AND circle.created_at <= event_at
           AND (circle.archived_at IS NULL OR circle.archived_at > event_at)
           AND NEW.actor_user_id IN (circle.direct_user_low_id, circle.direct_user_high_id)
           AND NEW.recipient_user_id IN (circle.direct_user_low_id, circle.direct_user_high_id)
           AND NEW.actor_user_id <> NEW.recipient_user_id
           AND NEW.access_level = preference.sharing_mode
         FOR SHARE OF circle, preference;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'invalid DIRECT audience snapshot' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.circle_kind = 'GROUP' THEN
        PERFORM actor.id
          FROM circles circle
          JOIN circle_memberships actor
            ON actor.circle_id = circle.id
           AND actor.user_id = NEW.actor_user_id
           AND actor.joined_at <= event_at
           AND (actor.left_at IS NULL OR actor.left_at > event_at)
          JOIN circle_sharing_preferences preference
            ON preference.circle_id = circle.id
           AND preference.user_id = NEW.actor_user_id
           AND preference.sharing_mode <> 'OFF'
           AND preference.enabled_since <= event_at
           AND preference.updated_at <= event_at
          JOIN circle_memberships recipient
            ON recipient.id = NEW.recipient_membership_id
           AND recipient.circle_id = circle.id
           AND recipient.user_id = NEW.recipient_user_id
           AND recipient.joined_at <= event_at
           AND (recipient.left_at IS NULL OR recipient.left_at > event_at)
           AND recipient.history_visibility <> 'NONE'
         WHERE circle.id = NEW.circle_id
           AND circle.kind = 'GROUP'
           AND circle.created_at <= event_at
           AND (circle.archived_at IS NULL OR circle.archived_at > event_at)
           AND NEW.actor_user_id <> NEW.recipient_user_id
           AND NEW.access_level = preference.sharing_mode
         FOR SHARE OF circle, actor, preference, recipient;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'invalid GROUP audience snapshot' USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'unknown circle kind' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER check_in_audiences_privacy_guard ON check_in_audiences;

CREATE TRIGGER check_in_audiences_privacy_guard
    BEFORE INSERT ON check_in_audiences
    FOR EACH ROW EXECUTE FUNCTION guard_check_in_audience();

CREATE FUNCTION reject_check_in_audience_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'check_in_audiences is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER check_in_audiences_append_only
    BEFORE UPDATE OR DELETE ON check_in_audiences
    FOR EACH ROW EXECUTE FUNCTION reject_check_in_audience_mutation();
