-- The economy album is authoritative. Hold writers through the switch and its
-- backfill, so a concurrent claim cannot be lost between those two operations.
LOCK TABLE economy_profiles, game_profiles IN SHARE ROW EXCLUSIVE MODE;

DROP INDEX game_profiles_series_rank_idx;
CREATE INDEX game_profiles_series_rank_idx ON game_profiles(best_series DESC, user_id) WHERE best_series > 0;

DROP TRIGGER game_fishing_visibility_created ON game_profiles;
DROP TRIGGER game_fishing_visibility_changed ON game_profiles;
DROP FUNCTION sync_game_fishing_visibility();

-- Fishing is playable before a tap-game profile exists. Only the economy FK is
-- the record's lifetime boundary. Find the V81 constraint by its target.
DO $$
DECLARE tap_fk name;
BEGIN
    SELECT conname INTO STRICT tap_fk FROM pg_constraint
    WHERE contype = 'f' AND conrelid = 'game_fishing_records'::regclass
        AND confrelid = 'game_profiles'::regclass;
    EXECUTE format('ALTER TABLE game_fishing_records DROP CONSTRAINT %I', tap_fk);
END
$$;

CREATE OR REPLACE FUNCTION sync_confirmed_fishing_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM replace_game_fishing_records(NEW.user_id, NEW.state #> '{boat,records}');
    RETURN NULL;
END
$$;

-- Rebuild once from the delivered catch album. Provisional voyage catches
-- live in a different JSON field until their claim succeeds.
TRUNCATE game_fishing_records;
INSERT INTO game_fishing_records(user_id, fish_id, weight_grams)
SELECT p.user_id, fish.key, (fish.value->>'weightGrams')::integer
FROM economy_profiles p
CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(p.state #> '{boat,records}') = 'object'
        THEN p.state #> '{boat,records}' ELSE '{}'::jsonb END
) fish
WHERE length(fish.key) BETWEEN 1 AND 80
  AND (fish.value->>'weightGrams') ~ '^([1-9][0-9]{0,5}|1000000)$';
