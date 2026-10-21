CREATE FUNCTION rolling_check_in_streak(
    p_user_id uuid,
    p_server_time timestamptz
) RETURNS TABLE (
    current_days bigint,
    longest_days bigint,
    is_active boolean,
    renew_by timestamptz
)
LANGUAGE sql STABLE STRICT AS $fn$
WITH ordered AS (
    SELECT event.checked_at,
           lag(event.checked_at) OVER (ORDER BY event.checked_at) AS previous_at
      FROM check_ins event
     WHERE event.user_id = p_user_id
       AND event.checked_at <= p_server_time
), tagged AS (
    SELECT checked_at,
           CASE WHEN previous_at IS NULL
                     OR checked_at > previous_at + interval '24 hours'
                THEN 1 ELSE 0 END AS starts_run
      FROM ordered
), numbered AS (
    SELECT checked_at,
           sum(starts_run) OVER (
               ORDER BY checked_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS run_no
      FROM tagged
), runs AS (
    SELECT run_no,
           min(checked_at) AS started_at,
           max(checked_at) AS last_at,
           (floor(extract(epoch FROM (max(checked_at) - min(checked_at))) / 86400) + 1)::bigint AS day_count
      FROM numbered
     GROUP BY run_no
), summary AS (
    SELECT coalesce(max(day_count), 0)::bigint AS longest_days FROM runs
), latest AS (
    SELECT last_at, day_count FROM runs ORDER BY run_no DESC LIMIT 1
)
SELECT CASE WHEN latest.last_at IS NOT NULL
                  AND p_server_time <= latest.last_at + interval '24 hours'
            THEN latest.day_count ELSE 0 END::bigint AS current_days,
       summary.longest_days,
       coalesce(p_server_time <= latest.last_at + interval '24 hours', false) AS is_active,
       CASE WHEN latest.last_at IS NOT NULL
                  AND p_server_time <= latest.last_at + interval '24 hours'
            THEN latest.last_at + interval '24 hours' END AS renew_by
  FROM summary
  LEFT JOIN latest ON true;
$fn$;

COMMENT ON FUNCTION rolling_check_in_streak(uuid, timestamptz) IS
    'Timezone-free rolling check-in streak. Consecutive accepted events may be at most 24 hours apart.';
