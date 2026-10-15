-- One-way, audited conversion from the retired beta wallet. No old rows or
-- cosmetics are deleted. New accounts start with free renewable activities.
CREATE TABLE economy_profiles (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
    state jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((state->>'schemaVersion' = '1') IS TRUE),
    CHECK ((jsonb_typeof(state->'wallet') = 'object') IS TRUE),
    CHECK (((state->'wallet'->>'coins')::bigint BETWEEN 0 AND 1000000000) IS TRUE),
    CHECK (((state->'wallet'->>'pearls')::bigint BETWEEN 0 AND 1000000000) IS TRUE),
    CHECK ((jsonb_typeof(state->'inventory') = 'object') IS TRUE),
    CHECK ((jsonb_typeof(state->'buildings') = 'object') IS TRUE),
    CHECK ((jsonb_typeof(state->'jobs') = 'array' AND jsonb_array_length(state->'jobs') <= 16) IS TRUE)
);
CREATE TABLE economy_commands (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    signature text NOT NULL,
    message text NOT NULL,
    accepted_revision bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id, request_id)
);
CREATE TABLE economy_ledger (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    source_key text NOT NULL,
    kind text NOT NULL,
    coins bigint NOT NULL DEFAULT 0,
    items jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id, source_key)
);
CREATE INDEX economy_ledger_history ON economy_ledger(user_id, created_at DESC);
CREATE TABLE economy_conversion_audit (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    legacy_sparks bigint NOT NULL CHECK (legacy_sparks >= 0),
    legacy_wood bigint NOT NULL CHECK (legacy_wood >= 0),
    legacy_stone bigint NOT NULL CHECK (legacy_stone >= 0),
    coins_granted bigint NOT NULL CHECK (coins_granted BETWEEN 0 AND 500),
    wood_granted bigint NOT NULL CHECK (wood_granted BETWEEN 0 AND 30),
    stone_granted bigint NOT NULL CHECK (stone_granted BETWEEN 0 AND 30),
    converted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Frozen migration version. Future balance tuning must never alter this formula.
CREATE FUNCTION economy_v1_initial_state(legacy jsonb) RETURNS jsonb
LANGUAGE SQL IMMUTABLE AS $$
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

INSERT INTO economy_profiles(user_id,state)
SELECT user_id,economy_v1_initial_state(state) FROM world_profiles;
INSERT INTO economy_conversion_audit(user_id,legacy_sparks,legacy_wood,legacy_stone,coins_granted,wood_granted,stone_granted)
SELECT w.user_id,(w.state->'resources'->>'sparks')::bigint,(w.state->'resources'->>'wood')::bigint,(w.state->'resources'->>'stone')::bigint,
       (e.state->'migration'->>'coinsGranted')::bigint,(e.state->'migration'->>'woodGranted')::bigint,(e.state->'migration'->>'stoneGranted')::bigint
FROM world_profiles w JOIN economy_profiles e ON e.user_id=w.user_id;
INSERT INTO economy_ledger(user_id,source_key,kind,coins,items)
SELECT user_id,'conversion:v1','legacy_conversion',(state->'wallet'->>'coins')::bigint,state->'inventory' FROM economy_profiles;
UPDATE world_profiles SET state=jsonb_set(state,'{resources}','{"sparks":0,"wood":0,"stone":0}'::jsonb),
    revision=least(9007199254740991,revision+1),updated_at=clock_timestamp();
