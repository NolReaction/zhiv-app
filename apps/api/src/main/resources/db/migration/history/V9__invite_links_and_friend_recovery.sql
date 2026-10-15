CREATE TABLE direct_invite_links (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    inviter_user_id     uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    token_hash          bytea NOT NULL UNIQUE,
    idempotency_key     uuid NOT NULL,
    status              varchar(12) NOT NULL DEFAULT 'PENDING',
    accepted_by_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    accepted_idempotency_key uuid,
    result_circle_id    uuid,
    result_circle_kind  varchar(10),
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at          timestamptz NOT NULL,
    accepted_at         timestamptz,
    revoked_at          timestamptz,

    CONSTRAINT direct_invite_links_idempotency_uq UNIQUE (inviter_user_id, idempotency_key),
    CONSTRAINT direct_invite_links_accept_idempotency_uq
        UNIQUE (accepted_by_user_id, accepted_idempotency_key),
    CONSTRAINT direct_invite_links_hash_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT direct_invite_links_status_ck CHECK (
        status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')
    ),
    CONSTRAINT direct_invite_links_expiry_ck CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '7 days'
    ),
    CONSTRAINT direct_invite_links_circle_fk FOREIGN KEY (result_circle_id, result_circle_kind)
        REFERENCES circles(id, kind) ON DELETE RESTRICT,
    CONSTRAINT direct_invite_links_state_ck CHECK (
        (status = 'PENDING' AND accepted_by_user_id IS NULL AND accepted_idempotency_key IS NULL
            AND result_circle_id IS NULL
            AND result_circle_kind IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
        OR (status = 'ACCEPTED' AND accepted_by_user_id IS NOT NULL
            AND accepted_idempotency_key IS NOT NULL
            AND result_circle_id IS NOT NULL AND result_circle_kind = 'DIRECT'
            AND accepted_at IS NOT NULL AND accepted_at <= expires_at AND revoked_at IS NULL)
        OR (status IN ('REVOKED', 'EXPIRED') AND accepted_by_user_id IS NULL
            AND accepted_idempotency_key IS NULL
            AND result_circle_id IS NULL AND result_circle_kind IS NULL
            AND accepted_at IS NULL AND revoked_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX direct_invite_links_active_owner_uq
    ON direct_invite_links(inviter_user_id) WHERE status = 'PENDING';
CREATE INDEX direct_invite_links_pending_expiry_idx
    ON direct_invite_links(expires_at) WHERE status = 'PENDING';

CREATE TABLE account_recovery_contacts (
    id                         uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_user_id              uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    trustee_user_id            uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    direct_circle_id           uuid NOT NULL,
    direct_circle_kind         varchar(10) NOT NULL DEFAULT 'DIRECT',
    idempotency_key            uuid NOT NULL,
    revocation_idempotency_key uuid,
    created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at                 timestamptz,

    CONSTRAINT account_recovery_contacts_users_ck CHECK (owner_user_id <> trustee_user_id),
    CONSTRAINT account_recovery_contacts_direct_ck CHECK (direct_circle_kind = 'DIRECT'),
    CONSTRAINT account_recovery_contacts_circle_fk
        FOREIGN KEY (direct_circle_id, direct_circle_kind)
        REFERENCES circles(id, kind) ON DELETE RESTRICT,
    CONSTRAINT account_recovery_contacts_idempotency_uq UNIQUE (owner_user_id, idempotency_key),
    CONSTRAINT account_recovery_contacts_id_owner_uq UNIQUE (id, owner_user_id),
    CONSTRAINT account_recovery_contacts_identity_uq UNIQUE (id, owner_user_id, trustee_user_id),
    CONSTRAINT account_recovery_contacts_dates_ck CHECK (
        (revoked_at IS NULL AND revocation_idempotency_key IS NULL)
        OR revoked_at >= created_at
    )
);

CREATE UNIQUE INDEX account_recovery_contacts_active_pair_uq
    ON account_recovery_contacts(owner_user_id, trustee_user_id)
    WHERE revoked_at IS NULL;
CREATE INDEX account_recovery_contacts_trustee_idx
    ON account_recovery_contacts(trustee_user_id, created_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE account_recovery_contact_removals (
    owner_user_id   uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    idempotency_key uuid NOT NULL,
    contact_id      uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT account_recovery_contact_removals_pk
        PRIMARY KEY (owner_user_id, idempotency_key),
    CONSTRAINT account_recovery_contact_removals_contact_fk
        FOREIGN KEY (contact_id, owner_user_id)
        REFERENCES account_recovery_contacts(id, owner_user_id) ON DELETE RESTRICT
);

CREATE INDEX account_recovery_contact_removals_contact_idx
    ON account_recovery_contact_removals(contact_id, created_at DESC);

CREATE TABLE account_recovery_attempts (
    id                           uuid PRIMARY KEY DEFAULT uuidv7(),
    approval_token_hash          bytea NOT NULL UNIQUE,
    claim_token_hash             bytea NOT NULL UNIQUE,
    creation_idempotency_key     uuid NOT NULL UNIQUE,
    initiating_session_id        uuid,
    initiating_user_id           uuid,
    status                       varchar(12) NOT NULL DEFAULT 'PENDING',
    target_user_id               uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    approved_by_user_id          uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    recovery_contact_id          uuid,
    approval_idempotency_key     uuid,
    completed_session_id         uuid UNIQUE,
    completion_idempotency_key   uuid,
    created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at                   timestamptz NOT NULL,
    approved_at                  timestamptz,
    completed_at                 timestamptz,
    terminal_at                  timestamptz,

    CONSTRAINT account_recovery_attempts_approval_hash_ck
        CHECK (octet_length(approval_token_hash) = 32),
    CONSTRAINT account_recovery_attempts_claim_hash_ck
        CHECK (octet_length(claim_token_hash) = 32),
    CONSTRAINT account_recovery_attempts_distinct_hashes_ck
        CHECK (approval_token_hash <> claim_token_hash),
    CONSTRAINT account_recovery_attempts_expiry_ck CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
    ),
    CONSTRAINT account_recovery_attempts_status_ck CHECK (
        status IN ('PENDING', 'APPROVED', 'COMPLETED', 'CANCELLED', 'EXPIRED')
    ),
    CONSTRAINT account_recovery_attempts_initiating_pair_ck CHECK (
        (initiating_session_id IS NULL) = (initiating_user_id IS NULL)
    ),
    CONSTRAINT account_recovery_attempts_initiating_session_fk
        FOREIGN KEY (initiating_session_id, initiating_user_id)
        REFERENCES app_sessions(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT account_recovery_attempts_contact_shape_ck CHECK (
        (approved_at IS NULL AND target_user_id IS NULL AND approved_by_user_id IS NULL
            AND recovery_contact_id IS NULL AND approval_idempotency_key IS NULL)
        OR (approved_at IS NOT NULL AND target_user_id IS NOT NULL AND approved_by_user_id IS NOT NULL
            AND recovery_contact_id IS NOT NULL AND approval_idempotency_key IS NOT NULL
            AND approved_at <= expires_at)
    ),
    CONSTRAINT account_recovery_attempts_contact_fk
        FOREIGN KEY (recovery_contact_id, target_user_id, approved_by_user_id)
        REFERENCES account_recovery_contacts(id, owner_user_id, trustee_user_id) ON DELETE RESTRICT,
    CONSTRAINT account_recovery_attempts_completed_pair_ck CHECK (
        (completed_session_id IS NULL) = (completion_idempotency_key IS NULL)
    ),
    CONSTRAINT account_recovery_attempts_completed_session_fk
        FOREIGN KEY (completed_session_id, target_user_id)
        REFERENCES app_sessions(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT account_recovery_attempts_state_ck CHECK (
        (status = 'PENDING' AND approved_at IS NULL AND completed_at IS NULL
            AND completed_session_id IS NULL AND terminal_at IS NULL)
        OR (status = 'APPROVED' AND approved_at IS NOT NULL AND completed_at IS NULL
            AND completed_session_id IS NULL AND terminal_at IS NULL)
        OR (status = 'COMPLETED' AND approved_at IS NOT NULL AND completed_at IS NOT NULL
            AND completed_at <= expires_at AND completed_session_id IS NOT NULL AND terminal_at IS NULL)
        OR (status IN ('CANCELLED', 'EXPIRED') AND completed_at IS NULL
            AND completed_session_id IS NULL AND terminal_at IS NOT NULL)
    ),
    CONSTRAINT account_recovery_attempts_approval_idempotency_uq
        UNIQUE (approved_by_user_id, approval_idempotency_key)
);

CREATE UNIQUE INDEX account_recovery_attempts_active_target_uq
    ON account_recovery_attempts(target_user_id) WHERE status = 'APPROVED';
CREATE INDEX account_recovery_attempts_expiry_idx
    ON account_recovery_attempts(expires_at) WHERE status IN ('PENDING', 'APPROVED');

CREATE FUNCTION guard_direct_invite_link_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
        IF OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED') THEN
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

CREATE TRIGGER direct_invite_links_state_guard
BEFORE INSERT OR UPDATE ON direct_invite_links
FOR EACH ROW EXECUTE FUNCTION guard_direct_invite_link_state();

CREATE FUNCTION guard_account_recovery_contact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM user_row.id
          FROM app_users user_row
         WHERE user_row.id IN (NEW.owner_user_id, NEW.trustee_user_id)
         ORDER BY user_row.id
         FOR NO KEY UPDATE;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
            OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
            OR NEW.trustee_user_id IS DISTINCT FROM OLD.trustee_user_id
            OR NEW.direct_circle_id IS DISTINCT FROM OLD.direct_circle_id
            OR NEW.direct_circle_kind IS DISTINCT FROM OLD.direct_circle_kind
            OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
            OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'recovery contact identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'revoked recovery contact is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL
            AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'recovery contact can only be revoked' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' AND NOT EXISTS (
        SELECT 1
          FROM circles circle
          JOIN app_users owner_user ON owner_user.id = NEW.owner_user_id AND owner_user.deleted_at IS NULL
          JOIN app_users trustee_user ON trustee_user.id = NEW.trustee_user_id AND trustee_user.deleted_at IS NULL
         WHERE circle.id = NEW.direct_circle_id
           AND circle.kind = 'DIRECT'
           AND circle.archived_at IS NULL
           AND circle.direct_user_low_id = LEAST(NEW.owner_user_id, NEW.trustee_user_id)
           AND circle.direct_user_high_id = GREATEST(NEW.owner_user_id, NEW.trustee_user_id)
    ) THEN
        RAISE EXCEPTION 'recovery contact must use the exact active direct circle'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND (
        SELECT count(*) FROM account_recovery_contacts contact
         WHERE contact.owner_user_id = NEW.owner_user_id AND contact.revoked_at IS NULL
    ) >= 3 THEN
        RAISE EXCEPTION 'recovery contact limit exceeded' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER account_recovery_contacts_state_guard
BEFORE INSERT OR UPDATE ON account_recovery_contacts
FOR EACH ROW EXECUTE FUNCTION guard_account_recovery_contact();

CREATE FUNCTION guard_account_recovery_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
            OR NEW.approval_token_hash IS DISTINCT FROM OLD.approval_token_hash
            OR NEW.claim_token_hash IS DISTINCT FROM OLD.claim_token_hash
            OR NEW.creation_idempotency_key IS DISTINCT FROM OLD.creation_idempotency_key
            OR NEW.initiating_session_id IS DISTINCT FROM OLD.initiating_session_id
            OR NEW.initiating_user_id IS DISTINCT FROM OLD.initiating_user_id
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
            RAISE EXCEPTION 'recovery attempt identity is immutable' USING ERRCODE = '23514';
        END IF;

        IF OLD.approved_at IS NOT NULL AND (
            NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
            OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
            OR NEW.recovery_contact_id IS DISTINCT FROM OLD.recovery_contact_id
            OR NEW.approval_idempotency_key IS DISTINCT FROM OLD.approval_idempotency_key
            OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
        ) THEN
            RAISE EXCEPTION 'recovery approval is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'PENDING' AND NEW.status IN ('CANCELLED', 'EXPIRED') AND (
            NEW.target_user_id IS NOT NULL
            OR NEW.approved_by_user_id IS NOT NULL
            OR NEW.recovery_contact_id IS NOT NULL
            OR NEW.approval_idempotency_key IS NOT NULL
            OR NEW.approved_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'unapproved recovery cannot acquire a target' USING ERRCODE = '23514';
        END IF;

        IF NEW.status = OLD.status THEN
            IF NEW IS DISTINCT FROM OLD THEN
                RAISE EXCEPTION 'invalid recovery attempt mutation' USING ERRCODE = '23514';
            END IF;
        ELSIF NOT (
            (OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'CANCELLED', 'EXPIRED'))
            OR (OLD.status = 'APPROVED' AND NEW.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED'))
        ) THEN
            RAISE EXCEPTION 'invalid recovery attempt transition' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.status IN ('APPROVED', 'COMPLETED') AND NOT EXISTS (
        SELECT 1
          FROM account_recovery_contacts contact
          JOIN circles circle ON circle.id = contact.direct_circle_id
          JOIN app_users owner_user ON owner_user.id = contact.owner_user_id AND owner_user.deleted_at IS NULL
          JOIN app_users trustee_user ON trustee_user.id = contact.trustee_user_id AND trustee_user.deleted_at IS NULL
         WHERE contact.id = NEW.recovery_contact_id
           AND contact.owner_user_id = NEW.target_user_id
           AND contact.trustee_user_id = NEW.approved_by_user_id
           AND contact.revoked_at IS NULL
           AND circle.kind = 'DIRECT'
           AND circle.archived_at IS NULL
           AND circle.direct_user_low_id = LEAST(contact.owner_user_id, contact.trustee_user_id)
           AND circle.direct_user_high_id = GREATEST(contact.owner_user_id, contact.trustee_user_id)
    ) THEN
        RAISE EXCEPTION 'recovery approval is no longer active' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'COMPLETED' AND NOT EXISTS (
        SELECT 1
          FROM app_sessions completed_session
         WHERE completed_session.id = NEW.completed_session_id
           AND completed_session.user_id = NEW.target_user_id
           AND completed_session.token_hash = NEW.claim_token_hash
           AND completed_session.revoked_at IS NULL
           AND completed_session.expires_at > NEW.completed_at
    ) THEN
        RAISE EXCEPTION 'completed recovery must promote the active claim session'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER account_recovery_attempts_state_guard
BEFORE INSERT OR UPDATE ON account_recovery_attempts
FOR EACH ROW EXECUTE FUNCTION guard_account_recovery_attempt();

CREATE FUNCTION revoke_recovery_for_archived_direct_circle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND NEW.kind = 'DIRECT' THEN
        UPDATE account_recovery_contacts
           SET revoked_at = GREATEST(NEW.archived_at, created_at)
         WHERE direct_circle_id = NEW.id AND revoked_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER circles_revoke_recovery_contacts
AFTER UPDATE OF archived_at ON circles
FOR EACH ROW EXECUTE FUNCTION revoke_recovery_for_archived_direct_circle();

CREATE FUNCTION cancel_attempts_for_revoked_recovery_contact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
        UPDATE account_recovery_attempts
           SET status = 'CANCELLED', terminal_at = GREATEST(NEW.revoked_at, created_at)
         WHERE recovery_contact_id = NEW.id AND status = 'APPROVED';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER recovery_contact_cancels_attempts
AFTER UPDATE OF revoked_at ON account_recovery_contacts
FOR EACH ROW EXECUTE FUNCTION cancel_attempts_for_revoked_recovery_contact();
