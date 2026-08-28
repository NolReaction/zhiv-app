ALTER TABLE direct_requests
    ADD COLUMN idempotency_key uuid,
    ADD COLUMN expires_at timestamptz;

UPDATE direct_requests
   SET idempotency_key = uuidv7(),
       expires_at = created_at + interval '7 days'
 WHERE idempotency_key IS NULL OR expires_at IS NULL;

ALTER TABLE direct_requests
    ALTER COLUMN idempotency_key SET NOT NULL,
    ALTER COLUMN expires_at SET NOT NULL,
    ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days'),
    DROP CONSTRAINT direct_requests_status_ck,
    DROP CONSTRAINT direct_requests_state_ck,
    ADD CONSTRAINT direct_requests_status_ck CHECK (
        status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED')
    ),
    ADD CONSTRAINT direct_requests_expiry_ck CHECK (
        expires_at > created_at
        AND expires_at <= created_at + interval '30 days'
    ),
    ADD CONSTRAINT direct_requests_idempotency_uq UNIQUE (
        requester_user_id, idempotency_key
    ),
    ADD CONSTRAINT direct_requests_state_ck CHECK (
        (
            status = 'PENDING' AND responded_at IS NULL
            AND result_circle_id IS NULL AND result_circle_kind IS NULL
        )
        OR
        (
            status = 'ACCEPTED' AND responded_at IS NOT NULL
            AND result_circle_id IS NOT NULL AND result_circle_kind = 'DIRECT'
        )
        OR
        (
            status IN ('REJECTED', 'CANCELLED', 'EXPIRED') AND responded_at IS NOT NULL
            AND result_circle_id IS NULL AND result_circle_kind IS NULL
        )
    );

CREATE INDEX direct_requests_requester_idx
    ON direct_requests(requester_user_id, created_at DESC)
    WHERE status = 'PENDING';

CREATE INDEX direct_requests_expiry_idx
    ON direct_requests(expires_at)
    WHERE status = 'PENDING';

CREATE TABLE circle_sharing_preferences (
    circle_id       uuid NOT NULL REFERENCES circles(id) ON DELETE RESTRICT,
    user_id         uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    sharing_mode    varchar(16) NOT NULL DEFAULT 'LATEST_ONLY',
    enabled_since   timestamptz DEFAULT clock_timestamp(),
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT circle_sharing_preferences_pk PRIMARY KEY (circle_id, user_id),
    CONSTRAINT circle_sharing_preferences_mode_ck CHECK (
        sharing_mode IN ('OFF', 'LATEST_ONLY')
    ),
    CONSTRAINT circle_sharing_preferences_state_ck CHECK (
        (sharing_mode = 'OFF' AND enabled_since IS NULL)
        OR
        (
            sharing_mode <> 'OFF'
            AND enabled_since IS NOT NULL
            AND enabled_since <= updated_at
        )
    ),
    CONSTRAINT circle_sharing_preferences_dates_ck CHECK (updated_at >= created_at)
);

CREATE INDEX circle_sharing_preferences_user_idx
    ON circle_sharing_preferences(user_id, circle_id)
    WHERE sharing_mode <> 'OFF';

ALTER TABLE check_in_audiences
    ADD COLUMN access_level varchar(16) NOT NULL DEFAULT 'LATEST_ONLY',
    ADD CONSTRAINT check_in_audiences_access_level_ck CHECK (
        access_level IN ('LATEST_ONLY', 'DAILY_MARKS', 'EXACT_TIMES')
    );

CREATE INDEX check_in_audiences_recipient_actor_idx
    ON check_in_audiences(recipient_user_id, actor_user_id, check_in_id DESC);

CREATE INDEX circles_direct_low_active_idx
    ON circles(direct_user_low_id, created_at DESC)
    WHERE kind = 'DIRECT' AND archived_at IS NULL;

CREATE INDEX circles_direct_high_active_idx
    ON circles(direct_user_high_id, created_at DESC)
    WHERE kind = 'DIRECT' AND archived_at IS NULL;

CREATE FUNCTION guard_circle_sharing_preference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    circle_kind varchar(10);
BEGIN
    SELECT c.kind
      INTO STRICT circle_kind
      FROM circles c
     WHERE c.id = NEW.circle_id
       AND c.archived_at IS NULL
     FOR SHARE OF c;

    IF circle_kind = 'DIRECT' THEN
        IF NOT EXISTS (
            SELECT 1
              FROM circles c
             WHERE c.id = NEW.circle_id
               AND NEW.user_id IN (c.direct_user_low_id, c.direct_user_high_id)
        ) THEN
            RAISE EXCEPTION 'DIRECT preference owner must belong to the circle'
                USING ERRCODE = '23514';
        END IF;
    ELSIF circle_kind = 'GROUP' THEN
        IF NOT EXISTS (
            SELECT 1
              FROM circle_memberships m
             WHERE m.circle_id = NEW.circle_id
               AND m.user_id = NEW.user_id
               AND m.left_at IS NULL
        ) THEN
            RAISE EXCEPTION 'GROUP preference owner must be an active member'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'unknown circle kind' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.sharing_mode = 'OFF' THEN
            NEW.enabled_since = NULL;
        ELSIF NEW.enabled_since IS NULL THEN
            NEW.enabled_since = clock_timestamp();
        END IF;
    ELSE
        IF NEW.circle_id IS DISTINCT FROM OLD.circle_id
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
            RAISE EXCEPTION 'sharing preference identity is immutable' USING ERRCODE = '55000';
        END IF;
        NEW.updated_at = clock_timestamp();
        IF NEW.sharing_mode = 'OFF' THEN
            NEW.enabled_since = NULL;
        ELSIF OLD.sharing_mode = 'OFF' OR NEW.enabled_since IS NULL THEN
            NEW.enabled_since = NEW.updated_at;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER circle_sharing_preferences_guard
    BEFORE INSERT OR UPDATE ON circle_sharing_preferences
    FOR EACH ROW EXECUTE FUNCTION guard_circle_sharing_preference();

INSERT INTO circle_sharing_preferences (
    circle_id, user_id, sharing_mode, enabled_since, created_at, updated_at
)
SELECT c.id, users.user_id, 'LATEST_ONLY', migration_time.at,
       migration_time.at, migration_time.at
  FROM circles c
 CROSS JOIN LATERAL (
       VALUES (c.direct_user_low_id), (c.direct_user_high_id)
  ) AS users(user_id)
 CROSS JOIN LATERAL (SELECT clock_timestamp() AS at) migration_time
 WHERE c.kind = 'DIRECT'
   AND c.archived_at IS NULL
ON CONFLICT (circle_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION guard_direct_request_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'PENDING' THEN
            RAISE EXCEPTION 'direct request must start as PENDING' USING ERRCODE = '23514';
        END IF;
        IF NEW.expires_at <= NEW.created_at OR NEW.expires_at > NEW.created_at + interval '30 days' THEN
            RAISE EXCEPTION 'invalid direct request expiry' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
        OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION 'direct request identity is immutable' USING ERRCODE = '55000';
    END IF;

    IF OLD.status <> 'PENDING' THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'terminal direct request is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status NOT IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED') THEN
        RAISE EXCEPTION 'invalid direct request transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'PENDING'
        AND (NEW.responded_at IS NULL OR NEW.responded_at > clock_timestamp())
    THEN
        RAISE EXCEPTION 'invalid direct request response time' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'ACCEPTED' AND OLD.expires_at <= NEW.responded_at THEN
        RAISE EXCEPTION 'expired direct request cannot be accepted' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'EXPIRED' AND NEW.responded_at < OLD.expires_at THEN
        RAISE EXCEPTION 'active direct request cannot expire early' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('REJECTED', 'CANCELLED') AND NEW.responded_at >= OLD.expires_at THEN
        RAISE EXCEPTION 'expired direct request cannot be acted on' USING ERRCODE = '23514';
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
        PERFORM c.id
          FROM circles c
          JOIN circle_sharing_preferences preference
            ON preference.circle_id = c.id
           AND preference.user_id = NEW.actor_user_id
           AND preference.sharing_mode <> 'OFF'
           AND preference.enabled_since <= event_at
           AND preference.updated_at <= event_at
         WHERE c.id = NEW.circle_id
           AND c.kind = 'DIRECT'
           AND c.created_at <= event_at
           AND (c.archived_at IS NULL OR c.archived_at > event_at)
           AND NEW.actor_user_id IN (c.direct_user_low_id, c.direct_user_high_id)
           AND NEW.recipient_user_id IN (c.direct_user_low_id, c.direct_user_high_id)
           AND NEW.actor_user_id <> NEW.recipient_user_id
           AND NEW.access_level = preference.sharing_mode
         FOR SHARE OF c, preference;
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
           AND recipient.history_visibility <> 'NONE'
         WHERE c.id = NEW.circle_id
           AND c.kind = 'GROUP'
           AND c.created_at <= event_at
           AND (c.archived_at IS NULL OR c.archived_at > event_at)
           AND NEW.actor_user_id <> NEW.recipient_user_id
           AND NEW.access_level = 'LATEST_ONLY'
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
