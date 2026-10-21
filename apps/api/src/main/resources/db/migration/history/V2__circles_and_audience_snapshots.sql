CREATE TABLE circles (
    id                      uuid PRIMARY KEY DEFAULT uuidv7(),
    kind                    varchar(10) NOT NULL,
    title                   varchar(64),
    emoji                   varchar(16),
    created_by_user_id      uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    direct_user_low_id      uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    direct_user_high_id     uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    archived_at             timestamptz,

    CONSTRAINT circles_id_kind_uq UNIQUE (id, kind),
    CONSTRAINT circles_kind_ck CHECK (kind IN ('DIRECT', 'GROUP')),
    CONSTRAINT circles_title_ck CHECK (
        title IS NULL OR (char_length(title) BETWEEN 1 AND 64 AND title = btrim(title))
    ),
    CONSTRAINT circles_shape_ck CHECK (
        (
            kind = 'DIRECT'
            AND direct_user_low_id IS NOT NULL
            AND direct_user_high_id IS NOT NULL
            AND direct_user_low_id < direct_user_high_id
            AND created_by_user_id IN (direct_user_low_id, direct_user_high_id)
            AND title IS NULL
        )
        OR
        (
            kind = 'GROUP'
            AND direct_user_low_id IS NULL
            AND direct_user_high_id IS NULL
            AND title IS NOT NULL
        )
    ),
    CONSTRAINT circles_dates_ck CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE UNIQUE INDEX circles_active_direct_pair_uq
    ON circles(direct_user_low_id, direct_user_high_id)
    WHERE kind = 'DIRECT' AND archived_at IS NULL;

CREATE TABLE circle_memberships (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    circle_id           uuid NOT NULL,
    circle_kind         varchar(10) NOT NULL DEFAULT 'GROUP',
    user_id             uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    role                varchar(10) NOT NULL DEFAULT 'MEMBER',
    share_latest        boolean NOT NULL DEFAULT true,
    history_visibility  varchar(16) NOT NULL DEFAULT 'FROM_JOIN',
    joined_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    left_at             timestamptz,

    CONSTRAINT circle_memberships_group_ck CHECK (circle_kind = 'GROUP'),
    CONSTRAINT circle_memberships_circle_fk
        FOREIGN KEY (circle_id, circle_kind) REFERENCES circles(id, kind) ON DELETE RESTRICT,
    CONSTRAINT circle_memberships_role_ck CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
    CONSTRAINT circle_memberships_history_ck
        CHECK (history_visibility IN ('FROM_JOIN', 'LATEST_ONLY', 'NONE')),
    CONSTRAINT circle_memberships_dates_ck CHECK (left_at IS NULL OR left_at > joined_at),
    CONSTRAINT circle_memberships_snapshot_uq UNIQUE (id, circle_id, user_id)
);

CREATE UNIQUE INDEX circle_memberships_active_uq
    ON circle_memberships(circle_id, user_id)
    WHERE left_at IS NULL;

CREATE INDEX circle_memberships_user_active_idx
    ON circle_memberships(user_id, circle_id)
    WHERE left_at IS NULL;

CREATE TABLE direct_requests (
    id                      uuid PRIMARY KEY DEFAULT uuidv7(),
    requester_user_id       uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    recipient_user_id       uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    status                  varchar(12) NOT NULL DEFAULT 'PENDING',
    result_circle_id        uuid,
    result_circle_kind      varchar(10),
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    responded_at            timestamptz,

    CONSTRAINT direct_requests_users_ck CHECK (requester_user_id <> recipient_user_id),
    CONSTRAINT direct_requests_status_ck
        CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT direct_requests_circle_fk
        FOREIGN KEY (result_circle_id, result_circle_kind) REFERENCES circles(id, kind),
    CONSTRAINT direct_requests_state_ck CHECK (
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
            status IN ('REJECTED', 'CANCELLED') AND responded_at IS NOT NULL
            AND result_circle_id IS NULL AND result_circle_kind IS NULL
        )
    )
);

CREATE UNIQUE INDEX direct_requests_pending_pair_uq
    ON direct_requests(
        LEAST(requester_user_id, recipient_user_id),
        GREATEST(requester_user_id, recipient_user_id)
    )
    WHERE status = 'PENDING';

CREATE INDEX direct_requests_recipient_idx
    ON direct_requests(recipient_user_id, created_at DESC)
    WHERE status = 'PENDING';

CREATE TABLE circle_invites (
    id                      uuid PRIMARY KEY DEFAULT uuidv7(),
    circle_id               uuid NOT NULL,
    circle_kind             varchar(10) NOT NULL DEFAULT 'GROUP',
    inviter_user_id         uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    invitee_user_id         uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    accepted_by_user_id     uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    token_hash              bytea NOT NULL UNIQUE,
    granted_role            varchar(10) NOT NULL DEFAULT 'MEMBER',
    status                  varchar(10) NOT NULL DEFAULT 'PENDING',
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at              timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
    accepted_at             timestamptz,
    revoked_at              timestamptz,

    CONSTRAINT circle_invites_group_ck CHECK (circle_kind = 'GROUP'),
    CONSTRAINT circle_invites_circle_fk
        FOREIGN KEY (circle_id, circle_kind) REFERENCES circles(id, kind) ON DELETE RESTRICT,
    CONSTRAINT circle_invites_hash_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT circle_invites_role_ck CHECK (granted_role IN ('ADMIN', 'MEMBER')),
    CONSTRAINT circle_invites_status_ck CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
    CONSTRAINT circle_invites_expiry_ck CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '7 days'
    ),
    CONSTRAINT circle_invites_state_ck CHECK (
        (
            status = 'PENDING' AND accepted_at IS NULL
            AND accepted_by_user_id IS NULL AND revoked_at IS NULL
        )
        OR
        (
            status = 'ACCEPTED' AND accepted_at IS NOT NULL
            AND accepted_by_user_id IS NOT NULL AND accepted_at <= expires_at
            AND revoked_at IS NULL
            AND (invitee_user_id IS NULL OR accepted_by_user_id = invitee_user_id)
        )
        OR
        (
            status = 'REVOKED' AND revoked_at IS NOT NULL
            AND accepted_at IS NULL AND accepted_by_user_id IS NULL
        )
    )
);

CREATE INDEX circle_invites_pending_expiry_idx
    ON circle_invites(expires_at)
    WHERE status = 'PENDING';

CREATE TABLE check_in_audiences (
    check_in_id                 uuid NOT NULL,
    actor_user_id               uuid NOT NULL,
    circle_id                   uuid NOT NULL,
    circle_kind                 varchar(10) NOT NULL,
    recipient_user_id           uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    recipient_membership_id     uuid,

    CONSTRAINT check_in_audiences_pk
        PRIMARY KEY (check_in_id, circle_id, recipient_user_id),
    CONSTRAINT check_in_audiences_check_in_fk
        FOREIGN KEY (check_in_id, actor_user_id)
        REFERENCES check_ins(id, user_id) ON DELETE CASCADE,
    CONSTRAINT check_in_audiences_circle_fk
        FOREIGN KEY (circle_id, circle_kind) REFERENCES circles(id, kind) ON DELETE RESTRICT,
    CONSTRAINT check_in_audiences_recipient_membership_fk
        FOREIGN KEY (recipient_membership_id, circle_id, recipient_user_id)
        REFERENCES circle_memberships(id, circle_id, user_id) ON DELETE RESTRICT,
    CONSTRAINT check_in_audiences_not_self_ck CHECK (actor_user_id <> recipient_user_id),
    CONSTRAINT check_in_audiences_shape_ck CHECK (
        (circle_kind = 'GROUP' AND recipient_membership_id IS NOT NULL)
        OR (circle_kind = 'DIRECT' AND recipient_membership_id IS NULL)
    )
);

CREATE INDEX check_in_audiences_recipient_idx
    ON check_in_audiences(recipient_user_id, check_in_id DESC);

CREATE INDEX check_in_audiences_circle_idx
    ON check_in_audiences(circle_id, actor_user_id, check_in_id DESC);
