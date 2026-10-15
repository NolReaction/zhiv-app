ALTER TABLE game_profiles ADD COLUMN writer_session_id uuid REFERENCES game_sessions(id) ON DELETE SET NULL;
ALTER TABLE game_profiles ADD COLUMN writer_until timestamptz;
ALTER TABLE game_sessions ADD COLUMN closed_at timestamptz;
ALTER TABLE game_sessions ADD COLUMN last_tap_times bigint[];
ALTER TABLE game_sessions ADD COLUMN last_rejection_code varchar(64);

CREATE TABLE user_incidents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('client','server')),
  operation varchar(100) NOT NULL,
  code varchar(64) NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id uuid,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  pending_taps integer NOT NULL DEFAULT 0 CHECK (pending_taps BETWEEN 0 AND 100000),
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences BETWEEN 1 AND 100000),
  UNIQUE(user_id,event_id)
);
CREATE INDEX user_incidents_received ON user_incidents(received_at DESC,id DESC);
CREATE INDEX user_incidents_owner_received ON user_incidents(user_id,received_at DESC);

ALTER TABLE game_sessions ADD COLUMN event_tokens double precision NOT NULL DEFAULT 60 CHECK (event_tokens BETWEEN 0 AND 60);
ALTER TABLE game_sessions ADD COLUMN event_updated_at timestamptz;
-- Delivery and event time have different bounds. Keep all other V20 constraints intact.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='game_sessions'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%last_batch_at >= created_at%'
  LOOP EXECUTE format('ALTER TABLE game_sessions DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE game_sessions ADD CONSTRAINT game_delivery_time CHECK (
  last_batch_at IS NULL OR (last_batch_at >= created_at AND last_batch_at <= expires_at + interval '2 days'));

CREATE INDEX game_profiles_writer_session ON game_profiles(writer_session_id) WHERE writer_session_id IS NOT NULL;
