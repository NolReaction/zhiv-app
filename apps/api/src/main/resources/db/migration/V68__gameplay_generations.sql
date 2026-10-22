-- Schema only: ordinary deployments never reset player data. The maintenance
-- reset records its fixed release ID and advances this generation atomically.
CREATE TABLE gameplay_generations (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740990),
    reset_at timestamptz,
    CHECK ((generation = 0) = (reset_at IS NULL))
);
INSERT INTO gameplay_generations(singleton) VALUES (true);

CREATE TABLE gameplay_reset_runs (
    reset_id text PRIMARY KEY CHECK (length(reset_id) BETWEEN 1 AND 80),
    generation bigint NOT NULL UNIQUE CHECK (generation BETWEEN 1 AND 9007199254740990),
    completed_at timestamptz NOT NULL
);

-- Friend relationships survive a game reset. Their pre-reset history must not
-- immediately recreate the five-friends achievement in the fresh game.
CREATE FUNCTION gameplay_friend_count(p_user_id uuid) RETURNS bigint
LANGUAGE sql STABLE STRICT AS $$
    SELECT count(*) FROM (
        SELECT c.id
        FROM circles c
        JOIN app_users peer ON peer.id = CASE WHEN c.direct_user_low_id = p_user_id
            THEN c.direct_user_high_id ELSE c.direct_user_low_id END
        CROSS JOIN gameplay_generations g
        WHERE c.kind = 'DIRECT' AND c.archived_at IS NULL AND peer.deleted_at IS NULL
            AND p_user_id IN (c.direct_user_low_id, c.direct_user_high_id)
            AND (g.reset_at IS NULL OR c.created_at >= g.reset_at)
        LIMIT 5
    ) friends;
$$;
