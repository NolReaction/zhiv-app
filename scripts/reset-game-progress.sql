\set ON_ERROR_STOP on
\if :{?apply_reset}
\else
  \set apply_reset off
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '3min';
\if :apply_reset
  SELECT set_config('zhiv.reset_game_progress', 'on', true);
\else
  SET TRANSACTION READ ONLY;
  SELECT set_config('zhiv.reset_game_progress', 'off', true);
\endif

DO $$
DECLARE
    cleared_tables text[] := ARRAY[
        'economy_barter_offers', 'economy_barter_receipts', 'economy_barter_showcases',
        'economy_commands',
        'economy_market_daily_turnover', 'economy_market_listings', 'economy_market_receipts',
        'economy_market_showcases', 'forest_memory_receipts',
        'game_achievement_reward_claims', 'game_achievement_tiers', 'game_achievements',
        'game_daily_rewards', 'game_items', 'game_monthly_scores', 'game_presence_clients',
        'game_reward_claims', 'game_sessions', 'game_tap_activity_minutes',
        'game_tap_activity_seconds', 'world_commands', 'world_ledger'
    ];
    -- Fresh contents replace progress, but revisions must never go backwards:
    -- old tabs persist commands across reload and use them for uncertain retries.
    reinitialized_tables text[] := ARRAY[
        'economy_profiles', 'world_profiles', 'forest_memory', 'game_profiles', 'economy_conversion_audit', 'economy_ledger'
    ];
    preserved_tables text[] := ARRAY[
        'account_action_proofs', 'account_group_owner_transfers', 'account_identity_retirements',
        'account_login_flows', 'account_login_identities', 'account_merge_previews',
        'account_merge_sources', 'account_operation_receipts', 'account_recovery_attempts',
        'account_recovery_codes', 'account_recovery_contact_removals', 'account_recovery_contacts',
        'account_registration_tickets', 'admin_actions', 'app_sessions', 'app_users',
        'check_in_audiences', 'check_ins', 'circle_invites', 'circle_memberships',
        'circle_sharing_preferences', 'circles', 'direct_invite_links', 'direct_invite_redemptions',
        'direct_person_favorites', 'direct_requests', 'game_presence_accounts', 'game_presence_daily',
        'game_tap_collection_metadata', 'identity_bootstrap_keys', 'managed_promo_codes', 'notification_batches',
        'notification_preferences', 'notification_subscriptions', 'player_feedback',
        'player_feedback_actions', 'player_security_observations', 'private_person_nicknames', 'promo_redemptions',
        'recipient_sharing_preferences', 'user_incidents', 'user_status_write_keys', 'user_timezone_write_keys'
    ];
    -- Only obsolete gameplay events are removed; check-in reminders stay intact.
    partial_tables text[] := ARRAY['notification_events'];
    expected_tables text[];
    actual_tables text[];
    table_name text;
    row_count bigint;
    fingerprint text;
    preserved_fingerprints jsonb := '{}'::jsonb;
    checkin_fingerprint text;
    apply_mode boolean := current_setting('zhiv.reset_game_progress', true) = 'on';
BEGIN
    SELECT array_agg(name ORDER BY name COLLATE "C") INTO expected_tables
    FROM unnest(cleared_tables || preserved_tables || reinitialized_tables || partial_tables) AS t(name);
    SELECT array_agg(tablename::text ORDER BY tablename COLLATE "C") INTO actual_tables
    FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'flyway_schema_history';
    IF actual_tables IS DISTINCT FROM expected_tables THEN
        RAISE EXCEPTION 'Unexpected application tables. Game reset cancelled; review the schema first.';
    END IF;
    -- V60 observations and their app_users summary survive gameplay-only resets.
    -- Any later migration must be reviewed, including columns on retained tables.
    IF (SELECT max(version::integer) FROM public.flyway_schema_history) IS DISTINCT FROM 60
        OR NOT (
            ARRAY(SELECT version || ':' || type FROM public.flyway_schema_history ORDER BY version::integer)
                = ARRAY(SELECT version::text || ':SQL' FROM generate_series(1,60) AS expected(version))
            OR ARRAY(SELECT version || ':' || type FROM public.flyway_schema_history ORDER BY version::integer)
                = ARRAY['49:SQL_BASELINE','50:SQL','51:SQL','52:SQL','53:SQL','54:SQL','55:SQL','56:SQL','57:SQL','58:SQL','59:SQL','60:SQL']
        )
        OR EXISTS (SELECT 1 FROM public.flyway_schema_history WHERE NOT success) THEN
        RAISE EXCEPTION 'Expected successfully applied migrations through V60. Game reset cancelled.';
    END IF;

    IF apply_mode THEN
        -- The wrapper stops writers first. This also prevents an accidental
        -- concurrent writer from changing preserved rows during verification.
        EXECUTE 'LOCK TABLE ' || (
            SELECT string_agg(format('public.%I', name), ', ')
            FROM unnest(expected_tables || ARRAY['flyway_schema_history']) AS t(name)
        ) || ' IN SHARE MODE';
    END IF;
    FOREACH table_name IN ARRAY cleared_tables LOOP
        EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO row_count;
        RAISE NOTICE 'CLEAR %: % rows', table_name, row_count;
    END LOOP;
    FOREACH table_name IN ARRAY reinitialized_tables LOOP
        EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO row_count;
        RAISE NOTICE 'RESET contents, retain revision fence %: % rows', table_name, row_count;
    END LOOP;
    FOREACH table_name IN ARRAY preserved_tables || ARRAY['flyway_schema_history'] LOOP
        EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO row_count;
        RAISE NOTICE 'KEEP %: % rows', table_name, row_count;
        IF apply_mode THEN
            -- Hash every complete row, including secrets, without printing data.
            EXECUTE format('SELECT md5(coalesce(string_agg(h, '''' ORDER BY h), ''''))
                FROM (SELECT md5(to_jsonb(t)::text) AS h FROM public.%I t) rows', table_name) INTO fingerprint;
            preserved_fingerprints := preserved_fingerprints || jsonb_build_object(table_name, fingerprint);
        END IF;
    END LOOP;
    SELECT count(*) INTO row_count FROM public.notification_events WHERE category <> 'checkin';
    RAISE NOTICE 'CLEAR notification_events except checkin: % rows', row_count;
    IF NOT apply_mode THEN
        RAISE NOTICE 'Preview only. No application data was changed.';
        RETURN;
    END IF;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO checkin_fingerprint
    FROM (SELECT md5(to_jsonb(e)::text) AS h FROM public.notification_events e WHERE category = 'checkin') rows;
    -- Profile INSERT invokes source synchronization. Restore these exact rows
    -- afterwards so reset cannot create/rewrite service reminders as a side effect.
    CREATE TEMP TABLE game_reset_checkin_events ON COMMIT DROP AS
    SELECT * FROM public.notification_events WHERE category = 'checkin';

    -- Receipts can outlive an earlier administrative profile reset or a merge.
    -- Include their maxima as well as live revisions, and compute using numeric
    -- until the safe-integer guard has checked enough headroom for future writes.
    CREATE TEMP TABLE game_reset_revision_fences ON COMMIT DROP AS
    SELECT user_id, max(revision) AS previous_revision FROM (
        SELECT user_id, revision::numeric FROM public.economy_profiles
        UNION ALL SELECT user_id, revision::numeric FROM public.world_profiles
        UNION ALL SELECT user_id, revision::numeric FROM public.forest_memory
        UNION ALL SELECT user_id, visibility_version::numeric FROM public.game_profiles
        UNION ALL SELECT user_id, accepted_revision::numeric FROM public.economy_commands
        UNION ALL SELECT user_id, accepted_revision::numeric FROM public.economy_market_receipts
        UNION ALL SELECT user_id, accepted_revision::numeric FROM public.economy_barter_receipts
        UNION ALL SELECT user_id, accepted_revision::numeric FROM public.game_reward_claims
        UNION ALL SELECT user_id, accepted_revision::numeric FROM public.promo_redemptions
        UNION ALL SELECT user_id, accepted_revision::numeric FROM public.forest_memory_receipts
        UNION ALL SELECT user_id, (signature::jsonb->>'expectedRevision')::numeric + 1 FROM public.world_commands
    ) revisions GROUP BY user_id;
    IF EXISTS (SELECT 1 FROM game_reset_revision_fences
        WHERE previous_revision IS NULL OR previous_revision < 0 OR previous_revision >= 9007199254740990) THEN
        RAISE EXCEPTION 'Invalid or exhausted revision fence. Game reset rolled back.';
    END IF;

    EXECUTE 'TRUNCATE TABLE ' || (
        SELECT string_agg(format('public.%I', name), ', ')
        FROM unnest(cleared_tables || reinitialized_tables) AS t(name)
    ) || ' RESTART IDENTITY RESTRICT';
    INSERT INTO public.world_profiles(user_id, revision, state)
    SELECT user_id, (previous_revision + 1)::bigint,
        '{"schemaVersion":1,"resources":{"sparks":0,"wood":0,"stone":0}}'::jsonb
    FROM game_reset_revision_fences;
    -- This is the same frozen DB initializer called by ensureEconomyProfile.
    -- Unspecified Kotlin state fields take current defaults on the normal read.
    INSERT INTO public.economy_profiles(user_id, revision, state)
    SELECT user_id, (previous_revision + 1)::bigint, public.economy_v4_initial_state('{}'::jsonb, true)
    FROM game_reset_revision_fences;
    INSERT INTO public.forest_memory(user_id, revision)
    SELECT user_id, (previous_revision + 1)::bigint FROM game_reset_revision_fences;
    -- The ranking starts empty and private; an old visibility request cannot
    -- opt a player back in using the previous consent version.
    INSERT INTO public.game_profiles(user_id, visibility_version)
    SELECT user_id, (previous_revision + 1)::bigint FROM game_reset_revision_fences;
    -- The reset gives the fresh starter pack once. Keep a new conversion fence
    -- so a later individual profile recreation cannot award it a second time.
    INSERT INTO public.economy_conversion_audit(user_id, legacy_sparks, legacy_wood, legacy_stone,
        coins_granted, wood_granted, stone_granted)
    SELECT user_id, 0, 0, 0, 0, 0, 0 FROM game_reset_revision_fences;
    INSERT INTO public.economy_ledger(user_id, source_key, kind, coins, pearls, items)
    SELECT user_id, 'starting-pack:v1', 'starting_pack',
        (state->'wallet'->>'coins')::bigint, (state->'wallet'->>'pearls')::bigint, state->'inventory'
    FROM public.economy_profiles;
    DELETE FROM public.notification_events WHERE category <> 'checkin';
    DELETE FROM public.notification_events WHERE category = 'checkin';
    INSERT INTO public.notification_events SELECT * FROM game_reset_checkin_events;

    IF EXISTS (
        SELECT 1 FROM game_reset_revision_fences f
        LEFT JOIN public.economy_profiles e USING(user_id)
        LEFT JOIN public.world_profiles w USING(user_id)
        LEFT JOIN public.forest_memory m USING(user_id)
        LEFT JOIN public.game_profiles g USING(user_id)
        WHERE e.revision IS DISTINCT FROM (f.previous_revision + 1)::bigint
            OR w.revision IS DISTINCT FROM (f.previous_revision + 1)::bigint
            OR m.revision IS DISTINCT FROM (f.previous_revision + 1)::bigint
            OR g.visibility_version IS DISTINCT FROM (f.previous_revision + 1)::bigint
            OR g.lifetime_taps <> 0 OR g.best_series <> 0 OR g.leaderboard_opt_in
            OR e.state IS DISTINCT FROM public.economy_v4_initial_state('{}'::jsonb, true)
            OR w.state IS DISTINCT FROM '{"schemaVersion":1,"resources":{"sparks":0,"wood":0,"stone":0}}'::jsonb
            OR m.snapshot IS NOT NULL OR m.lease_token IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Fresh state or monotonic revision invariant failed. Game reset rolled back.';
    END IF;

    FOREACH table_name IN ARRAY cleared_tables LOOP
        EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO row_count;
        IF row_count <> 0 THEN RAISE EXCEPTION 'Table % is not empty. Game reset rolled back.', table_name; END IF;
    END LOOP;
    FOREACH table_name IN ARRAY preserved_tables || ARRAY['flyway_schema_history'] LOOP
        EXECUTE format('SELECT md5(coalesce(string_agg(h, '''' ORDER BY h), ''''))
            FROM (SELECT md5(to_jsonb(t)::text) AS h FROM public.%I t) rows', table_name) INTO fingerprint;
        IF fingerprint IS DISTINCT FROM preserved_fingerprints->>table_name THEN
            RAISE EXCEPTION 'Preserved table % changed. Game reset rolled back.', table_name;
        END IF;
    END LOOP;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO fingerprint
    FROM (SELECT md5(to_jsonb(e)::text) AS h FROM public.notification_events e WHERE category = 'checkin') rows;
    IF fingerprint IS DISTINCT FROM checkin_fingerprint
        OR EXISTS (SELECT 1 FROM public.notification_events WHERE category <> 'checkin') THEN
        RAISE EXCEPTION 'Notification reset invariant failed. Game reset rolled back.';
    END IF;
    RAISE NOTICE 'Game progress cleared. Accounts, login sessions, social links and service history are unchanged.';
END $$;
COMMIT;
