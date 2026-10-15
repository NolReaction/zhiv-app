CREATE TABLE private_person_nicknames (
  viewer_user_id uuid NOT NULL REFERENCES app_users(id),
  subject_user_id uuid NOT NULL REFERENCES app_users(id),
  nickname varchar(50) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (viewer_user_id, subject_user_id),
  CHECK (viewer_user_id <> subject_user_id),
  CHECK (char_length(btrim(nickname)) BETWEEN 1 AND 50)
);
