-- Fresh schema at version 49. Flyway applies this baseline only to an empty database.
-- Generated from the unchanged V1-V49 history on PostgreSQL 18; no player data,
-- Flyway history, old backfills, currency rescaling or user resets are included.
-- Keep this baseline immutable after publication. Add future changes as V50+.
-- Historical upgrades are retained in history/. See docs/development/database-baseline.md.
-- pg_dump orders functions before tables, so defer SQL function-body validation
-- for this migration transaction only; normal connection settings remain intact.
SET LOCAL check_function_bodies = false;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: account_check_in_summary(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_check_in_summary(p_user_id uuid) RETURNS TABLE(check_in_count bigint, last_check_in_at timestamp with time zone)
    LANGUAGE sql STABLE STRICT
    AS $$
    SELECT count(*), max(event.checked_at)
      FROM account_history_user_ids(p_user_id) history_user
      JOIN check_ins event ON event.user_id = history_user.user_id;
$$;


--
-- Name: account_group_transfer_allowed(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_group_transfer_allowed(group_id uuid, old_owner uuid, new_owner uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
    SELECT EXISTS(SELECT 1 FROM public.account_group_owner_transfers t
      WHERE t.circle_id=group_id AND t.source_user_id=old_owner AND t.target_user_id=new_owner
        AND t.transaction_id=txid_current());
$$;


--
-- Name: account_history_user_ids(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_history_user_ids(p_user_id uuid) RETURNS TABLE(user_id uuid)
    LANGUAGE sql STABLE STRICT
    AS $$
    SELECT p_user_id
    UNION ALL
    SELECT source_user_id FROM account_merge_sources WHERE target_user_id = p_user_id;
$$;


--
-- Name: account_transfer_group_owner(uuid, uuid, uuid, bytea, bytea, bytea); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_transfer_group_owner(group_id uuid, source_id uuid, target_id uuid, preview_hash bytea, session_binding bytea, browser_binding bytea) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: active_direct_friend_ids(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.active_direct_friend_ids(p_user_id uuid) RETURNS TABLE(user_id uuid)
    LANGUAGE sql STABLE STRICT
    AS $$
    SELECT peer.id
    FROM circles c
    JOIN app_users peer ON peer.id = CASE WHEN c.direct_user_low_id = p_user_id
        THEN c.direct_user_high_id ELSE c.direct_user_low_id END
    WHERE c.kind = 'DIRECT' AND c.archived_at IS NULL AND peer.deleted_at IS NULL
      AND p_user_id IN (c.direct_user_low_id, c.direct_user_high_id);
$$;


--
-- Name: assert_active_group_owner(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_active_group_owner(target_circle_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: cancel_attempts_for_revoked_recovery_contact(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_attempts_for_revoked_recovery_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
        UPDATE account_recovery_attempts
           SET status = 'CANCELLED', terminal_at = GREATEST(NEW.revoked_at, created_at)
         WHERE recovery_contact_id = NEW.id AND status = 'APPROVED';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: daily_check_in_streak(uuid, timestamp with time zone, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.daily_check_in_streak(p_user_id uuid, p_server_time timestamp with time zone, p_timezone_id character varying) RETURNS TABLE(current_days bigint, longest_days bigint, checked_in_today boolean, next_day_at timestamp with time zone)
    LANGUAGE sql STABLE STRICT
    AS $$
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


--
-- Name: economy_currency_nominal_state(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.economy_currency_nominal_state(value jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    SELECT CASE WHEN coalesce(value->>'currencyScale','1')='10' THEN value ELSE
        value || jsonb_build_object('currencyScale',10,
            'wallet',(value->'wallet') || jsonb_build_object(
                'coins',(value->'wallet'->>'coins')::bigint*10,
                'pearls',(value->'wallet'->>'pearls')::bigint*10),
            'migration',(value->'migration') || jsonb_build_object(
                'coinsGranted',(value->'migration'->>'coinsGranted')::bigint*10),
            'jobs',coalesce((SELECT jsonb_agg(jsonb_set(job,'{cost,coins}',
                    to_jsonb((job->'cost'->>'coins')::bigint*10)) ORDER BY ordinal)
                FROM jsonb_array_elements(value->'jobs') WITH ORDINALITY AS ordered(job,ordinal)),'[]'::jsonb)) END
$$;


--
-- Name: economy_pearl_nominal_state(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.economy_pearl_nominal_state(value jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    WITH nominal AS (SELECT economy_currency_nominal_state(value) AS state)
    SELECT state || jsonb_build_object('pearlScale',50,
        'wallet',(state->'wallet') || jsonb_build_object('pearls',
            (value->'wallet'->>'pearls')::bigint *
            (50 / coalesce((value->>'pearlScale')::integer,(value->>'currencyScale')::integer,1))))
    FROM nominal
$$;


--
-- Name: economy_v1_initial_state(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.economy_v1_initial_state(legacy jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
    WITH old AS (
        SELECT greatest(0,coalesce((legacy->'resources'->>'sparks')::double precision,0)) AS sparks,
               greatest(0,coalesce((legacy->'resources'->>'wood')::double precision,0)) AS wood,
               greatest(0,coalesce((legacy->'resources'->>'stone')::double precision,0)) AS stone
    ), grant_value AS (
        SELECT least(500,floor(2*sqrt(sparks)+sqrt(wood)+sqrt(stone)))::bigint AS coins,
               least(30,floor(sqrt(wood)))::bigint AS wood,
               least(30,floor(sqrt(stone)))::bigint AS stone FROM old
    )
    SELECT jsonb_build_object(
        'schemaVersion',1,
        'wallet',jsonb_build_object('coins',coins,'pearls',0),
        'inventory',CASE WHEN wood>0 THEN jsonb_build_object('wood',wood) ELSE '{}'::jsonb END ||
                    CASE WHEN stone>0 THEN jsonb_build_object('stone',stone) ELSE '{}'::jsonb END,
        'buildings',jsonb_build_object(
            'home',least(5,greatest(1,coalesce((legacy->>'houseLevel')::integer,1))),
            'garden',1,'woodlot',0,'quarry',0,'dryer',0,
            'workshop',CASE WHEN coalesce((legacy->>'workshop')::boolean,false)
                THEN least(3,greatest(1,coalesce((legacy->>'workshopLevel')::integer,1))) ELSE 0 END),
        'jobs','[]'::jsonb,'completedExplorations',0,
        'migration',jsonb_build_object('version',1,'coinsGranted',coins,'woodGranted',wood,'stoneGranted',stone)
    ) FROM grant_value
$$;


--
-- Name: economy_v2_initial_state(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.economy_v2_initial_state(legacy jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT jsonb_set(initial, '{buildings}',
        jsonb_build_object('warehouse', 1, 'kiln', 0) || (initial->'buildings'))
    FROM (SELECT economy_v1_initial_state(legacy) AS initial) converted
$$;


--
-- Name: economy_v3_initial_state(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.economy_v3_initial_state(legacy jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    AS $$ SELECT economy_pearl_nominal_state(economy_v2_initial_state(legacy)) $$;


--
-- Name: economy_v4_initial_state(jsonb, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.economy_v4_initial_state(legacy jsonb, include_starting_pack boolean DEFAULT true) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    WITH initial AS (SELECT economy_v3_initial_state(legacy) AS state)
    SELECT CASE WHEN NOT include_starting_pack THEN state ELSE
        state || jsonb_build_object(
            'wallet',jsonb_build_object('coins',(state->'wallet'->>'coins')::bigint+2500,'pearls',1000),
            'inventory',(state->'inventory') || jsonb_build_object(
                'fish',10,'wood',coalesce((state->'inventory'->>'wood')::bigint,0)+10,
                'stone',coalesce((state->'inventory'->>'stone')::bigint,0)+10))
        END FROM initial
$$;


--
-- Name: effective_recipient_sharing(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_recipient_sharing(actor_id uuid, recipient_id uuid) RETURNS TABLE(sharing_mode character varying, enabled_since timestamp with time zone, updated_at timestamp with time zone, created_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
WITH state AS (
  SELECT count(*) AS paths, bool_or(p.sharing_mode='OFF') AS denied,
         max(p.enabled_since) AS enabled, max(p.updated_at) AS updated, min(p.path_since) AS epoch
  FROM active_recipient_sharing_paths p WHERE p.actor_user_id=actor_id AND p.recipient_user_id=recipient_id
), decision AS (
  SELECT s.*, p.enabled_since AS override_since, p.updated_at AS override_updated, p.created_at AS override_created,
    CASE WHEN paths=0 THEN 'OFF' WHEN p.sharing_mode IS NOT NULL THEN p.sharing_mode WHEN denied THEN 'OFF' ELSE 'LATEST_ONLY' END::varchar(16) AS mode
  FROM state s LEFT JOIN recipient_sharing_preferences p ON p.actor_user_id=actor_id AND p.recipient_user_id=recipient_id
)
SELECT mode, CASE WHEN mode='OFF' THEN NULL ELSE GREATEST(COALESCE(override_since,enabled),epoch) END,
       GREATEST(COALESCE(override_updated,updated),epoch), COALESCE(override_created,epoch)
FROM decision;
$$;


--
-- Name: enforce_circle_group_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_circle_group_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM assert_active_group_owner(OLD.id);
        RETURN OLD;
    END IF;
    PERFORM assert_active_group_owner(NEW.id);
    RETURN NEW;
END;
$$;


--
-- Name: enforce_membership_group_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_membership_group_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM assert_active_group_owner(OLD.circle_id);
        RETURN OLD;
    END IF;
    PERFORM assert_active_group_owner(NEW.circle_id);
    RETURN NEW;
END;
$$;


--
-- Name: guard_accepted_direct_request(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_accepted_direct_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_account_recovery_attempt(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_account_recovery_attempt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_account_recovery_contact(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_account_recovery_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_admin_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_admin_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Referential cleanup may detach a physically deleted account, while preserving
    -- the public-ID snapshot, action, reason, counts, and timestamp forever.
    IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1
       AND (to_jsonb(NEW) - 'actor_user_id' - 'target_user_id') = (to_jsonb(OLD) - 'actor_user_id' - 'target_user_id')
       AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id OR NEW.actor_user_id IS NULL)
       AND (NEW.target_user_id IS NOT DISTINCT FROM OLD.target_user_id OR NEW.target_user_id IS NULL) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'admin_actions is append-only' USING ERRCODE = '55000';
END;
$$;


--
-- Name: guard_archived_group_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_archived_group_profile() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.archived_at IS NOT NULL AND (
        NEW.title IS DISTINCT FROM OLD.title OR NEW.emoji IS DISTINCT FROM OLD.emoji
    ) THEN
        RAISE EXCEPTION 'archived group profile is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: guard_banned_session(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_banned_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE account_banned_at timestamptz;
BEGIN
    -- Revocation must not acquire a session-to-account lock: administrative
    -- writes already lock accounts before sessions, and revocation is always safe.
    IF NEW.revoked_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT banned_at INTO account_banned_at FROM app_users WHERE id=NEW.user_id FOR NO KEY UPDATE;
    IF account_banned_at IS NOT NULL THEN
        RAISE EXCEPTION 'account is banned' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: guard_check_in_audience(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_check_in_audience() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE event_at timestamptz;
BEGIN
  SELECT checked_at INTO STRICT event_at FROM check_ins WHERE id=NEW.check_in_id AND user_id=NEW.actor_user_id;
  IF NEW.circle_kind='DIRECT' THEN
    PERFORM c.id FROM circles c
    CROSS JOIN LATERAL effective_recipient_sharing(NEW.actor_user_id,NEW.recipient_user_id) p
    WHERE c.id=NEW.circle_id AND c.kind='DIRECT' AND c.created_at<=event_at AND (c.archived_at IS NULL OR c.archived_at>event_at)
      AND NEW.actor_user_id IN(c.direct_user_low_id,c.direct_user_high_id) AND NEW.recipient_user_id IN(c.direct_user_low_id,c.direct_user_high_id)
      AND NEW.actor_user_id<>NEW.recipient_user_id AND p.sharing_mode<>'OFF' AND p.enabled_since<=event_at AND p.updated_at<=event_at AND NEW.access_level=p.sharing_mode
    FOR SHARE OF c;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid DIRECT audience snapshot' USING ERRCODE='23514'; END IF;
  ELSIF NEW.circle_kind='GROUP' THEN
    PERFORM a.id FROM circles c
    JOIN circle_memberships a ON a.circle_id=c.id AND a.user_id=NEW.actor_user_id AND a.joined_at<=event_at AND (a.left_at IS NULL OR a.left_at>event_at)
    JOIN circle_memberships r ON r.id=NEW.recipient_membership_id AND r.circle_id=c.id AND r.user_id=NEW.recipient_user_id AND r.joined_at<=event_at AND (r.left_at IS NULL OR r.left_at>event_at) AND r.history_visibility<>'NONE'
    CROSS JOIN LATERAL effective_recipient_sharing(NEW.actor_user_id,NEW.recipient_user_id) p
    WHERE c.id=NEW.circle_id AND c.kind='GROUP' AND c.created_at<=event_at AND (c.archived_at IS NULL OR c.archived_at>event_at)
      AND NEW.actor_user_id<>NEW.recipient_user_id AND p.sharing_mode<>'OFF' AND p.enabled_since<=event_at AND p.updated_at<=event_at AND NEW.access_level=p.sharing_mode
    FOR SHARE OF c,a,r;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid GROUP audience snapshot' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'unknown circle kind' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_circle_invite_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_circle_invite_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_circle_inviter(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_circle_inviter() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_circle_sharing_preference(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_circle_sharing_preference() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_circle_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_circle_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_direct_invite_link_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_direct_invite_link_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_direct_invite_redemption(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_direct_invite_redemption() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_direct_request_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_direct_request_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_group_creation_key(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_group_creation_key() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.creation_idempotency_key IS DISTINCT FROM OLD.creation_idempotency_key AND NOT
        (NEW.creation_idempotency_key IS NULL AND OLD.kind='GROUP' AND OLD.archived_at IS NULL
         AND account_group_transfer_allowed(OLD.id,OLD.created_by_user_id,NEW.created_by_user_id)) THEN
        RAISE EXCEPTION 'group creation identity is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: guard_group_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_group_owner() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: guard_membership_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_membership_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_recipient_sharing_preference(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_recipient_sharing_preference() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE changed_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'privacy decisions are retained' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'immutable privacy identity' USING ERRCODE = '55000';
    END IF;
    NEW.enabled_since := CASE WHEN NEW.sharing_mode = 'OFF' THEN NULL WHEN OLD.sharing_mode = 'LATEST_ONLY' THEN OLD.enabled_since ELSE changed_at END;
  ELSE
    NEW.created_at := changed_at;
    NEW.enabled_since := CASE WHEN NEW.sharing_mode = 'OFF' THEN NULL ELSE changed_at END;
  END IF;
  NEW.updated_at := changed_at;
  RETURN NEW;
END $$;


--
-- Name: notification_account_invalidated(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notification_account_invalidated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL OR NEW.banned_at IS NOT NULL THEN
        DELETE FROM notification_subscriptions WHERE user_id=NEW.id;
        DELETE FROM notification_events WHERE user_id=NEW.id;
        DELETE FROM notification_preferences WHERE user_id=NEW.id;
        DELETE FROM notification_batches WHERE user_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;


--
-- Name: notification_checkin_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notification_checkin_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN PERFORM notification_sync_sources(NEW.user_id); RETURN NEW; END $$;


--
-- Name: notification_economy_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notification_economy_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN PERFORM notification_sync_sources(NEW.user_id); RETURN NEW; END $$;


--
-- Name: notification_merge_history_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notification_merge_history_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM notification_sync_sources(NEW.target_user_id);
    IF TG_OP='UPDATE' AND OLD.target_user_id IS DISTINCT FROM NEW.target_user_id THEN
        PERFORM notification_sync_sources(OLD.target_user_id);
    END IF;
    RETURN NEW;
END $$;


--
-- Name: notification_session_invalidated(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notification_session_invalidated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.revoked_at IS NOT NULL OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
        DELETE FROM notification_subscriptions WHERE session_id=OLD.id;
    END IF;
    RETURN NEW;
END $$;


--
-- Name: notification_sync_sources(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notification_sync_sources(p_user uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE jobs jsonb; last_check timestamptz; check_key text;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM notification_preferences WHERE user_id=p_user) THEN RETURN; END IF;
    SELECT coalesce(state->'jobs','[]'::jsonb) INTO jobs FROM economy_profiles WHERE user_id=p_user;
    jobs := coalesce(jobs,'[]'::jsonb);
    SELECT last_check_in_at INTO last_check FROM account_check_in_summary(p_user);
    check_key := CASE WHEN last_check IS NULL THEN NULL ELSE 'checkin:' || extract(epoch FROM last_check)::text END;
    DELETE FROM notification_events e WHERE e.user_id=p_user AND (
        (category='checkin' AND source_key IS DISTINCT FROM check_key) OR
        (category<>'checkin' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jobs) j WHERE 'job:' || (j->>'id')=e.source_key))
    );
    IF NOT EXISTS(SELECT 1 FROM notification_subscriptions n JOIN app_sessions s ON s.id=n.session_id
        WHERE n.user_id=p_user AND s.user_id=p_user AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RETURN; END IF;
    INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at)
    SELECT p_user,'job:' || (j->>'id'),j->>'kind',ready_at,ready_at
    FROM jsonb_array_elements(jobs) j
    CROSS JOIN LATERAL (SELECT CASE
        WHEN j->>'targetId'='garden'
            THEN nullif(j->'collection'->>'finishesAt','')::timestamptz
        ELSE (j->>'finishesAt')::timestamptz END AS ready_at) r
    WHERE j->>'kind' IN ('construction','exploration','production') AND ready_at IS NOT NULL
    ON CONFLICT(user_id,source_key) DO UPDATE SET due_at=EXCLUDED.due_at,
        next_attempt_at=CASE WHEN notification_events.due_at IS DISTINCT FROM EXCLUDED.due_at
            THEN EXCLUDED.due_at ELSE notification_events.next_attempt_at END
        WHERE notification_events.state IN ('pending','sending');
    -- A garden is not collectible when it merely ripens. Starting collection
    -- schedules its actual finish; removing/cancelling it removes the event.
    DELETE FROM notification_events e WHERE e.user_id=p_user AND e.category='production' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(jobs) j WHERE 'job:' || (j->>'id')=e.source_key
            AND j->>'targetId'='garden'
            AND j->'collection'->>'finishesAt' IS NULL
    );
    IF last_check IS NOT NULL THEN
        INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at)
        VALUES(p_user,check_key,'checkin',last_check+interval '24 hours 1 second',last_check+interval '24 hours 1 second')
        ON CONFLICT(user_id,source_key) DO NOTHING;
    END IF;
END $$;


--
-- Name: preserve_recipient_denies(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_recipient_denies(related_user uuid) RETURNS void
    LANGUAGE sql
    AS $$
INSERT INTO recipient_sharing_preferences(actor_user_id,recipient_user_id,sharing_mode)
SELECT actor_user_id,recipient_user_id,'OFF' FROM active_recipient_sharing_paths
WHERE actor_user_id=related_user OR recipient_user_id=related_user
GROUP BY actor_user_id,recipient_user_id HAVING bool_or(sharing_mode='OFF') ON CONFLICT DO NOTHING;
$$;


--
-- Name: reject_check_in_audience_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_check_in_audience_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'check_in_audiences is append-only' USING ERRCODE = '55000';
END;
$$;


--
-- Name: reject_check_in_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_check_in_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'check_ins is append-only' USING ERRCODE = '55000';
END;
$$;


--
-- Name: rolling_check_in_streak(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rolling_check_in_streak(p_user_id uuid, p_server_time timestamp with time zone) RETURNS TABLE(current_days bigint, longest_days bigint, is_active boolean, renew_by timestamp with time zone)
    LANGUAGE sql STABLE STRICT
    AS $$
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
$$;




--
-- Name: account_action_proofs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_action_proofs (
    flow_hash bytea NOT NULL,
    user_id uuid NOT NULL,
    session_hash bytea NOT NULL,
    browser_hash bytea NOT NULL,
    action character varying(10) NOT NULL,
    role character varying(10) NOT NULL,
    provider character varying(16) NOT NULL,
    subject character varying(254) NOT NULL,
    proved_user_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '00:05:00'::interval) NOT NULL,
    CONSTRAINT account_action_proofs_action_check CHECK (((action)::text = ANY ((ARRAY['email'::character varying, 'merge'::character varying, 'delete'::character varying])::text[]))),
    CONSTRAINT account_action_proofs_browser_hash_check CHECK ((octet_length(browser_hash) = 32)),
    CONSTRAINT account_action_proofs_provider_check CHECK (((provider)::text = ANY ((ARRAY['email'::character varying, 'vk'::character varying])::text[]))),
    CONSTRAINT account_action_proofs_role_check CHECK (((role)::text = ANY ((ARRAY['current'::character varying, 'other'::character varying, 'new-email'::character varying])::text[]))),
    CONSTRAINT account_action_proofs_session_hash_check CHECK ((octet_length(session_hash) = 32))
);


--
-- Name: account_group_owner_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_group_owner_transfers (
    circle_id uuid NOT NULL,
    source_user_id uuid NOT NULL,
    target_user_id uuid NOT NULL,
    transaction_id bigint NOT NULL
);


--
-- Name: account_identity_retirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_identity_retirements (
    provider character varying(16) NOT NULL,
    subject_hash bytea NOT NULL,
    retired_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    merged_into_user_id uuid,
    CONSTRAINT account_identity_retirements_subject_hash_check CHECK ((octet_length(subject_hash) = 32))
);


--
-- Name: account_login_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_login_flows (
    token_hash bytea NOT NULL,
    browser_hash bytea NOT NULL,
    provider character varying(16) NOT NULL,
    intent character varying(16) NOT NULL,
    session_hash bytea,
    display_name character varying(50),
    subject character varying(254),
    verifier character varying(128),
    nonce character varying(128),
    code_hash bytea,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '00:10:00'::interval) NOT NULL,
    consumed_at timestamp with time zone,
    account_action character varying(10),
    account_role character varying(10),
    account_proved_at timestamp with time zone,
    CONSTRAINT account_login_flows_account_shape CHECK (((((intent)::text <> 'account'::text) AND (account_action IS NULL) AND (account_role IS NULL)) OR (((intent)::text = 'account'::text) AND (session_hash IS NOT NULL) AND ((provider)::text = ANY ((ARRAY['email'::character varying, 'vk'::character varying])::text[])) AND (account_action IS NOT NULL) AND (account_role IS NOT NULL) AND ((account_action)::text = ANY ((ARRAY['email'::character varying, 'merge'::character varying, 'delete'::character varying])::text[])) AND (((account_role)::text = 'current'::text) OR (((account_role)::text = 'other'::text) AND ((account_action)::text = 'merge'::text)) OR (((account_role)::text = 'new-email'::text) AND ((account_action)::text = 'email'::text) AND ((provider)::text = 'email'::text)))))),
    CONSTRAINT account_login_flows_attempts_check CHECK (((attempts >= 0) AND (attempts <= 5))),
    CONSTRAINT account_login_flows_browser_hash_check CHECK ((octet_length(browser_hash) = 32)),
    CONSTRAINT account_login_flows_check CHECK ((expires_at > created_at)),
    CONSTRAINT account_login_flows_check1 CHECK ((((intent)::text <> 'link'::text) OR (session_hash IS NOT NULL))),
    CONSTRAINT account_login_flows_intent_check CHECK (((intent)::text = ANY ((ARRAY['login'::character varying, 'register'::character varying, 'link'::character varying, 'account'::character varying])::text[]))),
    CONSTRAINT account_login_flows_provider_check CHECK (((provider)::text = ANY ((ARRAY['telegram'::character varying, 'email'::character varying, 'vk'::character varying])::text[]))),
    CONSTRAINT account_login_flows_token_hash_check CHECK ((octet_length(token_hash) = 32))
);


--
-- Name: account_login_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_login_identities (
    provider character varying(16) NOT NULL,
    subject character varying(254) NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT account_login_identities_provider_check CHECK (((provider)::text = ANY ((ARRAY['telegram'::character varying, 'email'::character varying, 'vk'::character varying])::text[])))
);


--
-- Name: account_merge_previews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_merge_previews (
    token_hash bytea NOT NULL,
    user_id uuid NOT NULL,
    other_user_id uuid NOT NULL,
    session_hash bytea NOT NULL,
    browser_hash bytea NOT NULL,
    current_proof_hash bytea NOT NULL,
    other_proof_hash bytea NOT NULL,
    state_hash bytea NOT NULL,
    choices_json text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT account_merge_previews_browser_hash_check CHECK ((octet_length(browser_hash) = 32)),
    CONSTRAINT account_merge_previews_session_hash_check CHECK ((octet_length(session_hash) = 32)),
    CONSTRAINT account_merge_previews_token_hash_check CHECK ((octet_length(token_hash) = 32))
);


--
-- Name: account_merge_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_merge_sources (
    source_user_id uuid NOT NULL,
    target_user_id uuid NOT NULL,
    CONSTRAINT account_merge_sources_distinct_users_ck CHECK ((source_user_id <> target_user_id))
);


--
-- Name: account_operation_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_operation_receipts (
    token_hash bytea NOT NULL,
    action character varying(10) NOT NULL,
    user_id uuid NOT NULL,
    session_hash bytea NOT NULL,
    browser_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT account_operation_receipts_action_check CHECK (((action)::text = ANY ((ARRAY['email'::character varying, 'merge'::character varying, 'delete'::character varying])::text[]))),
    CONSTRAINT account_operation_receipts_browser_hash_check CHECK ((octet_length(browser_hash) = 32)),
    CONSTRAINT account_operation_receipts_session_hash_check CHECK ((octet_length(session_hash) = 32)),
    CONSTRAINT account_operation_receipts_token_hash_check CHECK ((octet_length(token_hash) = 32))
);


--
-- Name: account_recovery_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_recovery_attempts (
    id uuid DEFAULT uuidv7() NOT NULL,
    approval_token_hash bytea NOT NULL,
    claim_token_hash bytea NOT NULL,
    creation_idempotency_key uuid NOT NULL,
    initiating_session_id uuid,
    initiating_user_id uuid,
    status character varying(12) DEFAULT 'PENDING'::character varying NOT NULL,
    target_user_id uuid,
    approved_by_user_id uuid,
    recovery_contact_id uuid,
    approval_idempotency_key uuid,
    completed_session_id uuid,
    completion_idempotency_key uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    approved_at timestamp with time zone,
    completed_at timestamp with time zone,
    terminal_at timestamp with time zone,
    CONSTRAINT account_recovery_attempts_approval_hash_ck CHECK ((octet_length(approval_token_hash) = 32)),
    CONSTRAINT account_recovery_attempts_claim_hash_ck CHECK ((octet_length(claim_token_hash) = 32)),
    CONSTRAINT account_recovery_attempts_completed_pair_ck CHECK (((completed_session_id IS NULL) = (completion_idempotency_key IS NULL))),
    CONSTRAINT account_recovery_attempts_contact_shape_ck CHECK ((((approved_at IS NULL) AND (target_user_id IS NULL) AND (approved_by_user_id IS NULL) AND (recovery_contact_id IS NULL) AND (approval_idempotency_key IS NULL)) OR ((approved_at IS NOT NULL) AND (target_user_id IS NOT NULL) AND (approved_by_user_id IS NOT NULL) AND (recovery_contact_id IS NOT NULL) AND (approval_idempotency_key IS NOT NULL) AND (approved_at <= expires_at)))),
    CONSTRAINT account_recovery_attempts_distinct_hashes_ck CHECK ((approval_token_hash <> claim_token_hash)),
    CONSTRAINT account_recovery_attempts_expiry_ck CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:10:00'::interval)))),
    CONSTRAINT account_recovery_attempts_initiating_pair_ck CHECK (((initiating_session_id IS NULL) = (initiating_user_id IS NULL))),
    CONSTRAINT account_recovery_attempts_state_ck CHECK (((((status)::text = 'PENDING'::text) AND (approved_at IS NULL) AND (completed_at IS NULL) AND (completed_session_id IS NULL) AND (terminal_at IS NULL)) OR (((status)::text = 'APPROVED'::text) AND (approved_at IS NOT NULL) AND (completed_at IS NULL) AND (completed_session_id IS NULL) AND (terminal_at IS NULL)) OR (((status)::text = 'COMPLETED'::text) AND (approved_at IS NOT NULL) AND (completed_at IS NOT NULL) AND (completed_at <= expires_at) AND (completed_session_id IS NOT NULL) AND (terminal_at IS NULL)) OR (((status)::text = ANY ((ARRAY['CANCELLED'::character varying, 'EXPIRED'::character varying])::text[])) AND (completed_at IS NULL) AND (completed_session_id IS NULL) AND (terminal_at IS NOT NULL)))),
    CONSTRAINT account_recovery_attempts_status_ck CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'COMPLETED'::character varying, 'CANCELLED'::character varying, 'EXPIRED'::character varying])::text[])))
);


--
-- Name: account_recovery_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_recovery_codes (
    code_hash bytea NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revoked_at timestamp with time zone,
    consumed_at timestamp with time zone,
    recovery_session_id uuid,
    retry_hash bytea,
    CONSTRAINT account_recovery_codes_check CHECK ((((consumed_at IS NULL) AND (recovery_session_id IS NULL) AND (retry_hash IS NULL)) OR ((consumed_at IS NOT NULL) AND (recovery_session_id IS NOT NULL) AND (retry_hash IS NOT NULL)))),
    CONSTRAINT account_recovery_codes_code_hash_check CHECK ((octet_length(code_hash) = 32)),
    CONSTRAINT account_recovery_codes_retry_hash_check CHECK (((retry_hash IS NULL) OR (octet_length(retry_hash) = 32)))
);


--
-- Name: account_recovery_contact_removals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_recovery_contact_removals (
    owner_user_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    contact_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: account_recovery_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_recovery_contacts (
    id uuid DEFAULT uuidv7() NOT NULL,
    owner_user_id uuid NOT NULL,
    trustee_user_id uuid NOT NULL,
    direct_circle_id uuid NOT NULL,
    direct_circle_kind character varying(10) DEFAULT 'DIRECT'::character varying NOT NULL,
    idempotency_key uuid NOT NULL,
    revocation_idempotency_key uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT account_recovery_contacts_dates_ck CHECK ((((revoked_at IS NULL) AND (revocation_idempotency_key IS NULL)) OR (revoked_at >= created_at))),
    CONSTRAINT account_recovery_contacts_direct_ck CHECK (((direct_circle_kind)::text = 'DIRECT'::text)),
    CONSTRAINT account_recovery_contacts_users_ck CHECK ((owner_user_id <> trustee_user_id))
);


--
-- Name: account_registration_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_registration_tickets (
    token_hash bytea NOT NULL,
    browser_hash bytea NOT NULL,
    provider character varying(16) NOT NULL,
    subject character varying(254) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '00:10:00'::interval) NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT account_registration_tickets_browser_hash_check CHECK ((octet_length(browser_hash) = 32)),
    CONSTRAINT account_registration_tickets_check CHECK ((expires_at > created_at)),
    CONSTRAINT account_registration_tickets_provider_check CHECK (((provider)::text = ANY ((ARRAY['telegram'::character varying, 'email'::character varying, 'vk'::character varying])::text[]))),
    CONSTRAINT account_registration_tickets_token_hash_check CHECK ((octet_length(token_hash) = 32))
);


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id uuid DEFAULT uuidv7() NOT NULL,
    public_id character varying(14) NOT NULL,
    display_name character varying(50) NOT NULL,
    timezone_id character varying(64) DEFAULT 'Europe/Moscow'::character varying NOT NULL,
    locale character varying(16) DEFAULT 'ru'::character varying NOT NULL,
    last_check_in_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    deleted_at timestamp with time zone,
    display_name_changed_at timestamp with time zone,
    display_name_change_key uuid,
    avatar_storage_key character varying(512),
    avatar_updated_at timestamp with time zone,
    status_text character varying(120),
    status_updated_at timestamp with time zone,
    status_expires_at timestamp with time zone,
    tag_text character varying(16),
    tag_color character varying(12),
    banned_at timestamp with time zone,
    ban_reason character varying(240),
    tap_watchlisted boolean DEFAULT false NOT NULL,
    tap_analyzed_at timestamp with time zone,
    tap_signal_at timestamp with time zone,
    CONSTRAINT app_users_avatar_state_ck CHECK ((((avatar_storage_key IS NULL) AND (avatar_updated_at IS NULL)) OR ((avatar_storage_key IS NOT NULL) AND ((char_length((avatar_storage_key)::text) >= 1) AND (char_length((avatar_storage_key)::text) <= 512)) AND ((avatar_storage_key)::text = btrim((avatar_storage_key)::text)) AND ((avatar_storage_key)::text !~ '[[:cntrl:]]'::text) AND (avatar_updated_at IS NOT NULL) AND ((avatar_updated_at >= created_at) AND (avatar_updated_at <= updated_at))))),
    CONSTRAINT app_users_ban_ck CHECK ((((banned_at IS NULL) AND (ban_reason IS NULL)) OR ((banned_at IS NOT NULL) AND (ban_reason IS NOT NULL) AND ((char_length((ban_reason)::text) >= 8) AND (char_length((ban_reason)::text) <= 240))))),
    CONSTRAINT app_users_dates_ck CHECK (((updated_at >= created_at) AND ((deleted_at IS NULL) OR (deleted_at >= created_at)))),
    CONSTRAINT app_users_display_name_change_state_ck CHECK ((((display_name_changed_at IS NULL) = (display_name_change_key IS NULL)) AND ((display_name_changed_at IS NULL) OR ((display_name_changed_at >= created_at) AND (display_name_changed_at <= updated_at))))),
    CONSTRAINT app_users_display_name_ck CHECK ((((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 50)) AND ((display_name)::text = btrim((display_name)::text)) AND ((display_name)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT app_users_public_id_format_ck CHECK (((public_id)::text ~ '^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$'::text)),
    CONSTRAINT app_users_status_expiry CHECK (((status_expires_at IS NULL) OR ((status_text IS NOT NULL) AND (status_updated_at IS NOT NULL) AND (status_expires_at > status_updated_at)))),
    CONSTRAINT app_users_status_nullity CHECK (((status_text IS NULL) = (status_updated_at IS NULL))),
    CONSTRAINT app_users_status_shape CHECK ((((status_text IS NULL) AND (status_updated_at IS NULL)) OR (((length((status_text)::text) >= 1) AND (length((status_text)::text) <= 120)) AND (status_updated_at IS NOT NULL) AND ((status_text)::text !~ '[[:cntrl:]]'::text)))),
    CONSTRAINT app_users_tag_ck CHECK ((((tag_text IS NULL) AND (tag_color IS NULL)) OR ((tag_text IS NOT NULL) AND ((tag_text)::text ~ '^[A-Za-zА-Яа-яЁё0-9_-]{1,16}$'::text) AND (tag_color IS NOT NULL) AND ((tag_color)::text = ANY ((ARRAY['red'::character varying, 'orange'::character varying, 'yellow'::character varying, 'green'::character varying, 'blue'::character varying, 'purple'::character varying, 'pink'::character varying, 'white'::character varying])::text[])))))
);


--
-- Name: circle_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_memberships (
    id uuid DEFAULT uuidv7() NOT NULL,
    circle_id uuid NOT NULL,
    circle_kind character varying(10) DEFAULT 'GROUP'::character varying NOT NULL,
    user_id uuid NOT NULL,
    role character varying(10) DEFAULT 'MEMBER'::character varying NOT NULL,
    share_latest boolean DEFAULT true NOT NULL,
    history_visibility character varying(16) DEFAULT 'FROM_JOIN'::character varying NOT NULL,
    joined_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    left_at timestamp with time zone,
    CONSTRAINT circle_memberships_dates_ck CHECK (((left_at IS NULL) OR (left_at > joined_at))),
    CONSTRAINT circle_memberships_group_ck CHECK (((circle_kind)::text = 'GROUP'::text)),
    CONSTRAINT circle_memberships_history_ck CHECK (((history_visibility)::text = ANY ((ARRAY['FROM_JOIN'::character varying, 'LATEST_ONLY'::character varying, 'NONE'::character varying])::text[]))),
    CONSTRAINT circle_memberships_role_ck CHECK (((role)::text = ANY ((ARRAY['OWNER'::character varying, 'ADMIN'::character varying, 'MEMBER'::character varying])::text[])))
);


--
-- Name: circle_sharing_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_sharing_preferences (
    circle_id uuid NOT NULL,
    user_id uuid NOT NULL,
    sharing_mode character varying(16) DEFAULT 'LATEST_ONLY'::character varying NOT NULL,
    enabled_since timestamp with time zone DEFAULT clock_timestamp(),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT circle_sharing_preferences_dates_ck CHECK ((updated_at >= created_at)),
    CONSTRAINT circle_sharing_preferences_mode_ck CHECK (((sharing_mode)::text = ANY ((ARRAY['OFF'::character varying, 'LATEST_ONLY'::character varying])::text[]))),
    CONSTRAINT circle_sharing_preferences_state_ck CHECK (((((sharing_mode)::text = 'OFF'::text) AND (enabled_since IS NULL)) OR (((sharing_mode)::text <> 'OFF'::text) AND (enabled_since IS NOT NULL) AND (enabled_since <= updated_at))))
);


--
-- Name: circles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circles (
    id uuid DEFAULT uuidv7() NOT NULL,
    kind character varying(10) NOT NULL,
    title character varying(64),
    emoji character varying(16),
    created_by_user_id uuid NOT NULL,
    direct_user_low_id uuid,
    direct_user_high_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    archived_at timestamp with time zone,
    creation_idempotency_key uuid,
    CONSTRAINT circles_dates_ck CHECK (((archived_at IS NULL) OR (archived_at >= created_at))),
    CONSTRAINT circles_group_creation_key_ck CHECK ((((kind)::text = 'GROUP'::text) OR (creation_idempotency_key IS NULL))),
    CONSTRAINT circles_kind_ck CHECK (((kind)::text = ANY ((ARRAY['DIRECT'::character varying, 'GROUP'::character varying])::text[]))),
    CONSTRAINT circles_shape_ck CHECK (((((kind)::text = 'DIRECT'::text) AND (direct_user_low_id IS NOT NULL) AND (direct_user_high_id IS NOT NULL) AND (direct_user_low_id < direct_user_high_id) AND ((created_by_user_id = direct_user_low_id) OR (created_by_user_id = direct_user_high_id)) AND (title IS NULL)) OR (((kind)::text = 'GROUP'::text) AND (direct_user_low_id IS NULL) AND (direct_user_high_id IS NULL) AND (title IS NOT NULL)))),
    CONSTRAINT circles_title_ck CHECK (((title IS NULL) OR (((char_length((title)::text) >= 1) AND (char_length((title)::text) <= 64)) AND ((title)::text = btrim((title)::text)))))
);


--
-- Name: active_recipient_sharing_paths; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.active_recipient_sharing_paths AS
 SELECT paths.actor_user_id,
    paths.recipient_user_id,
    paths.sharing_mode,
    paths.enabled_since,
    paths.updated_at,
    paths.path_since
   FROM ((( SELECT pair.actor_user_id,
            pair.recipient_user_id,
            (COALESCE(p.sharing_mode, 'OFF'::character varying))::character varying(16) AS sharing_mode,
            p.enabled_since,
            COALESCE(p.updated_at, c.created_at) AS updated_at,
            c.created_at AS path_since
           FROM ((public.circles c
             CROSS JOIN LATERAL ( VALUES (c.direct_user_low_id,c.direct_user_high_id), (c.direct_user_high_id,c.direct_user_low_id)) pair(actor_user_id, recipient_user_id))
             LEFT JOIN public.circle_sharing_preferences p ON (((p.circle_id = c.id) AND (p.user_id = pair.actor_user_id))))
          WHERE (((c.kind)::text = 'DIRECT'::text) AND (c.archived_at IS NULL))
        UNION ALL
         SELECT a_1.user_id,
            r_1.user_id,
            (COALESCE(p.sharing_mode, 'OFF'::character varying))::character varying(16) AS "coalesce",
            p.enabled_since,
            COALESCE(p.updated_at, a_1.joined_at) AS "coalesce",
            GREATEST(c.created_at, a_1.joined_at, r_1.joined_at) AS "greatest"
           FROM (((public.circles c
             JOIN public.circle_memberships a_1 ON (((a_1.circle_id = c.id) AND (a_1.left_at IS NULL))))
             JOIN public.circle_memberships r_1 ON (((r_1.circle_id = c.id) AND (r_1.left_at IS NULL) AND (r_1.user_id <> a_1.user_id) AND ((r_1.history_visibility)::text <> 'NONE'::text))))
             LEFT JOIN public.circle_sharing_preferences p ON (((p.circle_id = c.id) AND (p.user_id = a_1.user_id))))
          WHERE (((c.kind)::text = 'GROUP'::text) AND (c.archived_at IS NULL))) paths
     JOIN public.app_users a ON (((a.id = paths.actor_user_id) AND (a.deleted_at IS NULL))))
     JOIN public.app_users r ON (((r.id = paths.recipient_user_id) AND (r.deleted_at IS NULL))));


--
-- Name: admin_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_actions (
    request_id uuid NOT NULL,
    actor_user_id uuid,
    target_user_id uuid,
    actor_public_id character varying(14) NOT NULL,
    target_public_id character varying(14) NOT NULL,
    action character varying(32) NOT NULL,
    reason character varying(240) NOT NULL,
    affected_sessions integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    reward_id character varying(32),
    granted boolean,
    payload jsonb,
    changed boolean,
    CONSTRAINT admin_actions_actor_public_id_check CHECK (((actor_public_id)::text ~ '^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$'::text)),
    CONSTRAINT admin_actions_affected_sessions_check CHECK ((affected_sessions >= 0)),
    CONSTRAINT admin_actions_reason_check CHECK ((((char_length((reason)::text) >= 8) AND (char_length((reason)::text) <= 240)) AND ((reason)::text = btrim((reason)::text)) AND ((reason)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT admin_actions_reward_ck CHECK (((((action)::text = 'revoke_sessions'::text) AND ((actor_public_id)::text <> (target_public_id)::text) AND (reward_id IS NULL) AND (granted IS NULL) AND (payload IS NULL)) OR (((action)::text = 'grant_item'::text) AND (affected_sessions = 0) AND (granted IS NOT NULL) AND (reward_id IS NOT NULL) AND ((reward_id)::text = ANY ((ARRAY['flower'::character varying, 'leaf_bed'::character varying, 'keepsakes'::character varying, 'leaf_garland'::character varying])::text[])) AND (payload IS NULL)) OR (((action)::text = 'grant_achievement'::text) AND (affected_sessions = 0) AND (granted IS NOT NULL) AND (reward_id IS NOT NULL) AND ((reward_id)::text = ANY ((ARRAY['seven_day_streak'::character varying, 'thousand_taps'::character varying, 'five_friends'::character varying, 'thirty_day_streak'::character varying, 'ten_thousand_taps'::character varying, 'hundred_series'::character varying, 'ten_thousand_series'::character varying, 'linked_email'::character varying, 'saved_recovery_code'::character varying, 'full_collection'::character varying, 'first_path'::character varying, 'familiar_trails'::character varying, 'explorer'::character varying, 'master_recipes'::character varying, 'home_builder'::character varying, 'river_atlas'::character varying, 'first_sale'::character varying, 'lucky_find'::character varying])::text[])) AND (payload IS NULL)) OR (((action)::text = ANY ((ARRAY['grant_resource'::character varying, 'grant_world_item'::character varying, 'grant_find'::character varying, 'set_tag'::character varying, 'ban'::character varying, 'unban'::character varying, 'watch'::character varying, 'unwatch'::character varying, 'clear_signal'::character varying])::text[])) AND (reward_id IS NULL) AND (granted IS NULL) AND (payload IS NOT NULL) AND (jsonb_typeof(payload) = 'object'::text) AND (changed IS NOT NULL) AND (((action)::text <> ALL ((ARRAY['ban'::character varying, 'unban'::character varying])::text[])) OR ((actor_public_id)::text <> (target_public_id)::text))))),
    CONSTRAINT admin_actions_target_public_id_check CHECK (((target_public_id)::text ~ '^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$'::text))
);


--
-- Name: app_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_sessions (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    device_label character varying(120),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT app_sessions_dates_ck CHECK (((last_seen_at >= created_at) AND (expires_at > created_at) AND ((revoked_at IS NULL) OR (revoked_at >= created_at)))),
    CONSTRAINT app_sessions_token_hash_ck CHECK ((octet_length(token_hash) = 32))
);


--
-- Name: check_in_audiences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.check_in_audiences (
    check_in_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    circle_id uuid NOT NULL,
    circle_kind character varying(10) NOT NULL,
    recipient_user_id uuid NOT NULL,
    recipient_membership_id uuid,
    access_level character varying(16) DEFAULT 'LATEST_ONLY'::character varying NOT NULL,
    CONSTRAINT check_in_audiences_access_level_ck CHECK (((access_level)::text = ANY ((ARRAY['LATEST_ONLY'::character varying, 'DAILY_MARKS'::character varying, 'EXACT_TIMES'::character varying])::text[]))),
    CONSTRAINT check_in_audiences_not_self_ck CHECK ((actor_user_id <> recipient_user_id)),
    CONSTRAINT check_in_audiences_shape_ck CHECK (((((circle_kind)::text = 'GROUP'::text) AND (recipient_membership_id IS NOT NULL)) OR (((circle_kind)::text = 'DIRECT'::text) AND (recipient_membership_id IS NULL))))
);


--
-- Name: check_ins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.check_ins (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    next_allowed_at timestamp with time zone NOT NULL,
    timezone_id character varying(64) NOT NULL,
    local_date date NOT NULL,
    CONSTRAINT check_ins_cooldown_value_ck CHECK ((next_allowed_at = (checked_at + '00:00:30'::interval))),
    CONSTRAINT check_ins_local_date_value_ck CHECK ((local_date = ((checked_at AT TIME ZONE timezone_id))::date))
);


--
-- Name: circle_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.circle_invites (
    id uuid DEFAULT uuidv7() NOT NULL,
    circle_id uuid NOT NULL,
    circle_kind character varying(10) DEFAULT 'GROUP'::character varying NOT NULL,
    inviter_user_id uuid NOT NULL,
    invitee_user_id uuid,
    accepted_by_user_id uuid,
    token_hash bytea NOT NULL,
    granted_role character varying(10) DEFAULT 'MEMBER'::character varying NOT NULL,
    status character varying(10) DEFAULT 'PENDING'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    idempotency_key uuid NOT NULL,
    CONSTRAINT circle_invites_action_dates_ck CHECK ((((accepted_at IS NULL) OR (accepted_at >= created_at)) AND ((revoked_at IS NULL) OR (revoked_at >= created_at)))),
    CONSTRAINT circle_invites_expiry_ck CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '7 days'::interval)))),
    CONSTRAINT circle_invites_group_ck CHECK (((circle_kind)::text = 'GROUP'::text)),
    CONSTRAINT circle_invites_hash_ck CHECK ((octet_length(token_hash) = 32)),
    CONSTRAINT circle_invites_role_ck CHECK (((granted_role)::text = ANY ((ARRAY['ADMIN'::character varying, 'MEMBER'::character varying])::text[]))),
    CONSTRAINT circle_invites_state_ck CHECK (((((status)::text = 'PENDING'::text) AND (accepted_at IS NULL) AND (accepted_by_user_id IS NULL) AND (revoked_at IS NULL)) OR (((status)::text = 'ACCEPTED'::text) AND (accepted_at IS NOT NULL) AND (accepted_by_user_id IS NOT NULL) AND (accepted_at <= expires_at) AND (revoked_at IS NULL) AND ((invitee_user_id IS NULL) OR (accepted_by_user_id = invitee_user_id))) OR (((status)::text = 'REVOKED'::text) AND (revoked_at IS NOT NULL) AND (accepted_at IS NULL) AND (accepted_by_user_id IS NULL)))),
    CONSTRAINT circle_invites_status_ck CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'ACCEPTED'::character varying, 'REVOKED'::character varying])::text[])))
);


--
-- Name: direct_invite_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_invite_links (
    id uuid DEFAULT uuidv7() NOT NULL,
    inviter_user_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    idempotency_key uuid NOT NULL,
    status character varying(12) DEFAULT 'PENDING'::character varying NOT NULL,
    accepted_by_user_id uuid,
    accepted_idempotency_key uuid,
    result_circle_id uuid,
    result_circle_kind character varying(10),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT direct_invite_links_expiry_ck CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '7 days'::interval)))),
    CONSTRAINT direct_invite_links_hash_ck CHECK ((octet_length(token_hash) = 32)),
    CONSTRAINT direct_invite_links_state_ck CHECK (((((status)::text = 'PENDING'::text) AND (accepted_by_user_id IS NULL) AND (accepted_idempotency_key IS NULL) AND (result_circle_id IS NULL) AND (result_circle_kind IS NULL) AND (accepted_at IS NULL) AND (revoked_at IS NULL)) OR (((status)::text = 'ACCEPTED'::text) AND (accepted_by_user_id IS NOT NULL) AND (accepted_idempotency_key IS NOT NULL) AND (result_circle_id IS NOT NULL) AND ((result_circle_kind)::text = 'DIRECT'::text) AND (accepted_at IS NOT NULL) AND (accepted_at <= expires_at) AND (revoked_at IS NULL)) OR (((status)::text = ANY ((ARRAY['REVOKED'::character varying, 'EXPIRED'::character varying])::text[])) AND (accepted_by_user_id IS NULL) AND (accepted_idempotency_key IS NULL) AND (result_circle_id IS NULL) AND (result_circle_kind IS NULL) AND (accepted_at IS NULL) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT direct_invite_links_status_ck CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'ACCEPTED'::character varying, 'REVOKED'::character varying, 'EXPIRED'::character varying])::text[])))
);


--
-- Name: direct_invite_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_invite_redemptions (
    invite_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    circle_id uuid NOT NULL,
    circle_kind character varying(10) DEFAULT 'DIRECT'::character varying NOT NULL,
    accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT direct_invite_redemptions_direct_ck CHECK (((circle_kind)::text = 'DIRECT'::text))
);


--
-- Name: direct_person_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_person_favorites (
    user_id uuid NOT NULL,
    circle_id uuid NOT NULL
);


--
-- Name: direct_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.direct_requests (
    id uuid DEFAULT uuidv7() NOT NULL,
    requester_user_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    status character varying(12) DEFAULT 'PENDING'::character varying NOT NULL,
    result_circle_id uuid,
    result_circle_kind character varying(10),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    responded_at timestamp with time zone,
    idempotency_key uuid NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '7 days'::interval) NOT NULL,
    CONSTRAINT direct_requests_expiry_ck CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '30 days'::interval)))),
    CONSTRAINT direct_requests_response_dates_ck CHECK (((responded_at IS NULL) OR (responded_at >= created_at))),
    CONSTRAINT direct_requests_state_ck CHECK (((((status)::text = 'PENDING'::text) AND (responded_at IS NULL) AND (result_circle_id IS NULL) AND (result_circle_kind IS NULL)) OR (((status)::text = 'ACCEPTED'::text) AND (responded_at IS NOT NULL) AND (result_circle_id IS NOT NULL) AND ((result_circle_kind)::text = 'DIRECT'::text)) OR (((status)::text = ANY ((ARRAY['REJECTED'::character varying, 'CANCELLED'::character varying, 'EXPIRED'::character varying])::text[])) AND (responded_at IS NOT NULL) AND (result_circle_id IS NULL) AND (result_circle_kind IS NULL)))),
    CONSTRAINT direct_requests_status_ck CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'ACCEPTED'::character varying, 'REJECTED'::character varying, 'CANCELLED'::character varying, 'EXPIRED'::character varying])::text[]))),
    CONSTRAINT direct_requests_users_ck CHECK ((requester_user_id <> recipient_user_id))
);


--
-- Name: economy_barter_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_barter_offers (
    id uuid NOT NULL,
    seller_id uuid NOT NULL,
    buyer_id uuid,
    offered_item_id text NOT NULL,
    requested_item_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT economy_barter_offers_check CHECK ((offered_item_id <> requested_item_id)),
    CONSTRAINT economy_barter_offers_check1 CHECK (((buyer_id IS NULL) OR (buyer_id <> seller_id))),
    CONSTRAINT economy_barter_offers_check2 CHECK ((((status = 'active'::text) AND (closed_at IS NULL) AND (buyer_id IS NULL)) OR ((status = 'exchanged'::text) AND (closed_at IS NOT NULL)) OR ((status = 'cancelled'::text) AND (closed_at IS NOT NULL) AND (buyer_id IS NULL)))),
    CONSTRAINT economy_barter_offers_offered_item_id_check CHECK (((length(offered_item_id) >= 1) AND (length(offered_item_id) <= 80))),
    CONSTRAINT economy_barter_offers_requested_item_id_check CHECK (((length(requested_item_id) >= 1) AND (length(requested_item_id) <= 80))),
    CONSTRAINT economy_barter_offers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'exchanged'::text, 'cancelled'::text])))
);


--
-- Name: economy_barter_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_barter_receipts (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    signature text NOT NULL,
    message text NOT NULL,
    accepted_revision bigint NOT NULL,
    offer jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT economy_barter_receipts_accepted_revision_check CHECK ((accepted_revision >= 0)),
    CONSTRAINT economy_barter_receipts_offer_check CHECK ((jsonb_typeof(offer) = 'object'::text))
);


--
-- Name: economy_barter_showcases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_barter_showcases (
    user_id uuid NOT NULL,
    refresh_at timestamp with time zone NOT NULL,
    offer_ids uuid[] NOT NULL,
    CONSTRAINT economy_barter_showcases_offer_ids_check CHECK ((cardinality(offer_ids) <= 6))
);


--
-- Name: economy_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_commands (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    signature text NOT NULL,
    message text NOT NULL,
    accepted_revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: economy_conversion_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_conversion_audit (
    user_id uuid NOT NULL,
    legacy_sparks bigint NOT NULL,
    legacy_wood bigint NOT NULL,
    legacy_stone bigint NOT NULL,
    coins_granted bigint NOT NULL,
    wood_granted bigint NOT NULL,
    stone_granted bigint NOT NULL,
    converted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    currency_scale smallint DEFAULT 10 NOT NULL,
    CONSTRAINT economy_conversion_audit_coins_nominal_ck CHECK (((coins_granted >= 0) AND (coins_granted <= (500 * currency_scale)))),
    CONSTRAINT economy_conversion_audit_currency_scale_check CHECK ((currency_scale = ANY (ARRAY[1, 10]))),
    CONSTRAINT economy_conversion_audit_legacy_sparks_check CHECK ((legacy_sparks >= 0)),
    CONSTRAINT economy_conversion_audit_legacy_stone_check CHECK ((legacy_stone >= 0)),
    CONSTRAINT economy_conversion_audit_legacy_wood_check CHECK ((legacy_wood >= 0)),
    CONSTRAINT economy_conversion_audit_stone_granted_check CHECK (((stone_granted >= 0) AND (stone_granted <= 30))),
    CONSTRAINT economy_conversion_audit_wood_granted_check CHECK (((wood_granted >= 0) AND (wood_granted <= 30)))
);


--
-- Name: economy_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_ledger (
    user_id uuid NOT NULL,
    source_key text NOT NULL,
    kind text NOT NULL,
    coins bigint DEFAULT 0 NOT NULL,
    items jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    pearls bigint DEFAULT 0 NOT NULL,
    currency_scale smallint DEFAULT 10 NOT NULL,
    pearl_scale smallint DEFAULT 50 NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT economy_ledger_context_ck CHECK (((jsonb_typeof(context) = 'object'::text) AND (((context - 'targetId'::text) - 'originAction'::text) = '{}'::jsonb) AND (octet_length((context)::text) <= 512) AND ((NOT (context ? 'targetId'::text)) OR ((jsonb_typeof((context -> 'targetId'::text)) = 'string'::text) AND ((length((context ->> 'targetId'::text)) >= 1) AND (length((context ->> 'targetId'::text)) <= 80)))) AND ((NOT (context ? 'originAction'::text)) OR ((jsonb_typeof((context -> 'originAction'::text)) = 'string'::text) AND ((context ->> 'originAction'::text) = ANY (ARRAY['start_construction'::text, 'start_production'::text, 'start_exploration'::text, 'start_fishing'::text])))))),
    CONSTRAINT economy_ledger_currency_scale_check CHECK ((currency_scale = ANY (ARRAY[1, 10]))),
    CONSTRAINT economy_ledger_pearl_scale_ck CHECK ((pearl_scale = ANY (ARRAY[1, 10, 50]))),
    CONSTRAINT economy_ledger_pearls_nominal_ck CHECK (((pearls >= '-50000000000'::bigint) AND (pearls <= '50000000000'::bigint)))
);


--
-- Name: economy_market_daily_turnover; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_market_daily_turnover (
    user_id uuid NOT NULL,
    trade_day date NOT NULL,
    buys_value bigint DEFAULT 0 NOT NULL,
    sales_value bigint DEFAULT 0 NOT NULL,
    barter_used bigint DEFAULT 0 NOT NULL,
    CONSTRAINT economy_market_daily_turnover_barter_used_check CHECK (((barter_used >= 0) AND (barter_used <= '10000000000'::bigint))),
    CONSTRAINT economy_market_daily_turnover_buys_value_check CHECK (((buys_value >= 0) AND (buys_value <= '10000000000'::bigint))),
    CONSTRAINT economy_market_daily_turnover_sales_value_check CHECK (((sales_value >= 0) AND (sales_value <= '10000000000'::bigint)))
);


--
-- Name: economy_market_listings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_market_listings (
    id uuid NOT NULL,
    seller_id uuid NOT NULL,
    buyer_id uuid,
    item_id text NOT NULL,
    quantity bigint NOT NULL,
    total_price bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    closed_at timestamp with time zone,
    currency_scale smallint DEFAULT 10 NOT NULL,
    seller_fee_bps integer DEFAULT 0 NOT NULL,
    CONSTRAINT economy_market_listings_check CHECK (((buyer_id IS NULL) OR (buyer_id <> seller_id))),
    CONSTRAINT economy_market_listings_check1 CHECK ((((status = 'active'::text) AND (closed_at IS NULL) AND (buyer_id IS NULL)) OR ((status = 'sold'::text) AND (closed_at IS NOT NULL)) OR ((status = 'cancelled'::text) AND (closed_at IS NOT NULL) AND (buyer_id IS NULL)))),
    CONSTRAINT economy_market_listings_currency_scale_check CHECK ((currency_scale = ANY (ARRAY[1, 10]))),
    CONSTRAINT economy_market_listings_item_id_check CHECK (((length(item_id) >= 1) AND (length(item_id) <= 80))),
    CONSTRAINT economy_market_listings_live_nominal_ck CHECK (((status <> 'active'::text) OR ((currency_scale = 10) AND ((total_price % (10)::bigint) = 0)))),
    CONSTRAINT economy_market_listings_price_nominal_ck CHECK (((total_price >= 1) AND (total_price <= '10000000000'::bigint))),
    CONSTRAINT economy_market_listings_quantity_check CHECK (((quantity >= 1) AND (quantity <= 99))),
    CONSTRAINT economy_market_listings_seller_fee_bps_check CHECK (((seller_fee_bps >= 0) AND (seller_fee_bps <= 10000))),
    CONSTRAINT economy_market_listings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'sold'::text, 'cancelled'::text])))
);


--
-- Name: economy_market_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_market_receipts (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    signature text NOT NULL,
    message text NOT NULL,
    accepted_revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT economy_market_receipts_accepted_revision_check CHECK ((accepted_revision >= 0))
);


--
-- Name: economy_market_showcases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_market_showcases (
    user_id uuid NOT NULL,
    refresh_at timestamp with time zone NOT NULL,
    listing_ids uuid[] NOT NULL,
    CONSTRAINT economy_market_showcases_listing_ids_check CHECK ((cardinality(listing_ids) <= 12))
);


--
-- Name: economy_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economy_profiles (
    user_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    state jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT economy_profiles_currency_scale_ck CHECK ((((state ->> 'currencyScale'::text) = '10'::text) IS TRUE)),
    CONSTRAINT economy_profiles_pearl_scale_ck CHECK ((((state ->> 'pearlScale'::text) = '50'::text) IS TRUE)),
    CONSTRAINT economy_profiles_revision_check CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT economy_profiles_state_check CHECK ((((state ->> 'schemaVersion'::text) = '1'::text) IS TRUE)),
    CONSTRAINT economy_profiles_state_check4 CHECK (((jsonb_typeof((state -> 'inventory'::text)) = 'object'::text) IS TRUE)),
    CONSTRAINT economy_profiles_state_check5 CHECK (((jsonb_typeof((state -> 'buildings'::text)) = 'object'::text) IS TRUE)),
    CONSTRAINT economy_profiles_state_check6 CHECK ((((jsonb_typeof((state -> 'jobs'::text)) = 'array'::text) AND (jsonb_array_length((state -> 'jobs'::text)) <= 16)) IS TRUE)),
    CONSTRAINT economy_profiles_wallet_nominal_ck CHECK ((((jsonb_typeof((state -> 'wallet'::text)) = 'object'::text) IS TRUE) AND ((((((state -> 'wallet'::text) ->> 'coins'::text))::bigint >= 0) AND ((((state -> 'wallet'::text) ->> 'coins'::text))::bigint <= '10000000000'::bigint)) IS TRUE) AND ((((((state -> 'wallet'::text) ->> 'pearls'::text))::bigint >= 0) AND ((((state -> 'wallet'::text) ->> 'pearls'::text))::bigint <= '50000000000'::bigint)) IS TRUE)))
);


--
-- Name: forest_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forest_memory (
    user_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    snapshot jsonb,
    updated_at timestamp with time zone,
    lease_client_id uuid,
    lease_session_hash bytea,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    CONSTRAINT forest_memory_check CHECK (((snapshot IS NULL) = (updated_at IS NULL))),
    CONSTRAINT forest_memory_check1 CHECK ((((lease_client_id IS NULL) AND (lease_session_hash IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_client_id IS NOT NULL) AND (lease_session_hash IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT forest_memory_revision_check CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT forest_memory_snapshot_check CHECK (((snapshot IS NULL) OR ((jsonb_typeof(snapshot) = 'object'::text) AND (octet_length((snapshot)::text) <= 65536))))
);


--
-- Name: forest_memory_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forest_memory_receipts (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    signature bytea NOT NULL,
    session_hash bytea NOT NULL,
    accepted_revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT forest_memory_receipts_accepted_revision_check CHECK (((accepted_revision >= 0) AND (accepted_revision <= '9007199254740991'::bigint))),
    CONSTRAINT forest_memory_receipts_signature_check CHECK ((octet_length(signature) = 32))
);


--
-- Name: game_achievement_reward_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_achievement_reward_claims (
    user_id uuid NOT NULL,
    achievement_id text NOT NULL,
    level smallint NOT NULL,
    pearls bigint NOT NULL,
    claimed_at timestamp with time zone NOT NULL,
    currency_scale smallint DEFAULT 10 NOT NULL,
    pearl_scale smallint DEFAULT 50 NOT NULL,
    CONSTRAINT game_achievement_reward_claims_check CHECK ((((achievement_id = 'explorer'::text) AND (level <= 3)) OR ((achievement_id = 'home_builder'::text) AND (level <= 4)) OR ((achievement_id = 'master_recipes'::text) AND (level <= 2)) OR ((achievement_id = ANY (ARRAY['seven_day_streak'::text, 'thousand_taps'::text, 'five_friends'::text, 'ten_thousand_series'::text, 'linked_email'::text, 'saved_recovery_code'::text, 'first_path'::text, 'familiar_trails'::text, 'river_atlas'::text, 'first_sale'::text, 'lucky_find'::text])) AND (level = 1)))),
    CONSTRAINT game_achievement_reward_claims_currency_scale_check CHECK ((currency_scale = ANY (ARRAY[1, 10]))),
    CONSTRAINT game_achievement_reward_claims_level_check CHECK (((level >= 1) AND (level <= 4))),
    CONSTRAINT game_achievement_reward_claims_pearl_scale_ck CHECK ((pearl_scale = ANY (ARRAY[1, 10, 50]))),
    CONSTRAINT game_achievement_reward_claims_pearls_nominal_ck CHECK (((pearls >= 1) AND (pearls <= '50000000000'::bigint)))
);


--
-- Name: game_achievement_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_achievement_tiers (
    user_id uuid NOT NULL,
    achievement_id character varying(32) NOT NULL,
    level integer NOT NULL,
    unlocked_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    reward_eligible boolean DEFAULT true NOT NULL,
    CONSTRAINT game_achievement_tiers_level_ck CHECK (((((achievement_id)::text = ANY ((ARRAY['first_path'::character varying, 'familiar_trails'::character varying, 'river_atlas'::character varying, 'first_sale'::character varying, 'lucky_find'::character varying])::text[])) AND (level = 1)) OR (((achievement_id)::text = 'explorer'::text) AND ((level >= 1) AND (level <= 3))) OR (((achievement_id)::text = 'master_recipes'::text) AND ((level >= 1) AND (level <= 2))) OR (((achievement_id)::text = 'home_builder'::text) AND ((level >= 1) AND (level <= 4)))))
);


--
-- Name: game_achievements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_achievements (
    user_id uuid NOT NULL,
    achievement_id character varying(32) NOT NULL,
    unlocked_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    reward_eligible boolean DEFAULT true NOT NULL,
    CONSTRAINT game_achievements_id_ck CHECK (((achievement_id)::text = ANY ((ARRAY['seven_day_streak'::character varying, 'thousand_taps'::character varying, 'five_friends'::character varying, 'thirty_day_streak'::character varying, 'ten_thousand_taps'::character varying, 'hundred_series'::character varying, 'ten_thousand_series'::character varying, 'linked_email'::character varying, 'saved_recovery_code'::character varying, 'full_collection'::character varying, 'first_path'::character varying, 'familiar_trails'::character varying, 'explorer'::character varying, 'master_recipes'::character varying, 'home_builder'::character varying, 'river_atlas'::character varying, 'first_sale'::character varying, 'lucky_find'::character varying])::text[])))
);


--
-- Name: game_daily_rewards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_daily_rewards (
    user_id uuid NOT NULL,
    next_step smallint DEFAULT 1 NOT NULL,
    last_claim_at timestamp with time zone,
    last_claim_date date,
    CONSTRAINT game_daily_rewards_check CHECK (((last_claim_at IS NULL) = (last_claim_date IS NULL))),
    CONSTRAINT game_daily_rewards_check1 CHECK (((last_claim_at IS NULL) OR (last_claim_date = ((last_claim_at AT TIME ZONE 'UTC'::text))::date))),
    CONSTRAINT game_daily_rewards_next_step_check CHECK (((next_step >= 1) AND (next_step <= 7)))
);


--
-- Name: game_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_items (
    user_id uuid NOT NULL,
    item_id character varying(32) NOT NULL,
    unlocked_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT game_items_item_id_check CHECK (((item_id)::text = ANY ((ARRAY['flower'::character varying, 'leaf_bed'::character varying, 'keepsakes'::character varying, 'leaf_garland'::character varying])::text[])))
);


--
-- Name: game_monthly_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_monthly_scores (
    user_id uuid NOT NULL,
    month date NOT NULL,
    taps bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT game_monthly_scores_month_check CHECK ((EXTRACT(day FROM month) = (1)::numeric)),
    CONSTRAINT game_monthly_scores_taps_check CHECK (((taps >= 0) AND (taps <= '9007199254740991'::bigint)))
);


--
-- Name: game_presence_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_presence_accounts (
    user_id uuid NOT NULL,
    credited_until timestamp with time zone NOT NULL,
    credited_spans tstzmultirange DEFAULT '{}'::tstzmultirange NOT NULL
);


--
-- Name: game_presence_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_presence_clients (
    presence_id uuid NOT NULL,
    user_id uuid NOT NULL,
    auth_session_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    last_active_at timestamp with time zone NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    sequence bigint DEFAULT 0 NOT NULL,
    last_kind character varying(16) DEFAULT 'resume'::character varying NOT NULL,
    last_active boolean DEFAULT true NOT NULL,
    CONSTRAINT game_presence_clients_check CHECK (((last_seen_at >= created_at) AND ((last_active_at >= created_at) AND (last_active_at <= last_seen_at)))),
    CONSTRAINT game_presence_clients_last_kind_check CHECK (((last_kind)::text = ANY ((ARRAY['resume'::character varying, 'heartbeat'::character varying, 'suspend'::character varying])::text[]))),
    CONSTRAINT game_presence_clients_sequence_check CHECK (((sequence >= 0) AND (sequence <= '9007199254740990'::bigint))),
    CONSTRAINT game_presence_clients_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'idle'::character varying, 'disconnected'::character varying, 'suspended'::character varying])::text[])))
);


--
-- Name: game_presence_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_presence_daily (
    user_id uuid NOT NULL,
    day date NOT NULL,
    online_millis bigint DEFAULT 0 NOT NULL,
    flagged_at timestamp with time zone,
    CONSTRAINT game_presence_daily_check CHECK (((flagged_at IS NULL) OR (online_millis > 72000000))),
    CONSTRAINT game_presence_daily_online_millis_check CHECK (((online_millis >= 0) AND (online_millis <= 86400000)))
);


--
-- Name: game_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_profiles (
    user_id uuid NOT NULL,
    lifetime_taps bigint DEFAULT 0 NOT NULL,
    best_series bigint DEFAULT 0 NOT NULL,
    leaderboard_opt_in boolean DEFAULT false NOT NULL,
    visibility_version bigint DEFAULT 0 NOT NULL,
    bucket_tokens double precision DEFAULT 60 NOT NULL,
    bucket_updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    writer_session_id uuid,
    writer_until timestamp with time zone,
    CONSTRAINT game_profiles_bucket_tokens_check CHECK (((bucket_tokens >= (0)::double precision) AND (bucket_tokens <= (60)::double precision))),
    CONSTRAINT game_profiles_check CHECK (((best_series >= 0) AND (best_series <= lifetime_taps))),
    CONSTRAINT game_profiles_lifetime_taps_check CHECK (((lifetime_taps >= 0) AND (lifetime_taps <= '9007199254740991'::bigint))),
    CONSTRAINT game_profiles_visibility_version_check CHECK (((visibility_version >= 0) AND (visibility_version <= '9007199254740991'::bigint)))
);


--
-- Name: game_reward_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_reward_claims (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    origin_user_id uuid NOT NULL,
    signature text NOT NULL,
    kind text NOT NULL,
    daily_date date,
    claim jsonb NOT NULL,
    accepted_revision bigint NOT NULL,
    claimed_at timestamp with time zone NOT NULL,
    currency_scale smallint DEFAULT 10 NOT NULL,
    pearl_scale smallint DEFAULT 50 NOT NULL,
    CONSTRAINT game_reward_claims_accepted_revision_check CHECK (((accepted_revision >= 0) AND (accepted_revision <= '9007199254740991'::bigint))),
    CONSTRAINT game_reward_claims_check CHECK (((kind = 'daily'::text) = (daily_date IS NOT NULL))),
    CONSTRAINT game_reward_claims_check1 CHECK (((daily_date IS NULL) OR (daily_date = ((claimed_at AT TIME ZONE 'UTC'::text))::date))),
    CONSTRAINT game_reward_claims_claim_check CHECK ((jsonb_typeof(claim) = 'object'::text)),
    CONSTRAINT game_reward_claims_currency_scale_check CHECK ((currency_scale = ANY (ARRAY[1, 10]))),
    CONSTRAINT game_reward_claims_kind_check CHECK ((kind = ANY (ARRAY['daily'::text, 'achievement'::text]))),
    CONSTRAINT game_reward_claims_pearl_scale_ck CHECK ((pearl_scale = ANY (ARRAY[1, 10, 50])))
);


--
-- Name: game_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_sessions (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    auth_session_id uuid NOT NULL,
    request_id uuid NOT NULL,
    month date NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_sequence bigint DEFAULT 0 NOT NULL,
    last_tap_count integer DEFAULT 0 NOT NULL,
    last_accepted integer DEFAULT 0 NOT NULL,
    last_run_id uuid,
    last_batch_at timestamp with time zone,
    run_id uuid,
    run_updated_at timestamp with time zone,
    continuation_claimed boolean DEFAULT false NOT NULL,
    run_taps bigint DEFAULT 0 NOT NULL,
    closed_at timestamp with time zone,
    last_tap_times bigint[],
    last_rejection_code character varying(64),
    event_tokens double precision DEFAULT 60 NOT NULL,
    event_updated_at timestamp with time zone,
    CONSTRAINT game_delivery_time CHECK (((last_batch_at IS NULL) OR ((last_batch_at >= created_at) AND (last_batch_at <= (expires_at + '2 days'::interval))))),
    CONSTRAINT game_sessions_check CHECK (((last_accepted >= 0) AND (last_accepted <= last_tap_count))),
    CONSTRAINT game_sessions_check1 CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:15:00'::interval)))),
    CONSTRAINT game_sessions_check2 CHECK ((expires_at <= ((month + '1 mon'::interval) AT TIME ZONE 'UTC'::text))),
    CONSTRAINT game_sessions_check3 CHECK ((month = (date_trunc('month'::text, (created_at AT TIME ZONE 'UTC'::text)))::date)),
    CONSTRAINT game_sessions_check4 CHECK ((((last_sequence = 0) AND (last_run_id IS NULL) AND (last_batch_at IS NULL) AND (last_tap_count = 0) AND (run_taps = 0)) OR ((last_sequence > 0) AND (last_run_id IS NOT NULL) AND (last_batch_at IS NOT NULL) AND (last_tap_count > 0)))),
    CONSTRAINT game_sessions_check6 CHECK ((((run_taps = 0) AND (run_id IS NULL) AND (run_updated_at IS NULL)) OR ((run_taps > 0) AND (run_id IS NOT NULL) AND (run_updated_at IS NOT NULL)))),
    CONSTRAINT game_sessions_check7 CHECK (((run_updated_at IS NULL) OR ((run_updated_at >= created_at) AND (run_updated_at < expires_at)))),
    CONSTRAINT game_sessions_event_tokens_check CHECK (((event_tokens >= (0)::double precision) AND (event_tokens <= (60)::double precision))),
    CONSTRAINT game_sessions_last_sequence_check CHECK (((last_sequence >= 0) AND (last_sequence <= '9007199254740990'::bigint))),
    CONSTRAINT game_sessions_last_tap_count_check CHECK (((last_tap_count >= 0) AND (last_tap_count <= 60))),
    CONSTRAINT game_sessions_month_check CHECK ((EXTRACT(day FROM month) = (1)::numeric)),
    CONSTRAINT game_sessions_run_taps_check CHECK (((run_taps >= 0) AND (run_taps <= '9007199254740991'::bigint)))
);


--
-- Name: game_tap_activity_minutes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_tap_activity_minutes (
    user_id uuid NOT NULL,
    bucket_at timestamp with time zone NOT NULL,
    received_taps bigint DEFAULT 0 NOT NULL,
    rejected_taps bigint DEFAULT 0 NOT NULL,
    event_taps bigint DEFAULT 0 NOT NULL,
    delayed_taps bigint DEFAULT 0 NOT NULL,
    legacy_taps bigint DEFAULT 0 NOT NULL,
    interval_count bigint DEFAULT 0 NOT NULL,
    interval_sum_ms double precision DEFAULT 0 NOT NULL,
    interval_squared_sum_ms double precision DEFAULT 0 NOT NULL,
    review_signal boolean DEFAULT false NOT NULL,
    watchlisted boolean DEFAULT false NOT NULL,
    CONSTRAINT game_tap_activity_minutes_delayed_taps_check CHECK ((delayed_taps >= 0)),
    CONSTRAINT game_tap_activity_minutes_event_taps_check CHECK ((event_taps >= 0)),
    CONSTRAINT game_tap_activity_minutes_interval_count_check CHECK ((interval_count >= 0)),
    CONSTRAINT game_tap_activity_minutes_legacy_taps_check CHECK ((legacy_taps >= 0)),
    CONSTRAINT game_tap_activity_minutes_received_taps_check CHECK ((received_taps >= 0)),
    CONSTRAINT game_tap_activity_minutes_rejected_taps_check CHECK ((rejected_taps >= 0))
);


--
-- Name: game_tap_activity_seconds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_tap_activity_seconds (
    user_id uuid NOT NULL,
    bucket_at timestamp with time zone NOT NULL,
    received_taps bigint DEFAULT 0 NOT NULL,
    rejected_taps bigint DEFAULT 0 NOT NULL,
    event_taps bigint DEFAULT 0 NOT NULL,
    delayed_taps bigint DEFAULT 0 NOT NULL,
    legacy_taps bigint DEFAULT 0 NOT NULL,
    interval_count bigint DEFAULT 0 NOT NULL,
    interval_sum_ms double precision DEFAULT 0 NOT NULL,
    interval_squared_sum_ms double precision DEFAULT 0 NOT NULL,
    CONSTRAINT game_tap_activity_seconds_delayed_taps_check CHECK ((delayed_taps >= 0)),
    CONSTRAINT game_tap_activity_seconds_event_taps_check CHECK ((event_taps >= 0)),
    CONSTRAINT game_tap_activity_seconds_interval_count_check CHECK ((interval_count >= 0)),
    CONSTRAINT game_tap_activity_seconds_legacy_taps_check CHECK ((legacy_taps >= 0)),
    CONSTRAINT game_tap_activity_seconds_received_taps_check CHECK ((received_taps >= 0)),
    CONSTRAINT game_tap_activity_seconds_rejected_taps_check CHECK ((rejected_taps >= 0))
);


--
-- Name: game_tap_collection_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_tap_collection_metadata (
    singleton boolean DEFAULT true NOT NULL,
    started_at timestamp with time zone NOT NULL,
    CONSTRAINT game_tap_collection_metadata_singleton_check CHECK (singleton)
);


--
-- Name: identity_bootstrap_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_bootstrap_keys (
    id uuid DEFAULT uuidv7() NOT NULL,
    idempotency_hash bytea NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT identity_bootstrap_expiry_ck CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:15:00'::interval)))),
    CONSTRAINT identity_bootstrap_hash_ck CHECK ((octet_length(idempotency_hash) = 32))
);


--
-- Name: notification_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_batches (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    reserved_at timestamp with time zone NOT NULL,
    state character varying(16) NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT notification_batches_state_check CHECK (((state)::text = ANY ((ARRAY['sending'::character varying, 'delivered'::character varying, 'dismissed'::character varying, 'failed'::character varying, 'uncertain'::character varying])::text[])))
);


--
-- Name: notification_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_events (
    user_id uuid NOT NULL,
    source_key text NOT NULL,
    category character varying(16) NOT NULL,
    due_at timestamp with time zone NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    state character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    batch_id uuid,
    CONSTRAINT notification_events_attempts_check CHECK (((attempts >= 0) AND (attempts <= 3))),
    CONSTRAINT notification_events_category_check CHECK (((category)::text = ANY ((ARRAY['construction'::character varying, 'exploration'::character varying, 'production'::character varying, 'checkin'::character varying])::text[]))),
    CONSTRAINT notification_events_state_check CHECK (((state)::text = ANY ((ARRAY['pending'::character varying, 'sending'::character varying, 'delivered'::character varying, 'dismissed'::character varying, 'uncertain'::character varying])::text[])))
);


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    user_id uuid NOT NULL,
    preferences jsonb NOT NULL,
    last_visible_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: notification_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_subscriptions (
    endpoint_hash bytea NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh character varying(100) NOT NULL,
    auth character varying(40) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT notification_subscriptions_endpoint_check CHECK (((length(endpoint) >= 20) AND (length(endpoint) <= 2048))),
    CONSTRAINT notification_subscriptions_endpoint_hash_check CHECK ((octet_length(endpoint_hash) = 32))
);


--
-- Name: player_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.player_feedback (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    client_request_id uuid NOT NULL,
    category character varying(16) NOT NULL,
    message text NOT NULL,
    status character varying(16) DEFAULT 'new'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT player_feedback_category_check CHECK (((category)::text = ANY ((ARRAY['bug'::character varying, 'suggestion'::character varying, 'other'::character varying])::text[]))),
    CONSTRAINT player_feedback_message_check CHECK (((char_length(message) >= 10) AND (char_length(message) <= 3000))),
    CONSTRAINT player_feedback_status_check CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'reviewed'::character varying, 'resolved'::character varying])::text[])))
);


--
-- Name: player_feedback_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.player_feedback_actions (
    request_id uuid NOT NULL,
    feedback_id uuid NOT NULL,
    actor_user_id uuid,
    status character varying(16) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT player_feedback_actions_status_check CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'reviewed'::character varying, 'resolved'::character varying])::text[])))
);


--
-- Name: private_person_nicknames; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_person_nicknames (
    viewer_user_id uuid NOT NULL,
    subject_user_id uuid NOT NULL,
    nickname character varying(50) NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT private_person_nicknames_check CHECK ((viewer_user_id <> subject_user_id)),
    CONSTRAINT private_person_nicknames_nickname_check CHECK (((char_length(btrim((nickname)::text)) >= 1) AND (char_length(btrim((nickname)::text)) <= 50)))
);


--
-- Name: promo_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_redemptions (
    user_id uuid NOT NULL,
    origin_user_id uuid NOT NULL,
    promo_id text NOT NULL,
    request_id uuid NOT NULL,
    title text NOT NULL,
    reward jsonb NOT NULL,
    accepted_revision bigint NOT NULL,
    claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT promo_redemptions_accepted_revision_check CHECK (((accepted_revision >= 1) AND (accepted_revision <= '9007199254740991'::bigint))),
    CONSTRAINT promo_redemptions_promo_id_check CHECK (((length(promo_id) >= 3) AND (length(promo_id) <= 64)))
);


--
-- Name: recipient_sharing_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipient_sharing_preferences (
    actor_user_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    sharing_mode character varying(16) NOT NULL,
    enabled_since timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT recipient_sharing_preferences_check CHECK ((actor_user_id <> recipient_user_id)),
    CONSTRAINT recipient_sharing_preferences_check1 CHECK (((((sharing_mode)::text = 'OFF'::text) AND (enabled_since IS NULL)) OR (((sharing_mode)::text = 'LATEST_ONLY'::text) AND (enabled_since IS NOT NULL) AND (enabled_since <= updated_at)))),
    CONSTRAINT recipient_sharing_preferences_check2 CHECK ((created_at <= updated_at)),
    CONSTRAINT recipient_sharing_preferences_sharing_mode_check CHECK (((sharing_mode)::text = ANY ((ARRAY['OFF'::character varying, 'LATEST_ONLY'::character varying])::text[])))
);


--
-- Name: user_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_incidents (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    event_id uuid NOT NULL,
    source text NOT NULL,
    operation character varying(100) NOT NULL,
    code character varying(64) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    request_id uuid,
    http_status integer,
    pending_taps integer DEFAULT 0 NOT NULL,
    occurrences integer DEFAULT 1 NOT NULL,
    CONSTRAINT user_incidents_http_status_check CHECK (((http_status >= 100) AND (http_status <= 599))),
    CONSTRAINT user_incidents_occurrences_check CHECK (((occurrences >= 1) AND (occurrences <= 100000))),
    CONSTRAINT user_incidents_pending_taps_check CHECK (((pending_taps >= 0) AND (pending_taps <= 100000))),
    CONSTRAINT user_incidents_source_check CHECK ((source = ANY (ARRAY['client'::text, 'server'::text])))
);


--
-- Name: user_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_incidents ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.user_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_status_write_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_status_write_keys (
    user_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    status_text character varying(120) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_in_minutes integer,
    CONSTRAINT user_status_duration CHECK (((expires_in_minutes IS NULL) OR (((status_text)::text <> ''::text) AND (expires_in_minutes = ANY (ARRAY[60, 120, 240, 480, 1440])))))
);


--
-- Name: user_timezone_write_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_timezone_write_keys (
    user_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    timezone_id character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: world_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_commands (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    signature text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: world_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_ledger (
    user_id uuid NOT NULL,
    source_key text NOT NULL,
    kind text NOT NULL,
    sparks bigint DEFAULT 0 NOT NULL,
    wood bigint DEFAULT 0 NOT NULL,
    stone bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: world_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_profiles (
    user_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    state jsonb NOT NULL,
    tap_day date DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text))::date NOT NULL,
    tap_sparks integer DEFAULT 0 NOT NULL,
    tap_remainder integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT world_profiles_revision_check CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT world_profiles_state_check CHECK ((((jsonb_typeof(state) = 'object'::text) AND ((state ->> 'schemaVersion'::text) = '1'::text)) IS TRUE)),
    CONSTRAINT world_profiles_state_check1 CHECK ((((jsonb_typeof(((state -> 'resources'::text) -> 'sparks'::text)) = 'number'::text) AND (((((state -> 'resources'::text) ->> 'sparks'::text))::bigint >= 0) AND ((((state -> 'resources'::text) ->> 'sparks'::text))::bigint <= '9007199254740991'::bigint))) IS TRUE)),
    CONSTRAINT world_profiles_state_check2 CHECK ((((jsonb_typeof(((state -> 'resources'::text) -> 'wood'::text)) = 'number'::text) AND (((((state -> 'resources'::text) ->> 'wood'::text))::bigint >= 0) AND ((((state -> 'resources'::text) ->> 'wood'::text))::bigint <= '9007199254740991'::bigint))) IS TRUE)),
    CONSTRAINT world_profiles_state_check3 CHECK ((((jsonb_typeof(((state -> 'resources'::text) -> 'stone'::text)) = 'number'::text) AND (((((state -> 'resources'::text) ->> 'stone'::text))::bigint >= 0) AND ((((state -> 'resources'::text) ->> 'stone'::text))::bigint <= '9007199254740991'::bigint))) IS TRUE)),
    CONSTRAINT world_profiles_tap_remainder_check CHECK (((tap_remainder >= 0) AND (tap_remainder <= 4))),
    CONSTRAINT world_profiles_tap_sparks_check CHECK (((tap_sparks >= 0) AND (tap_sparks <= 60)))
);


--
-- Name: account_action_proofs account_action_proofs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_action_proofs
    ADD CONSTRAINT account_action_proofs_pkey PRIMARY KEY (flow_hash);


--
-- Name: account_group_owner_transfers account_group_owner_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_group_owner_transfers
    ADD CONSTRAINT account_group_owner_transfers_pkey PRIMARY KEY (circle_id);


--
-- Name: account_identity_retirements account_identity_retirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_identity_retirements
    ADD CONSTRAINT account_identity_retirements_pkey PRIMARY KEY (provider, subject_hash);


--
-- Name: account_login_flows account_login_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_login_flows
    ADD CONSTRAINT account_login_flows_pkey PRIMARY KEY (token_hash);


--
-- Name: account_login_identities account_login_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_login_identities
    ADD CONSTRAINT account_login_identities_pkey PRIMARY KEY (provider, subject);


--
-- Name: account_login_identities account_login_identities_user_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_login_identities
    ADD CONSTRAINT account_login_identities_user_id_provider_key UNIQUE (user_id, provider);


--
-- Name: account_merge_previews account_merge_previews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_merge_previews
    ADD CONSTRAINT account_merge_previews_pkey PRIMARY KEY (token_hash);


--
-- Name: account_merge_sources account_merge_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_merge_sources
    ADD CONSTRAINT account_merge_sources_pkey PRIMARY KEY (source_user_id);


--
-- Name: account_operation_receipts account_operation_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_operation_receipts
    ADD CONSTRAINT account_operation_receipts_pkey PRIMARY KEY (token_hash);


--
-- Name: account_recovery_attempts account_recovery_attempts_approval_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_approval_idempotency_uq UNIQUE (approved_by_user_id, approval_idempotency_key);


--
-- Name: account_recovery_attempts account_recovery_attempts_approval_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_approval_token_hash_key UNIQUE (approval_token_hash);


--
-- Name: account_recovery_attempts account_recovery_attempts_claim_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_claim_token_hash_key UNIQUE (claim_token_hash);


--
-- Name: account_recovery_attempts account_recovery_attempts_completed_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_completed_session_id_key UNIQUE (completed_session_id);


--
-- Name: account_recovery_attempts account_recovery_attempts_creation_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_creation_idempotency_key_key UNIQUE (creation_idempotency_key);


--
-- Name: account_recovery_attempts account_recovery_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_pkey PRIMARY KEY (id);


--
-- Name: account_recovery_codes account_recovery_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_codes
    ADD CONSTRAINT account_recovery_codes_pkey PRIMARY KEY (code_hash);


--
-- Name: account_recovery_contact_removals account_recovery_contact_removals_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contact_removals
    ADD CONSTRAINT account_recovery_contact_removals_pk PRIMARY KEY (owner_user_id, idempotency_key);


--
-- Name: account_recovery_contacts account_recovery_contacts_id_owner_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contacts
    ADD CONSTRAINT account_recovery_contacts_id_owner_uq UNIQUE (id, owner_user_id);


--
-- Name: account_recovery_contacts account_recovery_contacts_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contacts
    ADD CONSTRAINT account_recovery_contacts_idempotency_uq UNIQUE (owner_user_id, idempotency_key);


--
-- Name: account_recovery_contacts account_recovery_contacts_identity_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contacts
    ADD CONSTRAINT account_recovery_contacts_identity_uq UNIQUE (id, owner_user_id, trustee_user_id);


--
-- Name: account_recovery_contacts account_recovery_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contacts
    ADD CONSTRAINT account_recovery_contacts_pkey PRIMARY KEY (id);


--
-- Name: account_registration_tickets account_registration_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_registration_tickets
    ADD CONSTRAINT account_registration_tickets_pkey PRIMARY KEY (token_hash);


--
-- Name: admin_actions admin_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_pkey PRIMARY KEY (request_id);


--
-- Name: app_sessions app_sessions_id_user_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_id_user_uq UNIQUE (id, user_id);


--
-- Name: app_sessions app_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_pkey PRIMARY KEY (id);


--
-- Name: app_sessions app_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_public_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_public_id_key UNIQUE (public_id);


--
-- Name: check_in_audiences check_in_audiences_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_in_audiences
    ADD CONSTRAINT check_in_audiences_pk PRIMARY KEY (check_in_id, circle_id, recipient_user_id);


--
-- Name: check_ins check_ins_cooldown_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins
    ADD CONSTRAINT check_ins_cooldown_excl EXCLUDE USING gist (user_id WITH =, tstzrange(checked_at, next_allowed_at, '[)'::text) WITH &&);


--
-- Name: check_ins check_ins_id_user_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins
    ADD CONSTRAINT check_ins_id_user_uq UNIQUE (id, user_id);


--
-- Name: check_ins check_ins_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins
    ADD CONSTRAINT check_ins_idempotency_uq UNIQUE (user_id, idempotency_key);


--
-- Name: check_ins check_ins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins
    ADD CONSTRAINT check_ins_pkey PRIMARY KEY (id);


--
-- Name: circle_invites circle_invites_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_idempotency_uq UNIQUE (inviter_user_id, idempotency_key);


--
-- Name: circle_invites circle_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_pkey PRIMARY KEY (id);


--
-- Name: circle_invites circle_invites_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_token_hash_key UNIQUE (token_hash);


--
-- Name: circle_memberships circle_memberships_period_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_memberships
    ADD CONSTRAINT circle_memberships_period_excl EXCLUDE USING gist (circle_id WITH =, user_id WITH =, tstzrange(joined_at, left_at, '[)'::text) WITH &&);


--
-- Name: circle_memberships circle_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_memberships
    ADD CONSTRAINT circle_memberships_pkey PRIMARY KEY (id);


--
-- Name: circle_memberships circle_memberships_snapshot_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_memberships
    ADD CONSTRAINT circle_memberships_snapshot_uq UNIQUE (id, circle_id, user_id);


--
-- Name: circle_sharing_preferences circle_sharing_preferences_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_sharing_preferences
    ADD CONSTRAINT circle_sharing_preferences_pk PRIMARY KEY (circle_id, user_id);


--
-- Name: circles circles_direct_period_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circles
    ADD CONSTRAINT circles_direct_period_excl EXCLUDE USING gist (direct_user_low_id WITH =, direct_user_high_id WITH =, tstzrange(created_at, archived_at, '[)'::text) WITH &&) WHERE (((kind)::text = 'DIRECT'::text));


--
-- Name: circles circles_id_kind_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circles
    ADD CONSTRAINT circles_id_kind_uq UNIQUE (id, kind);


--
-- Name: circles circles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circles
    ADD CONSTRAINT circles_pkey PRIMARY KEY (id);


--
-- Name: direct_invite_links direct_invite_links_accept_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_links
    ADD CONSTRAINT direct_invite_links_accept_idempotency_uq UNIQUE (accepted_by_user_id, accepted_idempotency_key);


--
-- Name: direct_invite_links direct_invite_links_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_links
    ADD CONSTRAINT direct_invite_links_idempotency_uq UNIQUE (inviter_user_id, idempotency_key);


--
-- Name: direct_invite_links direct_invite_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_links
    ADD CONSTRAINT direct_invite_links_pkey PRIMARY KEY (id);


--
-- Name: direct_invite_links direct_invite_links_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_links
    ADD CONSTRAINT direct_invite_links_token_hash_key UNIQUE (token_hash);


--
-- Name: direct_invite_redemptions direct_invite_redemptions_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_redemptions
    ADD CONSTRAINT direct_invite_redemptions_idempotency_uq UNIQUE (recipient_user_id, idempotency_key);


--
-- Name: direct_invite_redemptions direct_invite_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_redemptions
    ADD CONSTRAINT direct_invite_redemptions_pkey PRIMARY KEY (invite_id, recipient_user_id);


--
-- Name: direct_person_favorites direct_person_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_person_favorites
    ADD CONSTRAINT direct_person_favorites_pkey PRIMARY KEY (user_id, circle_id);


--
-- Name: direct_requests direct_requests_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_requests
    ADD CONSTRAINT direct_requests_idempotency_uq UNIQUE (requester_user_id, idempotency_key);


--
-- Name: direct_requests direct_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_requests
    ADD CONSTRAINT direct_requests_pkey PRIMARY KEY (id);


--
-- Name: economy_barter_offers economy_barter_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_barter_offers
    ADD CONSTRAINT economy_barter_offers_pkey PRIMARY KEY (id);


--
-- Name: economy_barter_receipts economy_barter_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_barter_receipts
    ADD CONSTRAINT economy_barter_receipts_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: economy_barter_showcases economy_barter_showcases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_barter_showcases
    ADD CONSTRAINT economy_barter_showcases_pkey PRIMARY KEY (user_id);


--
-- Name: economy_commands economy_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_commands
    ADD CONSTRAINT economy_commands_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: economy_conversion_audit economy_conversion_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_conversion_audit
    ADD CONSTRAINT economy_conversion_audit_pkey PRIMARY KEY (user_id);


--
-- Name: economy_ledger economy_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_ledger
    ADD CONSTRAINT economy_ledger_pkey PRIMARY KEY (user_id, source_key);


--
-- Name: economy_market_daily_turnover economy_market_daily_turnover_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_market_daily_turnover
    ADD CONSTRAINT economy_market_daily_turnover_pkey PRIMARY KEY (user_id, trade_day);


--
-- Name: economy_market_listings economy_market_listings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_market_listings
    ADD CONSTRAINT economy_market_listings_pkey PRIMARY KEY (id);


--
-- Name: economy_market_receipts economy_market_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_market_receipts
    ADD CONSTRAINT economy_market_receipts_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: economy_market_showcases economy_market_showcases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_market_showcases
    ADD CONSTRAINT economy_market_showcases_pkey PRIMARY KEY (user_id);


--
-- Name: economy_profiles economy_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_profiles
    ADD CONSTRAINT economy_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: forest_memory forest_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forest_memory
    ADD CONSTRAINT forest_memory_pkey PRIMARY KEY (user_id);


--
-- Name: forest_memory_receipts forest_memory_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forest_memory_receipts
    ADD CONSTRAINT forest_memory_receipts_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: game_achievement_reward_claims game_achievement_reward_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_achievement_reward_claims
    ADD CONSTRAINT game_achievement_reward_claims_pkey PRIMARY KEY (user_id, achievement_id, level);


--
-- Name: game_achievement_tiers game_achievement_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_achievement_tiers
    ADD CONSTRAINT game_achievement_tiers_pkey PRIMARY KEY (user_id, achievement_id, level);


--
-- Name: game_achievements game_achievements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_achievements
    ADD CONSTRAINT game_achievements_pkey PRIMARY KEY (user_id, achievement_id);


--
-- Name: game_daily_rewards game_daily_rewards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_daily_rewards
    ADD CONSTRAINT game_daily_rewards_pkey PRIMARY KEY (user_id);


--
-- Name: game_items game_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_items
    ADD CONSTRAINT game_items_pkey PRIMARY KEY (user_id, item_id);


--
-- Name: game_monthly_scores game_monthly_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_monthly_scores
    ADD CONSTRAINT game_monthly_scores_pkey PRIMARY KEY (user_id, month);


--
-- Name: game_presence_accounts game_presence_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_presence_accounts
    ADD CONSTRAINT game_presence_accounts_pkey PRIMARY KEY (user_id);


--
-- Name: game_presence_clients game_presence_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_presence_clients
    ADD CONSTRAINT game_presence_clients_pkey PRIMARY KEY (presence_id);


--
-- Name: game_presence_daily game_presence_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_presence_daily
    ADD CONSTRAINT game_presence_daily_pkey PRIMARY KEY (user_id, day);


--
-- Name: game_profiles game_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_profiles
    ADD CONSTRAINT game_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: game_reward_claims game_reward_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_reward_claims
    ADD CONSTRAINT game_reward_claims_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: game_sessions game_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_sessions
    ADD CONSTRAINT game_sessions_pkey PRIMARY KEY (id);


--
-- Name: game_sessions game_sessions_user_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_sessions
    ADD CONSTRAINT game_sessions_user_id_request_id_key UNIQUE (user_id, request_id);


--
-- Name: game_tap_activity_minutes game_tap_activity_minutes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_tap_activity_minutes
    ADD CONSTRAINT game_tap_activity_minutes_pkey PRIMARY KEY (user_id, bucket_at);


--
-- Name: game_tap_activity_seconds game_tap_activity_seconds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_tap_activity_seconds
    ADD CONSTRAINT game_tap_activity_seconds_pkey PRIMARY KEY (user_id, bucket_at);


--
-- Name: game_tap_collection_metadata game_tap_collection_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_tap_collection_metadata
    ADD CONSTRAINT game_tap_collection_metadata_pkey PRIMARY KEY (singleton);


--
-- Name: identity_bootstrap_keys identity_bootstrap_keys_idempotency_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_bootstrap_keys
    ADD CONSTRAINT identity_bootstrap_keys_idempotency_hash_key UNIQUE (idempotency_hash);


--
-- Name: identity_bootstrap_keys identity_bootstrap_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_bootstrap_keys
    ADD CONSTRAINT identity_bootstrap_keys_pkey PRIMARY KEY (id);


--
-- Name: identity_bootstrap_keys identity_bootstrap_keys_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_bootstrap_keys
    ADD CONSTRAINT identity_bootstrap_keys_session_id_key UNIQUE (session_id);


--
-- Name: notification_batches notification_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_batches
    ADD CONSTRAINT notification_batches_pkey PRIMARY KEY (id);


--
-- Name: notification_events notification_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_pkey PRIMARY KEY (user_id, source_key);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: notification_subscriptions notification_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_subscriptions
    ADD CONSTRAINT notification_subscriptions_pkey PRIMARY KEY (endpoint_hash);


--
-- Name: player_feedback_actions player_feedback_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_feedback_actions
    ADD CONSTRAINT player_feedback_actions_pkey PRIMARY KEY (request_id);


--
-- Name: player_feedback player_feedback_client_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_feedback
    ADD CONSTRAINT player_feedback_client_request_id_key UNIQUE (client_request_id);


--
-- Name: player_feedback player_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_feedback
    ADD CONSTRAINT player_feedback_pkey PRIMARY KEY (id);


--
-- Name: private_person_nicknames private_person_nicknames_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_person_nicknames
    ADD CONSTRAINT private_person_nicknames_pkey PRIMARY KEY (viewer_user_id, subject_user_id);


--
-- Name: promo_redemptions promo_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_pkey PRIMARY KEY (user_id, promo_id);


--
-- Name: recipient_sharing_preferences recipient_sharing_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_sharing_preferences
    ADD CONSTRAINT recipient_sharing_preferences_pkey PRIMARY KEY (actor_user_id, recipient_user_id);


--
-- Name: user_incidents user_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_incidents
    ADD CONSTRAINT user_incidents_pkey PRIMARY KEY (id);


--
-- Name: user_incidents user_incidents_user_id_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_incidents
    ADD CONSTRAINT user_incidents_user_id_event_id_key UNIQUE (user_id, event_id);


--
-- Name: user_status_write_keys user_status_write_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_status_write_keys
    ADD CONSTRAINT user_status_write_keys_pkey PRIMARY KEY (user_id, idempotency_key);


--
-- Name: user_timezone_write_keys user_timezone_write_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_timezone_write_keys
    ADD CONSTRAINT user_timezone_write_keys_pkey PRIMARY KEY (user_id, idempotency_key);


--
-- Name: world_commands world_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_commands
    ADD CONSTRAINT world_commands_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: world_ledger world_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_ledger
    ADD CONSTRAINT world_ledger_pkey PRIMARY KEY (user_id, source_key);


--
-- Name: world_profiles world_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_profiles
    ADD CONSTRAINT world_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: account_action_proofs_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_action_proofs_session_idx ON public.account_action_proofs USING btree (session_hash, action, role);


--
-- Name: account_identity_retirements_merged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_identity_retirements_merged_idx ON public.account_identity_retirements USING btree (merged_into_user_id) WHERE (merged_into_user_id IS NOT NULL);


--
-- Name: account_login_flows_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_login_flows_email_idx ON public.account_login_flows USING btree (subject, created_at) WHERE ((provider)::text = 'email'::text);


--
-- Name: account_login_flows_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_login_flows_expiry_idx ON public.account_login_flows USING btree (expires_at);


--
-- Name: account_merge_sources_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_merge_sources_target_idx ON public.account_merge_sources USING btree (target_user_id);


--
-- Name: account_recovery_attempts_active_target_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX account_recovery_attempts_active_target_uq ON public.account_recovery_attempts USING btree (target_user_id) WHERE ((status)::text = 'APPROVED'::text);


--
-- Name: account_recovery_attempts_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_recovery_attempts_expiry_idx ON public.account_recovery_attempts USING btree (expires_at) WHERE ((status)::text = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying])::text[]));


--
-- Name: account_recovery_codes_active_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX account_recovery_codes_active_user_idx ON public.account_recovery_codes USING btree (user_id) WHERE ((revoked_at IS NULL) AND (consumed_at IS NULL));


--
-- Name: account_recovery_contact_removals_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_recovery_contact_removals_contact_idx ON public.account_recovery_contact_removals USING btree (contact_id, created_at DESC);


--
-- Name: account_recovery_contacts_active_pair_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX account_recovery_contacts_active_pair_uq ON public.account_recovery_contacts USING btree (owner_user_id, trustee_user_id) WHERE (revoked_at IS NULL);


--
-- Name: account_recovery_contacts_trustee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_recovery_contacts_trustee_idx ON public.account_recovery_contacts USING btree (trustee_user_id, created_at DESC) WHERE (revoked_at IS NULL);


--
-- Name: account_registration_tickets_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_registration_tickets_expiry_idx ON public.account_registration_tickets USING btree (expires_at);


--
-- Name: admin_actions_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_actions_created_idx ON public.admin_actions USING btree (created_at DESC, request_id);


--
-- Name: app_sessions_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_sessions_expiry_idx ON public.app_sessions USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: app_sessions_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_sessions_user_active_idx ON public.app_sessions USING btree (user_id, last_seen_at DESC) WHERE (revoked_at IS NULL);


--
-- Name: app_users_admin_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_users_admin_created_idx ON public.app_users USING btree (created_at, id);


--
-- Name: check_in_audiences_circle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX check_in_audiences_circle_idx ON public.check_in_audiences USING btree (circle_id, actor_user_id, check_in_id DESC);


--
-- Name: check_in_audiences_recipient_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX check_in_audiences_recipient_actor_idx ON public.check_in_audiences USING btree (recipient_user_id, actor_user_id, check_in_id DESC);


--
-- Name: check_in_audiences_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX check_in_audiences_recipient_idx ON public.check_in_audiences USING btree (recipient_user_id, check_in_id DESC);


--
-- Name: check_ins_admin_activity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX check_ins_admin_activity_idx ON public.check_ins USING btree (checked_at, user_id);


--
-- Name: check_ins_calendar_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX check_ins_calendar_idx ON public.check_ins USING btree (user_id, local_date DESC, checked_at DESC);


--
-- Name: check_ins_user_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX check_ins_user_latest_idx ON public.check_ins USING btree (user_id, checked_at DESC);


--
-- Name: circle_invites_pending_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX circle_invites_pending_expiry_idx ON public.circle_invites USING btree (expires_at) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: circle_invites_pending_target_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX circle_invites_pending_target_uq ON public.circle_invites USING btree (circle_id, invitee_user_id) WHERE (((status)::text = 'PENDING'::text) AND (invitee_user_id IS NOT NULL));


--
-- Name: circle_memberships_active_owner_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX circle_memberships_active_owner_uq ON public.circle_memberships USING btree (circle_id) WHERE (((role)::text = 'OWNER'::text) AND (left_at IS NULL));


--
-- Name: circle_memberships_active_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX circle_memberships_active_uq ON public.circle_memberships USING btree (circle_id, user_id) WHERE (left_at IS NULL);


--
-- Name: circle_memberships_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX circle_memberships_user_active_idx ON public.circle_memberships USING btree (user_id, circle_id) WHERE (left_at IS NULL);


--
-- Name: circle_sharing_preferences_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX circle_sharing_preferences_user_idx ON public.circle_sharing_preferences USING btree (user_id, circle_id) WHERE ((sharing_mode)::text <> 'OFF'::text);


--
-- Name: circles_active_direct_pair_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX circles_active_direct_pair_uq ON public.circles USING btree (direct_user_low_id, direct_user_high_id) WHERE (((kind)::text = 'DIRECT'::text) AND (archived_at IS NULL));


--
-- Name: circles_direct_high_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX circles_direct_high_active_idx ON public.circles USING btree (direct_user_high_id, created_at DESC) WHERE (((kind)::text = 'DIRECT'::text) AND (archived_at IS NULL));


--
-- Name: circles_direct_low_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX circles_direct_low_active_idx ON public.circles USING btree (direct_user_low_id, created_at DESC) WHERE (((kind)::text = 'DIRECT'::text) AND (archived_at IS NULL));


--
-- Name: circles_group_creation_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX circles_group_creation_key_uq ON public.circles USING btree (created_by_user_id, creation_idempotency_key) WHERE (((kind)::text = 'GROUP'::text) AND (creation_idempotency_key IS NOT NULL));


--
-- Name: direct_invite_links_active_owner_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX direct_invite_links_active_owner_uq ON public.direct_invite_links USING btree (inviter_user_id) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: direct_invite_links_pending_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX direct_invite_links_pending_expiry_idx ON public.direct_invite_links USING btree (expires_at) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: direct_invite_redemptions_circle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX direct_invite_redemptions_circle_idx ON public.direct_invite_redemptions USING btree (circle_id, accepted_at);


--
-- Name: direct_requests_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX direct_requests_expiry_idx ON public.direct_requests USING btree (expires_at) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: direct_requests_pending_pair_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX direct_requests_pending_pair_uq ON public.direct_requests USING btree (LEAST(requester_user_id, recipient_user_id), GREATEST(requester_user_id, recipient_user_id)) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: direct_requests_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX direct_requests_recipient_idx ON public.direct_requests USING btree (recipient_user_id, created_at DESC) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: direct_requests_requester_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX direct_requests_requester_idx ON public.direct_requests USING btree (requester_user_id, created_at DESC) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: economy_barter_active_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economy_barter_active_feed ON public.economy_barter_offers USING btree (created_at DESC, id DESC) WHERE (status = 'active'::text);


--
-- Name: economy_barter_seller_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economy_barter_seller_active ON public.economy_barter_offers USING btree (seller_id, created_at DESC) WHERE (status = 'active'::text);


--
-- Name: economy_commands_analytics_context_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economy_commands_analytics_context_idx ON public.economy_commands USING btree (user_id, ((request_id)::text));


--
-- Name: economy_ledger_first_construction_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economy_ledger_first_construction_idx ON public.economy_ledger USING btree (user_id, created_at, source_key) WHERE (kind = 'start_construction'::text);


--
-- Name: economy_ledger_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economy_ledger_history ON public.economy_ledger USING btree (user_id, created_at DESC);


--
-- Name: economy_ledger_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economy_ledger_period_idx ON public.economy_ledger USING btree (created_at DESC, user_id);


--
-- Name: economy_market_active_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economy_market_active_feed ON public.economy_market_listings USING btree (created_at DESC, id DESC) WHERE (status = 'active'::text);


--
-- Name: economy_market_seller_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economy_market_seller_active ON public.economy_market_listings USING btree (seller_id, created_at DESC) WHERE (status = 'active'::text);


--
-- Name: forest_memory_receipts_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forest_memory_receipts_recent_idx ON public.forest_memory_receipts USING btree (user_id, accepted_revision DESC);


--
-- Name: game_daily_reward_one_per_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX game_daily_reward_one_per_date ON public.game_reward_claims USING btree (user_id, origin_user_id, daily_date) WHERE (kind = 'daily'::text);


--
-- Name: game_monthly_ranking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_monthly_ranking_idx ON public.game_monthly_scores USING btree (month, taps DESC, updated_at, user_id);


--
-- Name: game_presence_clients_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_presence_clients_live_idx ON public.game_presence_clients USING btree (auth_session_id, last_seen_at) WHERE ((status)::text = 'active'::text);


--
-- Name: game_presence_clients_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_presence_clients_user_idx ON public.game_presence_clients USING btree (user_id, created_at);


--
-- Name: game_presence_daily_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_presence_daily_day_idx ON public.game_presence_daily USING btree (day, user_id);


--
-- Name: game_presence_daily_flagged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_presence_daily_flagged_idx ON public.game_presence_daily USING btree (day DESC, flagged_at DESC) WHERE (flagged_at IS NOT NULL);


--
-- Name: game_profiles_series_rank_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_profiles_series_rank_idx ON public.game_profiles USING btree (best_series DESC, user_id) WHERE (leaderboard_opt_in AND (best_series > 0));


--
-- Name: game_profiles_writer_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_profiles_writer_session ON public.game_profiles USING btree (writer_session_id) WHERE (writer_session_id IS NOT NULL);


--
-- Name: game_sessions_user_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_sessions_user_expiry_idx ON public.game_sessions USING btree (user_id, expires_at);


--
-- Name: game_tap_activity_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_tap_activity_retention_idx ON public.game_tap_activity_seconds USING btree (bucket_at);


--
-- Name: game_tap_history_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX game_tap_history_retention_idx ON public.game_tap_activity_minutes USING btree (bucket_at);


--
-- Name: identity_bootstrap_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_bootstrap_expiry_idx ON public.identity_bootstrap_keys USING btree (expires_at);


--
-- Name: notification_batches_budget; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_batches_budget ON public.notification_batches USING btree (user_id, reserved_at DESC) WHERE ((state)::text = ANY ((ARRAY['sending'::character varying, 'delivered'::character varying, 'uncertain'::character varying])::text[]));


--
-- Name: notification_batches_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_batches_cleanup ON public.notification_batches USING btree (reserved_at);


--
-- Name: notification_batches_sending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_batches_sending ON public.notification_batches USING btree (reserved_at) WHERE ((state)::text = 'sending'::text);


--
-- Name: notification_events_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_events_due ON public.notification_events USING btree (next_attempt_at, user_id) WHERE ((state)::text = 'pending'::text);


--
-- Name: notification_subscriptions_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_subscriptions_session ON public.notification_subscriptions USING btree (session_id);


--
-- Name: notification_subscriptions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_subscriptions_user ON public.notification_subscriptions USING btree (user_id, updated_at DESC);


--
-- Name: player_feedback_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX player_feedback_created_idx ON public.player_feedback USING btree (created_at DESC, id DESC);


--
-- Name: player_feedback_owner_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX player_feedback_owner_created_idx ON public.player_feedback USING btree (user_id, created_at DESC);


--
-- Name: player_feedback_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX player_feedback_status_created_idx ON public.player_feedback USING btree (status, created_at DESC, id DESC);


--
-- Name: promo_redemptions_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX promo_redemptions_request ON public.promo_redemptions USING btree (user_id, origin_user_id, request_id);


--
-- Name: user_incidents_owner_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_incidents_owner_received ON public.user_incidents USING btree (user_id, received_at DESC);


--
-- Name: user_incidents_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_incidents_received ON public.user_incidents USING btree (received_at DESC, id DESC);


--
-- Name: world_ledger_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX world_ledger_history ON public.world_ledger USING btree (user_id, created_at DESC);


--
-- Name: account_recovery_attempts account_recovery_attempts_state_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_recovery_attempts_state_guard BEFORE INSERT OR UPDATE ON public.account_recovery_attempts FOR EACH ROW EXECUTE FUNCTION public.guard_account_recovery_attempt();


--
-- Name: account_recovery_contacts account_recovery_contacts_state_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_recovery_contacts_state_guard BEFORE INSERT OR UPDATE ON public.account_recovery_contacts FOR EACH ROW EXECUTE FUNCTION public.guard_account_recovery_contact();


--
-- Name: admin_actions admin_actions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER admin_actions_append_only BEFORE DELETE OR UPDATE ON public.admin_actions FOR EACH ROW EXECUTE FUNCTION public.guard_admin_audit();


--
-- Name: app_sessions app_sessions_ban_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER app_sessions_ban_guard BEFORE INSERT OR UPDATE OF user_id, revoked_at ON public.app_sessions FOR EACH ROW EXECUTE FUNCTION public.guard_banned_session();


--
-- Name: check_in_audiences check_in_audiences_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER check_in_audiences_append_only BEFORE DELETE OR UPDATE ON public.check_in_audiences FOR EACH ROW EXECUTE FUNCTION public.reject_check_in_audience_mutation();


--
-- Name: check_in_audiences check_in_audiences_privacy_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER check_in_audiences_privacy_guard BEFORE INSERT ON public.check_in_audiences FOR EACH ROW EXECUTE FUNCTION public.guard_check_in_audience();


--
-- Name: check_ins check_ins_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER check_ins_append_only BEFORE DELETE OR UPDATE ON public.check_ins FOR EACH ROW EXECUTE FUNCTION public.reject_check_in_mutation();


--
-- Name: circle_invites circle_invites_inviter_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER circle_invites_inviter_guard BEFORE INSERT OR UPDATE OF circle_id, inviter_user_id, status ON public.circle_invites FOR EACH ROW EXECUTE FUNCTION public.guard_circle_inviter();


--
-- Name: circle_invites circle_invites_state_machine; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER circle_invites_state_machine BEFORE INSERT OR UPDATE ON public.circle_invites FOR EACH ROW EXECUTE FUNCTION public.guard_circle_invite_state();


--
-- Name: circle_memberships circle_memberships_owner_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER circle_memberships_owner_guard BEFORE INSERT OR UPDATE ON public.circle_memberships FOR EACH ROW EXECUTE FUNCTION public.guard_group_owner();


--
-- Name: circle_memberships circle_memberships_owner_required; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER circle_memberships_owner_required AFTER INSERT OR DELETE OR UPDATE ON public.circle_memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_membership_group_owner();


--
-- Name: circle_memberships circle_memberships_state_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER circle_memberships_state_guard BEFORE INSERT OR UPDATE ON public.circle_memberships FOR EACH ROW EXECUTE FUNCTION public.guard_membership_state();


--
-- Name: circle_sharing_preferences circle_sharing_preferences_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER circle_sharing_preferences_guard BEFORE INSERT OR UPDATE ON public.circle_sharing_preferences FOR EACH ROW EXECUTE FUNCTION public.guard_circle_sharing_preference();


--
-- Name: circles circles_archived_profile_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER circles_archived_profile_guard BEFORE UPDATE ON public.circles FOR EACH ROW EXECUTE FUNCTION public.guard_archived_group_profile();


--
-- Name: circles circles_group_creation_key_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER circles_group_creation_key_guard BEFORE UPDATE ON public.circles FOR EACH ROW EXECUTE FUNCTION public.guard_group_creation_key();


--
-- Name: circles circles_owner_required; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER circles_owner_required AFTER INSERT OR DELETE OR UPDATE ON public.circles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_circle_group_owner();


--
-- Name: circles circles_state_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER circles_state_guard BEFORE INSERT OR UPDATE ON public.circles FOR EACH ROW EXECUTE FUNCTION public.guard_circle_state();


--
-- Name: direct_invite_links direct_invite_links_state_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER direct_invite_links_state_guard BEFORE INSERT OR UPDATE ON public.direct_invite_links FOR EACH ROW EXECUTE FUNCTION public.guard_direct_invite_link_state();


--
-- Name: direct_invite_redemptions direct_invite_redemptions_state_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER direct_invite_redemptions_state_guard BEFORE INSERT OR DELETE OR UPDATE ON public.direct_invite_redemptions FOR EACH ROW EXECUTE FUNCTION public.guard_direct_invite_redemption();


--
-- Name: direct_requests direct_requests_circle_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER direct_requests_circle_guard BEFORE INSERT OR UPDATE ON public.direct_requests FOR EACH ROW EXECUTE FUNCTION public.guard_accepted_direct_request();


--
-- Name: direct_requests direct_requests_state_machine; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER direct_requests_state_machine BEFORE INSERT OR UPDATE ON public.direct_requests FOR EACH ROW EXECUTE FUNCTION public.guard_direct_request_state();


--
-- Name: app_users notification_account_invalidated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notification_account_invalidated AFTER UPDATE OF deleted_at, banned_at ON public.app_users FOR EACH ROW EXECUTE FUNCTION public.notification_account_invalidated();


--
-- Name: check_ins notification_checkin_changed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notification_checkin_changed AFTER INSERT ON public.check_ins FOR EACH ROW EXECUTE FUNCTION public.notification_checkin_changed();


--
-- Name: economy_profiles notification_economy_changed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notification_economy_changed AFTER INSERT OR UPDATE OF state ON public.economy_profiles FOR EACH ROW EXECUTE FUNCTION public.notification_economy_changed();


--
-- Name: account_merge_sources notification_merge_history_changed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notification_merge_history_changed AFTER INSERT OR UPDATE OF target_user_id ON public.account_merge_sources FOR EACH ROW EXECUTE FUNCTION public.notification_merge_history_changed();


--
-- Name: app_sessions notification_session_invalidated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notification_session_invalidated BEFORE UPDATE OF revoked_at, user_id, token_hash ON public.app_sessions FOR EACH ROW EXECUTE FUNCTION public.notification_session_invalidated();


--
-- Name: recipient_sharing_preferences recipient_sharing_preferences_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recipient_sharing_preferences_guard BEFORE INSERT OR DELETE OR UPDATE ON public.recipient_sharing_preferences FOR EACH ROW EXECUTE FUNCTION public.guard_recipient_sharing_preference();


--
-- Name: account_recovery_contacts recovery_contact_cancels_attempts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recovery_contact_cancels_attempts AFTER UPDATE OF revoked_at ON public.account_recovery_contacts FOR EACH ROW EXECUTE FUNCTION public.cancel_attempts_for_revoked_recovery_contact();


--
-- Name: account_action_proofs account_action_proofs_flow_hash_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_action_proofs
    ADD CONSTRAINT account_action_proofs_flow_hash_fkey FOREIGN KEY (flow_hash) REFERENCES public.account_login_flows(token_hash) ON DELETE CASCADE;


--
-- Name: account_action_proofs account_action_proofs_proved_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_action_proofs
    ADD CONSTRAINT account_action_proofs_proved_user_id_fkey FOREIGN KEY (proved_user_id) REFERENCES public.app_users(id);


--
-- Name: account_action_proofs account_action_proofs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_action_proofs
    ADD CONSTRAINT account_action_proofs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id);


--
-- Name: account_group_owner_transfers account_group_owner_transfers_circle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_group_owner_transfers
    ADD CONSTRAINT account_group_owner_transfers_circle_id_fkey FOREIGN KEY (circle_id) REFERENCES public.circles(id);


--
-- Name: account_group_owner_transfers account_group_owner_transfers_source_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_group_owner_transfers
    ADD CONSTRAINT account_group_owner_transfers_source_user_id_fkey FOREIGN KEY (source_user_id) REFERENCES public.app_users(id);


--
-- Name: account_group_owner_transfers account_group_owner_transfers_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_group_owner_transfers
    ADD CONSTRAINT account_group_owner_transfers_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.app_users(id);


--
-- Name: account_identity_retirements account_identity_retirements_merged_into_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_identity_retirements
    ADD CONSTRAINT account_identity_retirements_merged_into_user_id_fkey FOREIGN KEY (merged_into_user_id) REFERENCES public.app_users(id);


--
-- Name: account_login_identities account_login_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_login_identities
    ADD CONSTRAINT account_login_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id);


--
-- Name: account_merge_previews account_merge_previews_other_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_merge_previews
    ADD CONSTRAINT account_merge_previews_other_user_id_fkey FOREIGN KEY (other_user_id) REFERENCES public.app_users(id);


--
-- Name: account_merge_previews account_merge_previews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_merge_previews
    ADD CONSTRAINT account_merge_previews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id);


--
-- Name: account_merge_sources account_merge_sources_source_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_merge_sources
    ADD CONSTRAINT account_merge_sources_source_user_id_fkey FOREIGN KEY (source_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: account_merge_sources account_merge_sources_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_merge_sources
    ADD CONSTRAINT account_merge_sources_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: account_operation_receipts account_operation_receipts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_operation_receipts
    ADD CONSTRAINT account_operation_receipts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id);


--
-- Name: account_recovery_attempts account_recovery_attempts_approved_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_approved_by_user_id_fkey FOREIGN KEY (approved_by_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: account_recovery_attempts account_recovery_attempts_completed_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_completed_session_fk FOREIGN KEY (completed_session_id, target_user_id) REFERENCES public.app_sessions(id, user_id) ON DELETE RESTRICT;


--
-- Name: account_recovery_attempts account_recovery_attempts_contact_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_contact_fk FOREIGN KEY (recovery_contact_id, target_user_id, approved_by_user_id) REFERENCES public.account_recovery_contacts(id, owner_user_id, trustee_user_id) ON DELETE RESTRICT;


--
-- Name: account_recovery_attempts account_recovery_attempts_initiating_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_initiating_session_fk FOREIGN KEY (initiating_session_id, initiating_user_id) REFERENCES public.app_sessions(id, user_id) ON DELETE RESTRICT;


--
-- Name: account_recovery_attempts account_recovery_attempts_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_attempts
    ADD CONSTRAINT account_recovery_attempts_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: account_recovery_codes account_recovery_codes_recovery_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_codes
    ADD CONSTRAINT account_recovery_codes_recovery_session_id_fkey FOREIGN KEY (recovery_session_id) REFERENCES public.app_sessions(id) ON DELETE RESTRICT;


--
-- Name: account_recovery_codes account_recovery_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_codes
    ADD CONSTRAINT account_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: account_recovery_contact_removals account_recovery_contact_removals_contact_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contact_removals
    ADD CONSTRAINT account_recovery_contact_removals_contact_fk FOREIGN KEY (contact_id, owner_user_id) REFERENCES public.account_recovery_contacts(id, owner_user_id) ON DELETE RESTRICT;


--
-- Name: account_recovery_contact_removals account_recovery_contact_removals_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contact_removals
    ADD CONSTRAINT account_recovery_contact_removals_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: account_recovery_contacts account_recovery_contacts_circle_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contacts
    ADD CONSTRAINT account_recovery_contacts_circle_fk FOREIGN KEY (direct_circle_id, direct_circle_kind) REFERENCES public.circles(id, kind) ON DELETE RESTRICT;


--
-- Name: account_recovery_contacts account_recovery_contacts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contacts
    ADD CONSTRAINT account_recovery_contacts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: account_recovery_contacts account_recovery_contacts_trustee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_recovery_contacts
    ADD CONSTRAINT account_recovery_contacts_trustee_user_id_fkey FOREIGN KEY (trustee_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: admin_actions admin_actions_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: admin_actions admin_actions_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: app_sessions app_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: check_in_audiences check_in_audiences_check_in_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_in_audiences
    ADD CONSTRAINT check_in_audiences_check_in_fk FOREIGN KEY (check_in_id, actor_user_id) REFERENCES public.check_ins(id, user_id) ON DELETE CASCADE;


--
-- Name: check_in_audiences check_in_audiences_circle_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_in_audiences
    ADD CONSTRAINT check_in_audiences_circle_fk FOREIGN KEY (circle_id, circle_kind) REFERENCES public.circles(id, kind) ON DELETE RESTRICT;


--
-- Name: check_in_audiences check_in_audiences_recipient_membership_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_in_audiences
    ADD CONSTRAINT check_in_audiences_recipient_membership_fk FOREIGN KEY (recipient_membership_id, circle_id, recipient_user_id) REFERENCES public.circle_memberships(id, circle_id, user_id) ON DELETE RESTRICT;


--
-- Name: check_in_audiences check_in_audiences_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_in_audiences
    ADD CONSTRAINT check_in_audiences_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: check_ins check_ins_session_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins
    ADD CONSTRAINT check_ins_session_user_fk FOREIGN KEY (session_id, user_id) REFERENCES public.app_sessions(id, user_id) ON DELETE RESTRICT;


--
-- Name: check_ins check_ins_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins
    ADD CONSTRAINT check_ins_user_fk FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: circle_invites circle_invites_accepted_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: circle_invites circle_invites_circle_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_circle_fk FOREIGN KEY (circle_id, circle_kind) REFERENCES public.circles(id, kind) ON DELETE RESTRICT;


--
-- Name: circle_invites circle_invites_invitee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_invitee_user_id_fkey FOREIGN KEY (invitee_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: circle_invites circle_invites_inviter_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_invites
    ADD CONSTRAINT circle_invites_inviter_user_id_fkey FOREIGN KEY (inviter_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: circle_memberships circle_memberships_circle_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_memberships
    ADD CONSTRAINT circle_memberships_circle_fk FOREIGN KEY (circle_id, circle_kind) REFERENCES public.circles(id, kind) ON DELETE RESTRICT;


--
-- Name: circle_memberships circle_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_memberships
    ADD CONSTRAINT circle_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: circle_sharing_preferences circle_sharing_preferences_circle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_sharing_preferences
    ADD CONSTRAINT circle_sharing_preferences_circle_id_fkey FOREIGN KEY (circle_id) REFERENCES public.circles(id) ON DELETE RESTRICT;


--
-- Name: circle_sharing_preferences circle_sharing_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circle_sharing_preferences
    ADD CONSTRAINT circle_sharing_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: circles circles_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circles
    ADD CONSTRAINT circles_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: circles circles_direct_user_high_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circles
    ADD CONSTRAINT circles_direct_user_high_id_fkey FOREIGN KEY (direct_user_high_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: circles circles_direct_user_low_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.circles
    ADD CONSTRAINT circles_direct_user_low_id_fkey FOREIGN KEY (direct_user_low_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: direct_invite_links direct_invite_links_accepted_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_links
    ADD CONSTRAINT direct_invite_links_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: direct_invite_links direct_invite_links_circle_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_links
    ADD CONSTRAINT direct_invite_links_circle_fk FOREIGN KEY (result_circle_id, result_circle_kind) REFERENCES public.circles(id, kind) ON DELETE RESTRICT;


--
-- Name: direct_invite_links direct_invite_links_inviter_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_links
    ADD CONSTRAINT direct_invite_links_inviter_user_id_fkey FOREIGN KEY (inviter_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: direct_invite_redemptions direct_invite_redemptions_circle_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_redemptions
    ADD CONSTRAINT direct_invite_redemptions_circle_fk FOREIGN KEY (circle_id, circle_kind) REFERENCES public.circles(id, kind) ON DELETE RESTRICT;


--
-- Name: direct_invite_redemptions direct_invite_redemptions_invite_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_redemptions
    ADD CONSTRAINT direct_invite_redemptions_invite_id_fkey FOREIGN KEY (invite_id) REFERENCES public.direct_invite_links(id) ON DELETE RESTRICT;


--
-- Name: direct_invite_redemptions direct_invite_redemptions_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_invite_redemptions
    ADD CONSTRAINT direct_invite_redemptions_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: direct_person_favorites direct_person_favorites_circle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_person_favorites
    ADD CONSTRAINT direct_person_favorites_circle_id_fkey FOREIGN KEY (circle_id) REFERENCES public.circles(id);


--
-- Name: direct_person_favorites direct_person_favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_person_favorites
    ADD CONSTRAINT direct_person_favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id);


--
-- Name: direct_requests direct_requests_circle_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_requests
    ADD CONSTRAINT direct_requests_circle_fk FOREIGN KEY (result_circle_id, result_circle_kind) REFERENCES public.circles(id, kind);


--
-- Name: direct_requests direct_requests_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_requests
    ADD CONSTRAINT direct_requests_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: direct_requests direct_requests_requester_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_requests
    ADD CONSTRAINT direct_requests_requester_user_id_fkey FOREIGN KEY (requester_user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: economy_barter_offers economy_barter_offers_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_barter_offers
    ADD CONSTRAINT economy_barter_offers_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: economy_barter_offers economy_barter_offers_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_barter_offers
    ADD CONSTRAINT economy_barter_offers_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_barter_receipts economy_barter_receipts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_barter_receipts
    ADD CONSTRAINT economy_barter_receipts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_barter_showcases economy_barter_showcases_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_barter_showcases
    ADD CONSTRAINT economy_barter_showcases_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_commands economy_commands_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_commands
    ADD CONSTRAINT economy_commands_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_conversion_audit economy_conversion_audit_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_conversion_audit
    ADD CONSTRAINT economy_conversion_audit_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_ledger economy_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_ledger
    ADD CONSTRAINT economy_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_market_daily_turnover economy_market_daily_turnover_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_market_daily_turnover
    ADD CONSTRAINT economy_market_daily_turnover_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_market_listings economy_market_listings_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_market_listings
    ADD CONSTRAINT economy_market_listings_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: economy_market_listings economy_market_listings_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_market_listings
    ADD CONSTRAINT economy_market_listings_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_market_receipts economy_market_receipts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_market_receipts
    ADD CONSTRAINT economy_market_receipts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_market_showcases economy_market_showcases_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_market_showcases
    ADD CONSTRAINT economy_market_showcases_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: economy_profiles economy_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economy_profiles
    ADD CONSTRAINT economy_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: forest_memory_receipts forest_memory_receipts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forest_memory_receipts
    ADD CONSTRAINT forest_memory_receipts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: forest_memory forest_memory_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forest_memory
    ADD CONSTRAINT forest_memory_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: game_achievement_reward_claims game_achievement_reward_claims_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_achievement_reward_claims
    ADD CONSTRAINT game_achievement_reward_claims_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: game_achievement_tiers game_achievement_tiers_user_id_achievement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_achievement_tiers
    ADD CONSTRAINT game_achievement_tiers_user_id_achievement_id_fkey FOREIGN KEY (user_id, achievement_id) REFERENCES public.game_achievements(user_id, achievement_id) ON DELETE CASCADE;


--
-- Name: game_achievements game_achievements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_achievements
    ADD CONSTRAINT game_achievements_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: game_daily_rewards game_daily_rewards_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_daily_rewards
    ADD CONSTRAINT game_daily_rewards_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: game_items game_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_items
    ADD CONSTRAINT game_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: game_monthly_scores game_monthly_scores_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_monthly_scores
    ADD CONSTRAINT game_monthly_scores_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: game_presence_accounts game_presence_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_presence_accounts
    ADD CONSTRAINT game_presence_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: game_presence_clients game_presence_clients_auth_session_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_presence_clients
    ADD CONSTRAINT game_presence_clients_auth_session_id_user_id_fkey FOREIGN KEY (auth_session_id, user_id) REFERENCES public.app_sessions(id, user_id) ON DELETE CASCADE;


--
-- Name: game_presence_clients game_presence_clients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_presence_clients
    ADD CONSTRAINT game_presence_clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: game_presence_daily game_presence_daily_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_presence_daily
    ADD CONSTRAINT game_presence_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: game_profiles game_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_profiles
    ADD CONSTRAINT game_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: game_profiles game_profiles_writer_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_profiles
    ADD CONSTRAINT game_profiles_writer_session_id_fkey FOREIGN KEY (writer_session_id) REFERENCES public.game_sessions(id) ON DELETE SET NULL;


--
-- Name: game_reward_claims game_reward_claims_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_reward_claims
    ADD CONSTRAINT game_reward_claims_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: game_sessions game_sessions_auth_session_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_sessions
    ADD CONSTRAINT game_sessions_auth_session_id_user_id_fkey FOREIGN KEY (auth_session_id, user_id) REFERENCES public.app_sessions(id, user_id) ON DELETE RESTRICT;


--
-- Name: game_sessions game_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_sessions
    ADD CONSTRAINT game_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: game_tap_activity_minutes game_tap_activity_minutes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_tap_activity_minutes
    ADD CONSTRAINT game_tap_activity_minutes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: game_tap_activity_seconds game_tap_activity_seconds_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_tap_activity_seconds
    ADD CONSTRAINT game_tap_activity_seconds_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: identity_bootstrap_keys identity_bootstrap_session_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_bootstrap_keys
    ADD CONSTRAINT identity_bootstrap_session_user_fk FOREIGN KEY (session_id, user_id) REFERENCES public.app_sessions(id, user_id) ON DELETE RESTRICT;


--
-- Name: notification_batches notification_batches_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_batches
    ADD CONSTRAINT notification_batches_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: notification_events notification_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: notification_subscriptions notification_subscriptions_session_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_subscriptions
    ADD CONSTRAINT notification_subscriptions_session_id_user_id_fkey FOREIGN KEY (session_id, user_id) REFERENCES public.app_sessions(id, user_id) ON DELETE CASCADE;


--
-- Name: notification_subscriptions notification_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_subscriptions
    ADD CONSTRAINT notification_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: player_feedback_actions player_feedback_actions_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_feedback_actions
    ADD CONSTRAINT player_feedback_actions_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: player_feedback_actions player_feedback_actions_feedback_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_feedback_actions
    ADD CONSTRAINT player_feedback_actions_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES public.player_feedback(id) ON DELETE CASCADE;


--
-- Name: player_feedback player_feedback_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_feedback
    ADD CONSTRAINT player_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: private_person_nicknames private_person_nicknames_subject_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_person_nicknames
    ADD CONSTRAINT private_person_nicknames_subject_user_id_fkey FOREIGN KEY (subject_user_id) REFERENCES public.app_users(id);


--
-- Name: private_person_nicknames private_person_nicknames_viewer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_person_nicknames
    ADD CONSTRAINT private_person_nicknames_viewer_user_id_fkey FOREIGN KEY (viewer_user_id) REFERENCES public.app_users(id);


--
-- Name: promo_redemptions promo_redemptions_origin_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_origin_user_id_fkey FOREIGN KEY (origin_user_id) REFERENCES public.app_users(id);


--
-- Name: promo_redemptions promo_redemptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id);


--
-- Name: recipient_sharing_preferences recipient_sharing_preferences_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_sharing_preferences
    ADD CONSTRAINT recipient_sharing_preferences_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.app_users(id);


--
-- Name: recipient_sharing_preferences recipient_sharing_preferences_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_sharing_preferences
    ADD CONSTRAINT recipient_sharing_preferences_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.app_users(id);


--
-- Name: user_incidents user_incidents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_incidents
    ADD CONSTRAINT user_incidents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: user_status_write_keys user_status_write_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_status_write_keys
    ADD CONSTRAINT user_status_write_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id);


--
-- Name: user_timezone_write_keys user_timezone_write_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_timezone_write_keys
    ADD CONSTRAINT user_timezone_write_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE RESTRICT;


--
-- Name: world_commands world_commands_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_commands
    ADD CONSTRAINT world_commands_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: world_ledger world_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_ledger
    ADD CONSTRAINT world_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: world_profiles world_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_profiles
    ADD CONSTRAINT world_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
-- This is the only initial data row. A fresh database starts collection coverage
-- now; historical databases retain the original V28 timestamp through V30.
INSERT INTO public.game_tap_collection_metadata(singleton, started_at)
VALUES (true, CURRENT_TIMESTAMP);
