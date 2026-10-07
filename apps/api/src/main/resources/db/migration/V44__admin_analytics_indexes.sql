-- A fishing job has an opaque ID unrelated to its request ID. Save only the
-- public subject and job type when an accepted command consumes the job. Old
-- rows stay unknown; do not infer past actions from today's gameplay snapshot.
ALTER TABLE economy_ledger ADD COLUMN context jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE economy_ledger ADD CONSTRAINT economy_ledger_context_ck CHECK (
    jsonb_typeof(context)='object'
    AND context - 'targetId' - 'originAction' = '{}'::jsonb
    AND octet_length(context::text)<=512
    AND (NOT (context ? 'targetId') OR
        (jsonb_typeof(context->'targetId')='string' AND length(context->>'targetId') BETWEEN 1 AND 80))
    AND (NOT (context ? 'originAction') OR
        (jsonb_typeof(context->'originAction')='string' AND context->>'originAction' IN
            ('start_construction','start_production','start_exploration','start_fishing')))
);

-- Read-only administration aggregates only a bounded time window. The partial
-- index also finds each player's first surviving construction before that window.
CREATE INDEX economy_ledger_period_idx ON economy_ledger(created_at DESC, user_id);
CREATE INDEX economy_ledger_first_construction_idx ON economy_ledger(user_id, created_at, source_key)
    WHERE kind='start_construction';
-- Job references arrive as text. Keep indexed joins without casting historical
-- targets to UUID: non-job command targets are ordinary catalog identifiers.
CREATE INDEX economy_commands_analytics_context_idx ON economy_commands(user_id, (request_id::text));
