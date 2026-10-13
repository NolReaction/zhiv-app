ALTER TABLE app_users
    ADD COLUMN display_name_changed_at timestamptz,
    ADD COLUMN display_name_change_key uuid,
    ADD COLUMN avatar_storage_key varchar(512),
    ADD COLUMN avatar_updated_at timestamptz,
    ADD CONSTRAINT app_users_display_name_change_state_ck CHECK (
        (display_name_changed_at IS NULL) = (display_name_change_key IS NULL)
        AND (
            display_name_changed_at IS NULL
            OR display_name_changed_at BETWEEN created_at AND updated_at
        )
    ),
    ADD CONSTRAINT app_users_avatar_state_ck CHECK (
        (avatar_storage_key IS NULL AND avatar_updated_at IS NULL)
        OR (
            avatar_storage_key IS NOT NULL
            AND char_length(avatar_storage_key) BETWEEN 1 AND 512
            AND avatar_storage_key = btrim(avatar_storage_key)
            AND avatar_storage_key !~ '[[:cntrl:]]'
            AND avatar_updated_at IS NOT NULL
            AND avatar_updated_at BETWEEN created_at AND updated_at
        )
    );

ALTER TABLE check_ins
    ADD CONSTRAINT check_ins_local_date_value_ck CHECK (
        local_date = (checked_at AT TIME ZONE timezone_id)::date
    );

CREATE FUNCTION daily_check_in_streak(
    p_user_id uuid,
    p_server_time timestamptz,
    p_timezone_id varchar
) RETURNS TABLE (
    current_days bigint,
    longest_days bigint,
    checked_in_today boolean,
    next_day_at timestamptz
)
LANGUAGE sql STABLE STRICT AS $$
WITH local_clock AS (
    SELECT (p_server_time AT TIME ZONE p_timezone_id)::date AS today
),
days AS (
    SELECT DISTINCT event.local_date
      FROM check_ins event
      CROSS JOIN local_clock clock
     WHERE event.user_id = p_user_id
       AND event.local_date <= clock.today
),
numbered AS (
    SELECT local_date,
           row_number() OVER (ORDER BY local_date) AS asc_no,
           row_number() OVER (ORDER BY local_date DESC) AS desc_no,
           max(local_date) OVER () AS latest_date
      FROM days
),
runs AS (
    SELECT count(*)::bigint AS length
      FROM numbered
     GROUP BY local_date - asc_no::integer
)
SELECT
    CASE
        WHEN max(numbered.latest_date) IS NULL
          OR max(numbered.latest_date) < local_clock.today - 1
        THEN 0
        ELSE count(*) FILTER (
            WHERE numbered.local_date =
                numbered.latest_date - (numbered.desc_no::integer - 1)
        )
    END::bigint AS current_days,
    COALESCE((SELECT max(length) FROM runs), 0) AS longest_days,
    COALESCE(bool_or(numbered.local_date = local_clock.today), false) AS checked_in_today,
    ((local_clock.today + 1)::timestamp AT TIME ZONE p_timezone_id) AS next_day_at
FROM local_clock
LEFT JOIN numbered ON TRUE
GROUP BY local_clock.today;
$$;
