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
        'check_in_audiences', 'check_ins', 'earth_latest_locations', 'earth_frozen_locations',
        'economy_barter_offers', 'economy_barter_receipts', 'economy_barter_showcases',
        'economy_commands',
        'economy_market_daily_turnover', 'economy_market_listings', 'economy_market_receipts',
        'economy_market_showcases', 'forest_memory_receipts',
        'game_achievement_tiers', 'game_daily_rewards', 'game_reward_claims', 'onboarding_progress',
        'game_items', 'game_monthly_scores', 'game_presence_clients', 'game_presence_accounts', 'game_presence_daily',
        'game_sessions', 'game_tap_activity_minutes',
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
        'account_registration_tickets', 'admin_mail_broadcasts', 'admin_actions', 'app_sessions',
        'circle_invites', 'circle_memberships',
        'circle_sharing_preferences', 'circles', 'direct_invite_links', 'direct_invite_redemptions',
        'direct_person_favorites', 'direct_requests', 'earth_sharing_settings', 'earth_sharing_recipients',
        'game_tap_collection_metadata', 'identity_bootstrap_keys', 'managed_promo_codes',
        'notification_preferences', 'notification_subscriptions', 'player_feedback',
        'player_feedback_actions', 'player_security_observations', 'private_person_nicknames', 'promo_redemptions',
        'recipient_sharing_preferences', 'user_incidents', 'user_status_write_keys', 'user_timezone_write_keys'
    ];
    -- Identity rows change only their obsolete check-in timestamp. Security badges
    -- and non-welcome service mail are retained exactly; other progress is removed.
    partial_tables text[] := ARRAY[
        'app_users', 'game_achievements', 'game_achievement_reward_claims', 'player_mail_messages', 'notification_events', 'notification_batches',
        'gameplay_generations', 'gameplay_reset_runs'
    ];
    expected_tables text[];
    actual_tables text[];
    table_name text;
    row_count bigint;
    fingerprint text;
    preserved_fingerprints jsonb := '{}'::jsonb;
    service_fingerprint text;
    batch_fingerprint text;
    account_fingerprint text;
    security_fingerprint text;
    security_claim_fingerprint text;
    mail_fingerprint text;
    reset_history_fingerprint text;
    previous_generation bigint;
    release_reset_id constant text := '0.7.1';
    reset_time timestamptz;
    apply_mode boolean := current_setting('zhiv.reset_game_progress', true) = 'on';
BEGIN
    SELECT array_agg(name ORDER BY name COLLATE "C") INTO expected_tables
    FROM unnest(cleared_tables || preserved_tables || reinitialized_tables || partial_tables) AS t(name);
    SELECT array_agg(tablename::text ORDER BY tablename COLLATE "C") INTO actual_tables
    FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'flyway_schema_history';
    IF actual_tables IS DISTINCT FROM expected_tables THEN
        RAISE EXCEPTION 'Unexpected application tables. Game reset cancelled; review the schema first.';
    END IF;
    -- V68 adds the reset generation and release ledger; migration itself never resets data.
    -- V69 onboarding progress is cleared; V70 expands achievement constraints without new tables.
    -- V71 adds frozen reward fields to existing mail/daily tables and updates the fresh-state factory.
    -- Every later migration still requires an explicit inventory/policy review.
    IF (SELECT max(version::integer) FROM public.flyway_schema_history) IS DISTINCT FROM 71
        OR NOT (
            ARRAY(SELECT version || ':' || type FROM public.flyway_schema_history ORDER BY version::integer)
                = ARRAY(SELECT version::text || ':SQL' FROM generate_series(1,71) AS expected(version))
            OR ARRAY(SELECT version || ':' || type FROM public.flyway_schema_history ORDER BY version::integer)
                = ARRAY['49:SQL_BASELINE','50:SQL','51:SQL','52:SQL','53:SQL','54:SQL','55:SQL','56:SQL','57:SQL','58:SQL','59:SQL','60:SQL','61:SQL','62:SQL','63:SQL','64:SQL','65:SQL','66:SQL','67:SQL','68:SQL','69:SQL','70:SQL','71:SQL']
        )
        OR EXISTS (SELECT 1 FROM public.flyway_schema_history WHERE NOT success) THEN
        RAISE EXCEPTION 'Expected successfully applied migrations through V71. Game reset cancelled.';
    END IF;

    IF apply_mode THEN
        -- The wrapper stops writers first. This also prevents an accidental
        -- concurrent writer from changing preserved rows during verification.
        EXECUTE 'LOCK TABLE ' || (
            SELECT string_agg(format('public.%I', name), ', ')
            FROM unnest(expected_tables || ARRAY['flyway_schema_history']) AS t(name)
        ) || ' IN SHARE MODE';
    END IF;
    IF (SELECT count(*) FROM public.gameplay_generations) <> 1
        OR NOT EXISTS (SELECT 1 FROM public.gameplay_generations WHERE singleton) THEN
        RAISE EXCEPTION 'Expected the gameplay generation singleton. Game reset cancelled.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.gameplay_reset_runs WHERE reset_id = release_reset_id) THEN
        RAISE NOTICE 'Release % reset already completed. No data changed.', release_reset_id;
        RETURN;
    END IF;
    SELECT generation INTO previous_generation FROM public.gameplay_generations WHERE singleton;
    IF previous_generation < 0 OR previous_generation >= 9007199254740990 THEN
        RAISE EXCEPTION 'Invalid or exhausted gameplay generation. Game reset cancelled.';
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
    RAISE NOTICE 'RESET check-in timestamps, non-security achievements and welcome mail; retain auth, friends and service mail.';
    RAISE NOTICE 'Release %, gameplay generation % -> %', release_reset_id, previous_generation, previous_generation + 1;
    IF NOT apply_mode THEN
        RAISE NOTICE 'Preview only. No application data was changed.';
        RETURN;
    END IF;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO account_fingerprint
    FROM (SELECT md5((to_jsonb(u) - 'last_check_in_at')::text) AS h FROM public.app_users u) rows;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO security_fingerprint
    FROM (SELECT md5(to_jsonb(a)::text) AS h FROM public.game_achievements a
        WHERE achievement_id IN ('linked_email','saved_recovery_code')) rows;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO security_claim_fingerprint
    FROM (SELECT md5(to_jsonb(a)::text) AS h FROM public.game_achievement_reward_claims a
        WHERE achievement_id IN ('linked_email','saved_recovery_code')) rows;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO mail_fingerprint
    FROM (SELECT md5(to_jsonb(m)::text) AS h FROM public.player_mail_messages m
        WHERE source_key <> 'welcome:v1') rows;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO reset_history_fingerprint
    FROM (SELECT md5(to_jsonb(r)::text) AS h FROM public.gameplay_reset_runs r) rows;
    -- Profile initialization synchronizes notifications. Restore only retained
    -- service-mail events, never old check-in reminders or welcome-gift messages.
    CREATE TEMP TABLE game_reset_service_events ON COMMIT DROP AS
    SELECT e.* FROM public.notification_events e WHERE category = 'mail' AND EXISTS (
        SELECT 1 FROM public.player_mail_messages m WHERE m.user_id=e.user_id
            AND e.source_key='mail:' || m.id::text AND m.source_key <> 'welcome:v1'
    );
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO service_fingerprint
    FROM (SELECT md5(to_jsonb(e)::text) AS h FROM game_reset_service_events e) rows;

    CREATE TEMP TABLE game_reset_service_batches ON COMMIT DROP AS
    SELECT b.* FROM public.notification_batches b WHERE EXISTS (
        SELECT 1 FROM game_reset_service_events e WHERE e.batch_id=b.id AND e.user_id=b.user_id
    );
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO batch_fingerprint
    FROM (SELECT md5(to_jsonb(b)::text) AS h FROM game_reset_service_batches b) rows;

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
    UPDATE public.app_users SET last_check_in_at = NULL WHERE last_check_in_at IS NOT NULL;
    DELETE FROM public.game_achievements WHERE achievement_id NOT IN ('linked_email','saved_recovery_code');
    DELETE FROM public.game_achievement_reward_claims WHERE achievement_id NOT IN ('linked_email','saved_recovery_code');
    DELETE FROM public.player_mail_messages WHERE source_key = 'welcome:v1';
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
    DELETE FROM public.notification_events;
    INSERT INTO public.notification_events SELECT * FROM game_reset_service_events;
    DELETE FROM public.notification_batches WHERE id NOT IN (SELECT id FROM game_reset_service_batches);

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
    FROM (SELECT md5((to_jsonb(u) - 'last_check_in_at')::text) AS h FROM public.app_users u) rows;
    IF fingerprint IS DISTINCT FROM account_fingerprint
        OR EXISTS (SELECT 1 FROM public.app_users WHERE last_check_in_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Preserved table app_users changed outside the check-in timestamp. Game reset rolled back.';
    END IF;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO fingerprint
    FROM (SELECT md5(to_jsonb(a)::text) AS h FROM public.game_achievements a) rows;
    IF fingerprint IS DISTINCT FROM security_fingerprint THEN
        RAISE EXCEPTION 'Security achievement preservation invariant failed. Game reset rolled back.';
    END IF;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO fingerprint
    FROM (SELECT md5(to_jsonb(a)::text) AS h FROM public.game_achievement_reward_claims a) rows;
    IF fingerprint IS DISTINCT FROM security_claim_fingerprint THEN
        RAISE EXCEPTION 'Security reward claim preservation invariant failed. Game reset rolled back.';
    END IF;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO fingerprint
    FROM (SELECT md5(to_jsonb(m)::text) AS h FROM public.player_mail_messages m) rows;
    IF fingerprint IS DISTINCT FROM mail_fingerprint THEN
        RAISE EXCEPTION 'Service mail preservation invariant failed. Game reset rolled back.';
    END IF;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO fingerprint
    FROM (SELECT md5(to_jsonb(e)::text) AS h FROM public.notification_events e) rows;
    IF fingerprint IS DISTINCT FROM service_fingerprint THEN
        RAISE EXCEPTION 'Notification reset invariant failed. Game reset rolled back.';
    END IF;
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO fingerprint
    FROM (SELECT md5(to_jsonb(b)::text) AS h FROM public.notification_batches b) rows;
    IF fingerprint IS DISTINCT FROM batch_fingerprint THEN
        RAISE EXCEPTION 'Service notification batch preservation invariant failed. Game reset rolled back.';
    END IF;
    reset_time := clock_timestamp();
    UPDATE public.gameplay_generations SET generation = previous_generation + 1, reset_at = reset_time WHERE singleton;
    INSERT INTO public.gameplay_reset_runs(reset_id, generation, completed_at)
    VALUES (release_reset_id, previous_generation + 1, reset_time);
    SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) INTO fingerprint
    FROM (SELECT md5(to_jsonb(r)::text) AS h FROM public.gameplay_reset_runs r WHERE reset_id <> release_reset_id) rows;
    IF fingerprint IS DISTINCT FROM reset_history_fingerprint
        OR NOT EXISTS (SELECT 1 FROM public.gameplay_generations WHERE singleton
            AND generation = previous_generation + 1 AND reset_at = reset_time)
        OR NOT EXISTS (SELECT 1 FROM public.gameplay_reset_runs WHERE reset_id = release_reset_id
            AND generation = previous_generation + 1 AND completed_at = reset_time) THEN
        RAISE EXCEPTION 'Reset generation invariant failed. Game reset rolled back.';
    END IF;
    RAISE NOTICE 'Release % fresh start completed. Auth, friends and security achievements preserved; gameplay, check-ins and records cleared.', release_reset_id;
END $$;
COMMIT;
