ALTER TABLE circles
    ADD CONSTRAINT circles_direct_period_excl
    EXCLUDE USING gist (
        direct_user_low_id WITH =,
        direct_user_high_id WITH =,
        tstzrange(created_at, archived_at, '[)') WITH &&
    ) WHERE (kind = 'DIRECT');

ALTER TABLE circle_memberships
    ADD CONSTRAINT circle_memberships_period_excl
    EXCLUDE USING gist (
        circle_id WITH =,
        user_id WITH =,
        tstzrange(joined_at, left_at, '[)') WITH &&
    );

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
        PERFORM c.id
          FROM circles c
         WHERE c.id = NEW.circle_id
           AND c.kind = 'DIRECT'
           AND c.created_at <= event_at
           AND (c.archived_at IS NULL OR c.archived_at > event_at)
           AND NEW.actor_user_id IN (c.direct_user_low_id, c.direct_user_high_id)
           AND NEW.recipient_user_id IN (c.direct_user_low_id, c.direct_user_high_id)
           AND NEW.actor_user_id <> NEW.recipient_user_id
           FOR SHARE OF c;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'invalid DIRECT audience snapshot' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.circle_kind = 'GROUP' THEN
        PERFORM actor.id
          FROM circles c
          JOIN circle_memberships actor
            ON actor.circle_id = c.id
           AND actor.user_id = NEW.actor_user_id
           AND actor.joined_at <= event_at
           AND (actor.left_at IS NULL OR actor.left_at > event_at)
           AND actor.share_latest
          JOIN circle_memberships recipient
            ON recipient.id = NEW.recipient_membership_id
           AND recipient.circle_id = c.id
           AND recipient.user_id = NEW.recipient_user_id
           AND recipient.joined_at <= event_at
           AND (recipient.left_at IS NULL OR recipient.left_at > event_at)
         WHERE c.id = NEW.circle_id
           AND c.kind = 'GROUP'
           AND c.created_at <= event_at
           AND (c.archived_at IS NULL OR c.archived_at > event_at)
           AND NEW.actor_user_id <> NEW.recipient_user_id
         FOR SHARE OF c, actor, recipient;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'invalid GROUP audience snapshot' USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'unknown circle kind' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION guard_circle_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.created_at > clock_timestamp()
            OR (NEW.archived_at IS NOT NULL AND NEW.archived_at > clock_timestamp())
        THEN
            RAISE EXCEPTION 'circle dates cannot be in the future' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
        OR NEW.direct_user_low_id IS DISTINCT FROM OLD.direct_user_low_id
        OR NEW.direct_user_high_id IS DISTINCT FROM OLD.direct_user_high_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'circle identity is immutable' USING ERRCODE = '55000';
    END IF;

    IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        RAISE EXCEPTION 'archived circle cannot be reopened or re-dated' USING ERRCODE = '55000';
    END IF;

    IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
        IF NEW.archived_at > clock_timestamp() THEN
            RAISE EXCEPTION 'circle cannot be archived in the future' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            SELECT 1
              FROM check_in_audiences a
              JOIN check_ins e ON e.id = a.check_in_id
             WHERE a.circle_id = OLD.id
               AND e.checked_at >= NEW.archived_at
        ) OR EXISTS (
            SELECT 1
              FROM direct_requests r
             WHERE r.result_circle_id = OLD.id
               AND r.status = 'ACCEPTED'
               AND r.responded_at >= NEW.archived_at
        ) THEN
            RAISE EXCEPTION 'archive time conflicts with relationship history' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER circles_state_guard
    BEFORE INSERT OR UPDATE ON circles
    FOR EACH ROW EXECUTE FUNCTION guard_circle_state();

CREATE FUNCTION guard_membership_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.joined_at > clock_timestamp()
            OR (NEW.left_at IS NOT NULL AND NEW.left_at > clock_timestamp())
        THEN
            RAISE EXCEPTION 'membership dates cannot be in the future' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.circle_id IS DISTINCT FROM OLD.circle_id
        OR NEW.circle_kind IS DISTINCT FROM OLD.circle_kind
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
    THEN
        RAISE EXCEPTION 'membership identity and join time are immutable' USING ERRCODE = '55000';
    END IF;

    IF OLD.left_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'closed membership is immutable' USING ERRCODE = '55000';
    END IF;

    IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL THEN
        IF NEW.left_at > clock_timestamp() THEN
            RAISE EXCEPTION 'membership cannot end in the future' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            SELECT 1
              FROM check_in_audiences a
              JOIN check_ins e ON e.id = a.check_in_id
             WHERE a.recipient_membership_id = OLD.id
               AND e.checked_at >= NEW.left_at
        ) OR EXISTS (
            SELECT 1
              FROM check_in_audiences a
              JOIN check_ins e ON e.id = a.check_in_id
             WHERE a.circle_kind = 'GROUP'
               AND a.circle_id = OLD.circle_id
               AND a.actor_user_id = OLD.user_id
               AND e.checked_at >= NEW.left_at
        ) THEN
            RAISE EXCEPTION 'membership end conflicts with audience history' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER circle_memberships_state_guard
    BEFORE INSERT OR UPDATE ON circle_memberships
    FOR EACH ROW EXECUTE FUNCTION guard_membership_state();

CREATE OR REPLACE FUNCTION guard_accepted_direct_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'ACCEPTED' THEN
        PERFORM c.id
          FROM circles c
         WHERE c.id = NEW.result_circle_id
           AND c.kind = 'DIRECT'
           AND c.direct_user_low_id = LEAST(NEW.requester_user_id, NEW.recipient_user_id)
           AND c.direct_user_high_id = GREATEST(NEW.requester_user_id, NEW.recipient_user_id)
           AND c.created_at <= NEW.responded_at
           AND c.archived_at IS NULL
           FOR SHARE OF c;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'accepted request must reference its active DIRECT circle'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION guard_direct_request_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'PENDING' THEN
            RAISE EXCEPTION 'direct request must start as PENDING' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
        OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'direct request identity is immutable' USING ERRCODE = '55000';
    END IF;

    IF OLD.status <> 'PENDING' THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'terminal direct request is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status NOT IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED') THEN
        RAISE EXCEPTION 'invalid direct request transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'PENDING'
        AND (NEW.responded_at IS NULL OR NEW.responded_at > clock_timestamp())
    THEN
        RAISE EXCEPTION 'invalid direct request response time' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER direct_requests_state_machine
    BEFORE INSERT OR UPDATE ON direct_requests
    FOR EACH ROW EXECUTE FUNCTION guard_direct_request_state();

CREATE OR REPLACE FUNCTION guard_circle_inviter() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'PENDING' THEN
        PERFORM m.id
          FROM circles c
          JOIN circle_memberships m ON m.circle_id = c.id
         WHERE c.id = NEW.circle_id
           AND c.kind = 'GROUP'
           AND c.archived_at IS NULL
           AND c.created_at <= clock_timestamp()
           AND m.user_id = NEW.inviter_user_id
           AND m.role IN ('OWNER', 'ADMIN')
           AND m.joined_at <= clock_timestamp()
           AND m.left_at IS NULL
         FOR SHARE OF c, m;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'inviter must be an active OWNER or ADMIN of an active group'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION guard_circle_invite_state() RETURNS trigger
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
        PERFORM c.id
          FROM circles c
         WHERE c.id = OLD.circle_id
           AND c.kind = 'GROUP'
           AND c.archived_at IS NULL
         FOR SHARE OF c;
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

CREATE TRIGGER circle_invites_state_machine
    BEFORE INSERT OR UPDATE ON circle_invites
    FOR EACH ROW EXECUTE FUNCTION guard_circle_invite_state();
