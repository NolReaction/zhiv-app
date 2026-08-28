ALTER TABLE direct_requests
    ADD CONSTRAINT direct_requests_response_dates_ck CHECK (
        responded_at IS NULL OR responded_at >= created_at
    );

ALTER TABLE circle_invites
    ADD CONSTRAINT circle_invites_action_dates_ck CHECK (
        (accepted_at IS NULL OR accepted_at >= created_at)
        AND (revoked_at IS NULL OR revoked_at >= created_at)
    );

CREATE FUNCTION reject_check_in_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'check_ins is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER check_ins_append_only
    BEFORE UPDATE OR DELETE ON check_ins
    FOR EACH ROW EXECUTE FUNCTION reject_check_in_mutation();

CREATE FUNCTION guard_check_in_audience() RETURNS trigger
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
        IF NOT EXISTS (
            SELECT 1
              FROM circles c
             WHERE c.id = NEW.circle_id
               AND c.kind = 'DIRECT'
               AND c.created_at <= event_at
               AND (c.archived_at IS NULL OR c.archived_at > event_at)
               AND NEW.actor_user_id IN (c.direct_user_low_id, c.direct_user_high_id)
               AND NEW.recipient_user_id IN (c.direct_user_low_id, c.direct_user_high_id)
               AND NEW.actor_user_id <> NEW.recipient_user_id
        ) THEN
            RAISE EXCEPTION 'invalid DIRECT audience snapshot' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.circle_kind = 'GROUP' THEN
        IF NOT EXISTS (
            SELECT 1
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
        ) THEN
            RAISE EXCEPTION 'invalid GROUP audience snapshot' USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'unknown circle kind' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER check_in_audiences_privacy_guard
    BEFORE INSERT OR UPDATE ON check_in_audiences
    FOR EACH ROW EXECUTE FUNCTION guard_check_in_audience();

CREATE FUNCTION guard_accepted_direct_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'ACCEPTED' AND NOT EXISTS (
        SELECT 1
          FROM circles c
         WHERE c.id = NEW.result_circle_id
           AND c.kind = 'DIRECT'
           AND c.direct_user_low_id = LEAST(NEW.requester_user_id, NEW.recipient_user_id)
           AND c.direct_user_high_id = GREATEST(NEW.requester_user_id, NEW.recipient_user_id)
    ) THEN
        RAISE EXCEPTION 'accepted request must reference its own DIRECT circle'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER direct_requests_circle_guard
    BEFORE INSERT OR UPDATE ON direct_requests
    FOR EACH ROW EXECUTE FUNCTION guard_accepted_direct_request();

CREATE FUNCTION guard_circle_inviter() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'PENDING' AND NOT EXISTS (
        SELECT 1
          FROM circle_memberships m
         WHERE m.circle_id = NEW.circle_id
           AND m.user_id = NEW.inviter_user_id
           AND m.role IN ('OWNER', 'ADMIN')
           AND m.left_at IS NULL
    ) THEN
        RAISE EXCEPTION 'inviter must be an active OWNER or ADMIN' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER circle_invites_inviter_guard
    BEFORE INSERT OR UPDATE OF circle_id, inviter_user_id, status ON circle_invites
    FOR EACH ROW EXECUTE FUNCTION guard_circle_inviter();
