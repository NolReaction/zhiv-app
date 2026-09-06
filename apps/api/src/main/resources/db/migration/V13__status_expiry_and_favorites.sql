ALTER TABLE app_users ADD COLUMN status_expires_at timestamptz;
ALTER TABLE app_users ADD CONSTRAINT app_users_status_expiry CHECK (
  status_expires_at IS NULL OR (status_text IS NOT NULL AND status_updated_at IS NOT NULL AND status_expires_at > status_updated_at)
);
ALTER TABLE user_status_write_keys ADD COLUMN expires_in_minutes integer;
ALTER TABLE user_status_write_keys ADD CONSTRAINT user_status_duration CHECK (
  expires_in_minutes IS NULL OR (status_text <> '' AND expires_in_minutes IN (60, 120, 240, 480, 1440))
);
CREATE TABLE direct_person_favorites (
  user_id uuid NOT NULL REFERENCES app_users(id),
  circle_id uuid NOT NULL REFERENCES circles(id),
  PRIMARY KEY(user_id, circle_id)
);
