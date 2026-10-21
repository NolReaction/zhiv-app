-- A basket is one accepted action for up to three production jobs. Keep its
-- public attribution without permitting arbitrary/private payloads in the ledger.
-- Published V44 and B49 remain unchanged for existing Flyway histories.
ALTER TABLE public.economy_ledger DROP CONSTRAINT economy_ledger_context_ck;
ALTER TABLE public.economy_ledger ADD CONSTRAINT economy_ledger_context_ck CHECK (
    jsonb_typeof(context) = 'object'
    AND octet_length(context::text) <= 512
    AND (NOT (context ? 'targetId') OR
        (jsonb_typeof(context->'targetId') = 'string' AND length(context->>'targetId') BETWEEN 1 AND 80))
    AND (NOT (context ? 'originAction') OR
        (jsonb_typeof(context->'originAction') = 'string' AND context->>'originAction' IN
            ('start_construction', 'start_production', 'start_exploration', 'start_fishing')))
    AND (
        context - 'targetId' - 'originAction' = '{}'::jsonb
        OR (
            kind IN ('start_garden_collection', 'claim_garden_collection')
            AND context ?& ARRAY['targetId', 'originAction', 'batchId', 'jobIds', 'recipeIds']
            AND context - 'targetId' - 'originAction' - 'batchId' - 'jobIds' - 'recipeIds' = '{}'::jsonb
            AND context->>'targetId' = 'garden'
            AND context->>'originAction' = 'start_production'
            AND jsonb_typeof(context->'batchId') = 'string'
            AND context->>'batchId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND jsonb_typeof(context->'jobIds') = 'string'
            AND context->>'jobIds' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}){0,2}$'
            AND jsonb_typeof(context->'recipeIds') = 'string'
            AND context->>'recipeIds' ~ '^[a-z0-9_]{1,80}(,[a-z0-9_]{1,80}){0,2}$'
            AND cardinality(string_to_array(context->>'jobIds', ',')) = cardinality(string_to_array(context->>'recipeIds', ','))
        )
    )
);
