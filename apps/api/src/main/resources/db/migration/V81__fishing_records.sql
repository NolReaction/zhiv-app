ALTER TABLE game_profiles
    ADD COLUMN fishing_leaderboard_opt_in boolean NOT NULL DEFAULT false,
    ADD COLUMN fishing_visibility_version bigint NOT NULL DEFAULT 0
        CHECK (fishing_visibility_version BETWEEN 0 AND 9007199254740991);

-- Only shared records are materialized. Turning sharing on seeds the index from
-- the current confirmed album, including catches made before this migration.
CREATE TABLE game_fishing_records (
    user_id uuid NOT NULL REFERENCES game_profiles(user_id) ON DELETE CASCADE
        REFERENCES economy_profiles(user_id) ON DELETE CASCADE,
    fish_id text NOT NULL CHECK (length(fish_id) BETWEEN 1 AND 80),
    weight_grams integer NOT NULL CHECK (weight_grams BETWEEN 1 AND 1000000),
    PRIMARY KEY (user_id, fish_id)
);
CREATE INDEX game_fishing_records_by_weight ON game_fishing_records(fish_id, weight_grams DESC, user_id);

CREATE FUNCTION replace_game_fishing_records(owner_id uuid, records jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM game_fishing_records WHERE user_id = owner_id;
    IF jsonb_typeof(records) = 'object' THEN
        INSERT INTO game_fishing_records(user_id, fish_id, weight_grams)
        SELECT owner_id, f.key, (f.value->>'weightGrams')::integer
        FROM jsonb_each(records) AS f
        WHERE length(f.key) BETWEEN 1 AND 80
          AND (f.value->>'weightGrams') ~ '^([1-9][0-9]{0,5}|1000000)$';
    END IF;
END
$$;

CREATE FUNCTION sync_game_fishing_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE records jsonb;
BEGIN
    IF NEW.fishing_leaderboard_opt_in THEN
        SELECT state #> '{boat,records}' INTO records FROM economy_profiles WHERE user_id = NEW.user_id;
    END IF;
    PERFORM replace_game_fishing_records(NEW.user_id, records);
    RETURN NULL;
END
$$;

CREATE TRIGGER game_fishing_visibility_changed AFTER UPDATE OF fishing_leaderboard_opt_in ON game_profiles
FOR EACH ROW WHEN (OLD.fishing_leaderboard_opt_in IS DISTINCT FROM NEW.fishing_leaderboard_opt_in)
EXECUTE FUNCTION sync_game_fishing_visibility();
CREATE TRIGGER game_fishing_visibility_created AFTER INSERT ON game_profiles
FOR EACH ROW WHEN (NEW.fishing_leaderboard_opt_in) EXECUTE FUNCTION sync_game_fishing_visibility();

CREATE FUNCTION sync_confirmed_fishing_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM game_profiles WHERE user_id = NEW.user_id AND fishing_leaderboard_opt_in) THEN
        PERFORM replace_game_fishing_records(NEW.user_id, NEW.state #> '{boat,records}');
    END IF;
    RETURN NULL;
END
$$;

-- A cast, provisional catch or inventory sale cannot publish a new record.
CREATE TRIGGER confirmed_fishing_records_changed AFTER UPDATE OF state ON economy_profiles
FOR EACH ROW WHEN ((OLD.state #> '{boat,records}') IS DISTINCT FROM (NEW.state #> '{boat,records}'))
EXECUTE FUNCTION sync_confirmed_fishing_records();
CREATE TRIGGER confirmed_fishing_records_created AFTER INSERT ON economy_profiles
FOR EACH ROW WHEN ((NEW.state #> '{boat,records}') IS NOT NULL)
EXECUTE FUNCTION sync_confirmed_fishing_records();
