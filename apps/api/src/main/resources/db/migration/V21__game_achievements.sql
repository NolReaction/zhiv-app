-- Direct circles exist only after mutual acceptance (ID request or invitation).
-- Sharing check-ins is independent of opting into a game leaderboard.
CREATE FUNCTION active_direct_friend_ids(p_user_id uuid)
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE STRICT AS $fn$
    SELECT peer.id
    FROM circles c
    JOIN app_users peer ON peer.id = CASE WHEN c.direct_user_low_id = p_user_id
        THEN c.direct_user_high_id ELSE c.direct_user_low_id END
    WHERE c.kind = 'DIRECT' AND c.archived_at IS NULL AND peer.deleted_at IS NULL
      AND p_user_id IN (c.direct_user_low_id, c.direct_user_high_id);
$fn$;

CREATE TABLE game_achievements (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    achievement_id varchar(32) NOT NULL,
    unlocked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, achievement_id),
    CONSTRAINT game_achievements_id_ck CHECK (
        achievement_id IN ('seven_day_streak', 'thousand_taps', 'five_friends')
    )
);

-- Existing verified progress earns awards at upgrade time. Dates on the phone
-- and unverified local clicker archives are deliberately not inputs.
INSERT INTO game_achievements(user_id, achievement_id)
SELECT u.id, 'seven_day_streak' FROM app_users u
CROSS JOIN LATERAL rolling_check_in_streak(u.id, statement_timestamp()) s
WHERE u.deleted_at IS NULL AND s.longest_days >= 7
UNION ALL
SELECT p.user_id, 'thousand_taps' FROM game_profiles p
JOIN app_users u ON u.id = p.user_id
WHERE u.deleted_at IS NULL AND p.lifetime_taps >= 1000
UNION ALL
SELECT u.id, 'five_friends' FROM app_users u
WHERE u.deleted_at IS NULL AND (
    SELECT count(*) FROM (SELECT user_id FROM active_direct_friend_ids(u.id) LIMIT 5) friends
) = 5;
