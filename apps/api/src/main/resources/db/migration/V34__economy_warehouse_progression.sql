-- Keep the audited v1 conversion frozen. New accounts gain only a basic warehouse,
-- not another currency/material grant; existing house/workshop progress is preserved.
CREATE FUNCTION economy_v2_initial_state(legacy jsonb) RETURNS jsonb
LANGUAGE SQL IMMUTABLE AS $$
    SELECT jsonb_set(initial, '{buildings}',
        jsonb_build_object('warehouse', 1, 'kiln', 0) || (initial->'buildings'))
    FROM (SELECT economy_v1_initial_state(legacy) AS initial) converted
$$;

-- Existing stock may exceed the new capacity and must never be truncated. Running
-- v1 jobs keep their original costs, rewards and finish time. New capacity only
-- prevents further inflows until the player spends/sells stock or upgrades storage.
UPDATE economy_profiles
SET state = jsonb_set(state, '{buildings}',
        jsonb_build_object('warehouse', 1, 'kiln', 0) || (state->'buildings')),
    revision = least(9007199254740991, revision + 1),
    updated_at = clock_timestamp()
WHERE NOT (state->'buildings' ? 'warehouse') OR NOT (state->'buildings' ? 'kiln');
