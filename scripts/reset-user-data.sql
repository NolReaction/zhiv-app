\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
    user_tables text[] := ARRAY[
        'account_action_proofs', 'account_group_owner_transfers', 'account_identity_retirements',
        'account_login_flows', 'account_login_identities', 'account_merge_previews',
        'account_merge_sources', 'account_operation_receipts', 'account_recovery_attempts',
        'account_recovery_codes', 'account_recovery_contact_removals', 'account_recovery_contacts',
        'account_registration_tickets', 'admin_actions', 'app_sessions', 'app_users', 'check_in_audiences',
        'check_ins', 'circle_invites', 'circle_memberships', 'circle_sharing_preferences',
        'circles', 'direct_invite_links', 'direct_invite_redemptions', 'direct_person_favorites', 'direct_requests',
        'game_achievements', 'game_items', 'game_monthly_scores', 'game_profiles', 'game_sessions', 'game_tap_activity_minutes', 'game_tap_activity_seconds',
        'identity_bootstrap_keys', 'player_feedback', 'player_feedback_actions', 'private_person_nicknames', 'recipient_sharing_preferences',
        'user_incidents', 'user_status_write_keys', 'user_timezone_write_keys', 'world_commands', 'world_ledger', 'world_profiles'
    ];
    expected_tables text[];
    actual_tables text[];
    table_name text;
    remaining bigint;
    migration_history jsonb;
    collection_metadata jsonb;
BEGIN
    SELECT array_agg(name ORDER BY name COLLATE "C") INTO expected_tables
    FROM unnest(user_tables || ARRAY['game_tap_collection_metadata']) AS t(name);
    SELECT array_agg(tablename::text ORDER BY tablename COLLATE "C") INTO actual_tables
    FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'flyway_schema_history';
    IF actual_tables IS DISTINCT FROM expected_tables THEN
        RAISE EXCEPTION 'Unexpected application tables. Reset cancelled; review the schema first.';
    END IF;
    IF (SELECT version FROM public.flyway_schema_history ORDER BY installed_rank DESC LIMIT 1) IS DISTINCT FROM '30'
        OR EXISTS (SELECT 1 FROM public.flyway_schema_history WHERE NOT success) THEN
        RAISE EXCEPTION 'Expected successfully applied migration V30. Reset cancelled.';
    END IF;
    SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank) INTO migration_history
    FROM public.flyway_schema_history h;
    IF (SELECT count(*) FROM public.game_tap_collection_metadata) <> 1
        OR NOT EXISTS (SELECT 1 FROM public.game_tap_collection_metadata WHERE singleton AND started_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Expected the V30 collection metadata singleton. Reset cancelled.';
    END IF;
    SELECT jsonb_agg(to_jsonb(m) ORDER BY singleton) INTO collection_metadata
    FROM public.game_tap_collection_metadata m;

    EXECUTE 'TRUNCATE TABLE ' || (
        SELECT string_agg(format('public.%I', name), ', ') FROM unnest(user_tables) AS t(name)
    ) || ' RESTART IDENTITY RESTRICT';

    FOREACH table_name IN ARRAY user_tables LOOP
        EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO remaining;
        IF remaining <> 0 THEN
            RAISE EXCEPTION 'Table % is not empty. Reset rolled back.', table_name;
        END IF;
    END LOOP;
    IF migration_history IS DISTINCT FROM (
        SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank) FROM public.flyway_schema_history h
    ) THEN
        RAISE EXCEPTION 'Migration history changed. Reset rolled back.';
    END IF;
    IF collection_metadata IS DISTINCT FROM (
        SELECT jsonb_agg(to_jsonb(m) ORDER BY singleton) FROM public.game_tap_collection_metadata m
    ) THEN
        RAISE EXCEPTION 'Collection metadata changed. Reset rolled back.';
    END IF;
    RAISE NOTICE 'All % user-data tables are empty. Migration history and collection metadata are preserved.', cardinality(user_tables);
END $$;
COMMIT;
