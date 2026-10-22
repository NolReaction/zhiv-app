-- Terminal guide decisions are account preferences, not proof for reward claims.
CREATE TABLE onboarding_progress (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    course text NOT NULL CHECK (course IN ('app', 'world')),
    status text NOT NULL CHECK (status IN ('completed', 'skipped')),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, course)
);
-- Existing paid courses must not be offered again on another device.
INSERT INTO onboarding_progress(user_id, course, status, updated_at)
SELECT user_id, course, 'completed', onboarding_claimed_at
FROM game_daily_rewards CROSS JOIN (VALUES ('app'), ('world')) AS courses(course)
WHERE onboarding_claimed_at IS NOT NULL;
