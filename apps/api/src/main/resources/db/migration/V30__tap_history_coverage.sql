-- Only the migration role can read Flyway's journal. Expose the single collection
-- timestamp needed by the runtime without granting it access to migration history.
CREATE TABLE game_tap_collection_metadata (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    started_at timestamptz NOT NULL
);

INSERT INTO game_tap_collection_metadata(singleton, started_at)
SELECT true, COALESCE(
    (SELECT installed_on::timestamptz FROM flyway_schema_history WHERE version='28' AND success),
    clock_timestamp()
);
