-- Separate the reusable capability from each person's immutable consent receipt.
-- Historical ACCEPTED links remain terminal: never reactivate an old capability.
CREATE TABLE direct_invite_redemptions (
    invite_id uuid NOT NULL REFERENCES direct_invite_links(id) ON DELETE RESTRICT,
    recipient_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    idempotency_key uuid NOT NULL,
    circle_id uuid NOT NULL,
    circle_kind varchar(10) NOT NULL DEFAULT 'DIRECT',
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (invite_id, recipient_user_id),
    CONSTRAINT direct_invite_redemptions_idempotency_uq UNIQUE (recipient_user_id, idempotency_key),
    CONSTRAINT direct_invite_redemptions_direct_ck CHECK (circle_kind = 'DIRECT'),
    CONSTRAINT direct_invite_redemptions_circle_fk FOREIGN KEY (circle_id, circle_kind)
        REFERENCES circles(id, kind) ON DELETE RESTRICT
);
CREATE INDEX direct_invite_redemptions_circle_idx ON direct_invite_redemptions(circle_id, accepted_at);

-- Backfill before installing the INSERT guard: historical circles may already be
-- archived, and the consumed links themselves must not be modified.
INSERT INTO direct_invite_redemptions (invite_id, recipient_user_id, idempotency_key, circle_id, accepted_at)
SELECT id, accepted_by_user_id, accepted_idempotency_key, result_circle_id, accepted_at
  FROM direct_invite_links WHERE status = 'ACCEPTED';

CREATE FUNCTION guard_direct_invite_redemption() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    inviter_id uuid;
    invite direct_invite_links%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'direct invite receipt is immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'direct invite receipt is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    SELECT inviter_user_id INTO inviter_id FROM direct_invite_links WHERE id = NEW.invite_id;
    IF inviter_id IS NULL OR inviter_id = NEW.recipient_user_id THEN
        RAISE EXCEPTION 'direct invite needs two distinct users' USING ERRCODE = '23514';
    END IF;
    -- Match the repositories and account lifecycle: ordered users, then children.
    PERFORM id FROM app_users WHERE id IN (inviter_id, NEW.recipient_user_id)
        ORDER BY id FOR NO KEY UPDATE;
    SELECT * INTO invite FROM direct_invite_links WHERE id = NEW.invite_id FOR UPDATE;
    IF invite.status <> 'PENDING'
        OR NEW.accepted_at < invite.created_at OR NEW.accepted_at >= invite.expires_at
        OR NEW.accepted_at > clock_timestamp()
        OR (SELECT count(*) FROM app_users
            WHERE id IN (inviter_id, NEW.recipient_user_id) AND deleted_at IS NULL) <> 2 THEN
        RAISE EXCEPTION 'direct invite is no longer active' USING ERRCODE = '23514';
    END IF;
    PERFORM id FROM circles
        WHERE id = NEW.circle_id AND kind = 'DIRECT' AND archived_at IS NULL
          AND direct_user_low_id = LEAST(inviter_id, NEW.recipient_user_id)
          AND direct_user_high_id = GREATEST(inviter_id, NEW.recipient_user_id)
          AND created_at <= NEW.accepted_at
        FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'direct invite receipt must reference the exact active direct circle'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER direct_invite_redemptions_state_guard
BEFORE INSERT OR UPDATE OR DELETE ON direct_invite_redemptions
FOR EACH ROW EXECUTE FUNCTION guard_direct_invite_redemption();

CREATE OR REPLACE FUNCTION guard_direct_invite_link_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status <> 'PENDING' THEN
        RAISE EXCEPTION 'new direct invite must be pending' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
            OR NEW.inviter_user_id IS DISTINCT FROM OLD.inviter_user_id
            OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
            OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
            RAISE EXCEPTION 'direct invite identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.status <> 'PENDING' AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'terminal direct invite is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING', 'REVOKED', 'EXPIRED') THEN
            RAISE EXCEPTION 'invalid direct invite transition' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.status = 'ACCEPTED' AND NOT EXISTS (
        SELECT 1
          FROM circles circle
         WHERE circle.id = NEW.result_circle_id
           AND circle.kind = 'DIRECT'
           AND circle.archived_at IS NULL
           AND circle.direct_user_low_id = LEAST(NEW.inviter_user_id, NEW.accepted_by_user_id)
           AND circle.direct_user_high_id = GREATEST(NEW.inviter_user_id, NEW.accepted_by_user_id)
    ) THEN
        RAISE EXCEPTION 'accepted invite must reference the exact active direct circle'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- Keep V17's proof-bound group-owner transfer exception. Only extend the
-- existing archive-time guard with the new immutable acceptance history.
CREATE OR REPLACE FUNCTION guard_circle_state() RETURNS trigger
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
        OR (NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id AND NOT
            (OLD.kind='GROUP' AND OLD.archived_at IS NULL AND account_group_transfer_allowed(OLD.id,OLD.created_by_user_id,NEW.created_by_user_id)))
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
        ) OR EXISTS (
            SELECT 1
              FROM direct_invite_redemptions redemption
             WHERE redemption.circle_id = OLD.id
               AND redemption.accepted_at >= NEW.archived_at
        ) THEN
            RAISE EXCEPTION 'archive time conflicts with relationship history' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
