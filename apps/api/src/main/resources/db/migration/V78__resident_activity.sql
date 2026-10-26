-- Reputation ranks and frozen orders remain permanent. Existing profiles get
-- one migration-time favor anchor; reads cannot renew it, and new accounts do
-- not receive this compatibility grant. No wallets, jobs or XP are rewritten.
UPDATE economy_profiles
SET state = jsonb_set(state, '{tradeRelations}',
    coalesce(state->'tradeRelations', '{"version":1}'::jsonb) || jsonb_build_object('activity',
        coalesce((SELECT jsonb_object_agg(entry.key,
            jsonb_build_object('pointsBps', 10000, 'updatedAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
            FROM jsonb_each(coalesce(state->'tradeRelations'->'reputation', '{}'::jsonb)) entry
            WHERE entry.key IN ('plesk','builder','lopukh','kamneshmyg','leaftail')
                AND jsonb_typeof(entry.value) = 'number' AND (entry.value #>> '{}')::numeric > 0), '{}'::jsonb)), true)
WHERE NOT coalesce(state->'tradeRelations', '{}'::jsonb) ? 'activity'
    AND EXISTS (SELECT 1 FROM jsonb_each(coalesce(state->'tradeRelations'->'reputation', '{}'::jsonb)) entry
        WHERE entry.key IN ('plesk','builder','lopukh','kamneshmyg','leaftail')
            AND jsonb_typeof(entry.value) = 'number' AND (entry.value #>> '{}')::numeric > 0);
