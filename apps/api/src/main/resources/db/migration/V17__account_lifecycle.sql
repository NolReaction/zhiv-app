ALTER TABLE account_login_flows DROP CONSTRAINT account_login_flows_intent_check;
ALTER TABLE account_login_flows ADD CONSTRAINT account_login_flows_intent_check CHECK (intent IN ('login','register','link','account'));
ALTER TABLE account_login_flows ADD COLUMN account_action varchar(10);
ALTER TABLE account_login_flows ADD COLUMN account_role varchar(10);
ALTER TABLE account_login_flows ADD COLUMN account_proved_at timestamptz;
-- Completed legacy register flows no longer need the submitted display name.
UPDATE account_login_flows SET display_name=NULL WHERE consumed_at IS NOT NULL;
ALTER TABLE account_login_flows ADD CONSTRAINT account_login_flows_account_shape CHECK (
    (intent <> 'account' AND account_action IS NULL AND account_role IS NULL)
    OR (intent='account' AND session_hash IS NOT NULL AND provider IN ('email','vk')
        AND account_action IS NOT NULL AND account_role IS NOT NULL
        AND account_action IN ('email','merge','delete')
        AND (account_role='current' OR (account_role='other' AND account_action='merge')
             OR (account_role='new-email' AND account_action='email' AND provider='email')))
);

CREATE TABLE account_action_proofs (
    flow_hash bytea PRIMARY KEY REFERENCES account_login_flows(token_hash) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_users(id),
    session_hash bytea NOT NULL CHECK (octet_length(session_hash)=32),
    browser_hash bytea NOT NULL CHECK (octet_length(browser_hash)=32),
    action varchar(10) NOT NULL CHECK (action IN ('email','merge','delete')),
    role varchar(10) NOT NULL CHECK (role IN ('current','other','new-email')),
    provider varchar(16) NOT NULL CHECK (provider IN ('email','vk')),
    subject varchar(254) NOT NULL,
    proved_user_id uuid REFERENCES app_users(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE INDEX account_action_proofs_session_idx ON account_action_proofs(session_hash,action,role);
CREATE TABLE account_merge_previews (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
    user_id uuid NOT NULL REFERENCES app_users(id),
    other_user_id uuid NOT NULL REFERENCES app_users(id),
    session_hash bytea NOT NULL CHECK (octet_length(session_hash)=32),
    browser_hash bytea NOT NULL CHECK (octet_length(browser_hash)=32),
    current_proof_hash bytea NOT NULL,
    other_proof_hash bytea NOT NULL,
    state_hash bytea NOT NULL,
    choices_json text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
-- An irreversible identity change invalidates even a provider callback already in flight.
-- Store only a digest, never a removed email/provider subject.
CREATE TABLE account_identity_retirements (
    provider varchar(16) NOT NULL,
    subject_hash bytea NOT NULL CHECK (octet_length(subject_hash)=32),
    retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(provider,subject_hash)
);

CREATE TABLE account_operation_receipts (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
    action varchar(10) NOT NULL CHECK (action IN ('email','merge','delete')),
    user_id uuid NOT NULL REFERENCES app_users(id),
    session_hash bytea NOT NULL CHECK (octet_length(session_hash)=32),
    browser_hash bytea NOT NULL CHECK (octet_length(browser_hash)=32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours'
);

-- Only the proof-bound definer below can write a transaction-local transfer authorization.
CREATE TABLE account_group_owner_transfers (
    circle_id uuid PRIMARY KEY REFERENCES circles(id),
    source_user_id uuid NOT NULL REFERENCES app_users(id),
    target_user_id uuid NOT NULL REFERENCES app_users(id),
    transaction_id bigint NOT NULL
);
REVOKE ALL ON account_group_owner_transfers FROM PUBLIC;

CREATE FUNCTION account_group_transfer_allowed(group_id uuid,old_owner uuid,new_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT EXISTS(SELECT 1 FROM public.account_group_owner_transfers t
      WHERE t.circle_id=group_id AND t.source_user_id=old_owner AND t.target_user_id=new_owner
        AND t.transaction_id=txid_current());
$$;

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
        ) THEN
            RAISE EXCEPTION 'archive time conflicts with relationship history' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION guard_group_creation_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.creation_idempotency_key IS DISTINCT FROM OLD.creation_idempotency_key AND NOT
        (NEW.creation_idempotency_key IS NULL AND OLD.kind='GROUP' AND OLD.archived_at IS NULL
         AND account_group_transfer_allowed(OLD.id,OLD.created_by_user_id,NEW.created_by_user_id)) THEN
        RAISE EXCEPTION 'group creation identity is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION guard_group_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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

    IF TG_OP = 'UPDATE' AND OLD.role = 'OWNER' AND NEW.role <> 'OWNER' AND NOT EXISTS (
        SELECT 1 FROM public.account_group_owner_transfers t WHERE t.circle_id=OLD.circle_id
          AND t.source_user_id=OLD.user_id AND t.transaction_id=txid_current()
    ) THEN
        RAISE EXCEPTION 'group OWNER role is immutable' USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;


CREATE FUNCTION account_transfer_group_owner(group_id uuid,source_id uuid,target_id uuid,preview_hash bytea,session_binding bytea,browser_binding bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE was_member boolean;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.account_merge_previews p
        JOIN public.app_sessions s ON s.token_hash=p.session_hash
        JOIN public.account_action_proofs a ON a.flow_hash=p.current_proof_hash
        JOIN public.account_action_proofs b ON b.flow_hash=p.other_proof_hash
        JOIN public.account_login_identities ai ON ai.provider=a.provider AND ai.subject=a.subject AND ai.user_id=target_id
        JOIN public.account_login_identities bi ON bi.provider=b.provider AND bi.subject=b.subject AND bi.user_id=source_id
        WHERE p.token_hash=preview_hash AND p.user_id=target_id AND p.other_user_id=source_id
          AND p.session_hash=session_binding AND p.browser_hash=browser_binding
          AND p.consumed_at IS NULL AND p.expires_at>clock_timestamp()
          AND s.user_id=target_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND a.user_id=target_id AND a.proved_user_id=target_id AND a.action='merge' AND a.role='current'
          AND b.user_id=target_id AND b.proved_user_id=source_id AND b.action='merge' AND b.role='other'
          AND a.session_hash=session_binding AND b.session_hash=session_binding
          AND a.browser_hash=browser_binding AND b.browser_hash=browser_binding
          AND a.expires_at>clock_timestamp() AND b.expires_at>clock_timestamp()
    ) THEN RAISE EXCEPTION 'fresh merge proof required' USING ERRCODE='42501'; END IF;
    PERFORM id FROM public.app_users WHERE id IN(source_id,target_id) AND deleted_at IS NULL ORDER BY id FOR NO KEY UPDATE;
    IF NOT EXISTS(SELECT 1 FROM public.app_users WHERE id=source_id AND deleted_at IS NULL)
       OR NOT EXISTS(SELECT 1 FROM public.app_users WHERE id=target_id AND deleted_at IS NULL)
       OR source_id=target_id THEN RAISE EXCEPTION 'inactive transfer profile' USING ERRCODE='23514'; END IF;
    PERFORM id FROM public.circles WHERE id=group_id AND kind='GROUP' AND created_by_user_id=source_id AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'active owned group required' USING ERRCODE='23514'; END IF;
    SELECT EXISTS(SELECT 1 FROM public.circle_memberships WHERE circle_id=group_id AND user_id=target_id AND left_at IS NULL) INTO was_member;
    INSERT INTO public.account_group_owner_transfers VALUES(group_id,source_id,target_id,txid_current());
    UPDATE public.circle_memberships SET role='MEMBER' WHERE circle_id=group_id AND user_id=source_id AND left_at IS NULL AND role='OWNER';
    UPDATE public.circles SET created_by_user_id=target_id,creation_idempotency_key=NULL WHERE id=group_id;
    IF was_member THEN
        UPDATE public.circle_memberships SET role='OWNER' WHERE circle_id=group_id AND user_id=target_id AND left_at IS NULL;
    ELSE
        INSERT INTO public.circle_memberships(circle_id,user_id,role,share_latest,history_visibility)
            VALUES(group_id,target_id,'OWNER',false,'FROM_JOIN');
    END IF;
    DELETE FROM public.account_group_owner_transfers WHERE circle_id=group_id;
    RETURN NOT was_member;
END;
$$;
REVOKE ALL ON FUNCTION account_transfer_group_owner(uuid,uuid,uuid,bytea,bytea,bytea) FROM PUBLIC;
-- Merge history is available only through authenticated self-profile queries.
-- Event actors, audiences, recipient IDs and membership epochs remain immutable.
-- Every retired source points directly to the final profile; lifecycle mutations
-- redirect all inbound sources when that profile is merged again. A deleted
-- target keeps its mappings, but cannot authenticate to read the retained history.
CREATE TABLE account_merge_sources (
    source_user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
    target_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    CONSTRAINT account_merge_sources_distinct_users_ck CHECK (source_user_id <> target_user_id)
);
CREATE INDEX account_merge_sources_target_idx ON account_merge_sources(target_user_id);

-- These helpers do not authorize access. Callers must authenticate the target;
-- social and audience queries must continue using original user IDs exclusively.
CREATE FUNCTION account_history_user_ids(p_user_id uuid)
RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE STRICT AS $$
    SELECT p_user_id
    UNION ALL
    SELECT source_user_id FROM account_merge_sources WHERE target_user_id = p_user_id;
$$;

CREATE FUNCTION account_check_in_summary(p_user_id uuid)
RETURNS TABLE(check_in_count bigint, last_check_in_at timestamptz)
LANGUAGE sql STABLE STRICT AS $$
    SELECT count(*), max(event.checked_at)
      FROM account_history_user_ids(p_user_id) history_user
      JOIN check_ins event ON event.user_id = history_user.user_id;
$$;

CREATE OR REPLACE FUNCTION rolling_check_in_streak(
    p_user_id uuid,
    p_server_time timestamptz
) RETURNS TABLE (
    current_days bigint,
    longest_days bigint,
    is_active boolean,
    renew_by timestamptz
)
LANGUAGE sql STABLE STRICT AS $fn$
WITH ordered AS (
    SELECT event.id, event.checked_at,
           lag(event.checked_at) OVER (ORDER BY event.checked_at, event.id) AS previous_at
      FROM account_history_user_ids(p_user_id) history_user
      JOIN check_ins event ON event.user_id = history_user.user_id
     WHERE event.checked_at <= p_server_time
), tagged AS (
    SELECT id, checked_at,
           CASE WHEN previous_at IS NULL
                     OR checked_at > previous_at + interval '24 hours'
                THEN 1 ELSE 0 END AS starts_run
      FROM ordered
), numbered AS (
    SELECT id, checked_at,
           sum(starts_run) OVER (
               ORDER BY checked_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS run_no
      FROM tagged
), runs AS (
    SELECT run_no,
           min(checked_at) AS started_at,
           max(checked_at) AS last_at,
           (floor(extract(epoch FROM (max(checked_at) - min(checked_at))) / 86400) + 1)::bigint AS day_count
      FROM numbered
     GROUP BY run_no
), summary AS (
    SELECT coalesce(max(day_count), 0)::bigint AS longest_days FROM runs
), latest AS (
    SELECT last_at, day_count FROM runs ORDER BY run_no DESC LIMIT 1
)
SELECT CASE WHEN latest.last_at IS NOT NULL
                  AND p_server_time <= latest.last_at + interval '24 hours'
            THEN latest.day_count ELSE 0 END::bigint AS current_days,
       summary.longest_days,
       coalesce(p_server_time <= latest.last_at + interval '24 hours', false) AS is_active,
       CASE WHEN latest.last_at IS NOT NULL
                  AND p_server_time <= latest.last_at + interval '24 hours'
            THEN latest.last_at + interval '24 hours' END AS renew_by
  FROM summary
  LEFT JOIN latest ON true;
$fn$;

COMMENT ON FUNCTION rolling_check_in_streak(uuid, timestamptz) IS
    'Authenticated self-profile rolling streak across directly merged sources. Social audiences retain original actor IDs.';

CREATE OR REPLACE FUNCTION daily_check_in_streak(
    p_user_id uuid,
    p_server_time timestamptz,
    p_timezone_id varchar
) RETURNS TABLE (
    current_days bigint,
    longest_days bigint,
    checked_in_today boolean,
    next_day_at timestamptz
)
LANGUAGE sql STABLE STRICT AS $$
WITH local_clock AS (
    SELECT (p_server_time AT TIME ZONE p_timezone_id)::date AS today
),
days AS (
    SELECT DISTINCT event.local_date
      FROM account_history_user_ids(p_user_id) history_user
      JOIN check_ins event ON event.user_id = history_user.user_id
      CROSS JOIN local_clock clock
     WHERE event.local_date <= clock.today
),
numbered AS (
    SELECT local_date,
           row_number() OVER (ORDER BY local_date) AS asc_no,
           row_number() OVER (ORDER BY local_date DESC) AS desc_no,
           max(local_date) OVER () AS latest_date
      FROM days
),
runs AS (
    SELECT count(*)::bigint AS length
      FROM numbered
     GROUP BY local_date - asc_no::integer
)
SELECT
    CASE
        WHEN max(numbered.latest_date) IS NULL
          OR max(numbered.latest_date) < local_clock.today - 1
        THEN 0
        ELSE count(*) FILTER (
            WHERE numbered.local_date =
                numbered.latest_date - (numbered.desc_no::integer - 1)
        )
    END::bigint AS current_days,
    COALESCE((SELECT max(length) FROM runs), 0) AS longest_days,
    COALESCE(bool_or(numbered.local_date = local_clock.today), false) AS checked_in_today,
    ((local_clock.today + 1)::timestamp AT TIME ZONE p_timezone_id) AS next_day_at
FROM local_clock
LEFT JOIN numbered ON TRUE
GROUP BY local_clock.today;
$$;
