package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.identity.CalendarDay
import ru.zhiv.identity.CheckInCalendarSnapshot
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.YearMonth
import javax.sql.DataSource

/** One snapshot binds private history to the current live session. Event dates stay immutable. */
internal suspend fun readCheckInCalendar(
    dataSource: DataSource,
    tokenHash: ByteArray,
    month: YearMonth?,
): CheckInCalendarSnapshot? = withContext(Dispatchers.IO) {
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            WITH viewer AS MATERIALIZED (
                SELECT u.id, u.timezone_id, statement_timestamp() AS server_time,
                       (statement_timestamp() AT TIME ZONE u.timezone_id)::date AS today
                  FROM app_sessions s JOIN app_users u ON u.id = s.user_id
                 WHERE s.token_hash = ? AND s.revoked_at IS NULL
                   AND s.expires_at > statement_timestamp() AND u.deleted_at IS NULL AND u.banned_at IS NULL
            ), bounds AS (
                SELECT v.*, COALESCE(?::date, date_trunc('month', v.today)::date) AS month_start
                  FROM viewer v
            ), history AS MATERIALIZED (
                SELECT h.user_id FROM viewer v
                CROSS JOIN LATERAL account_history_user_ids(v.id) h
            ), ordered_events AS (
                SELECT e.checked_at, lag(e.checked_at) OVER (ORDER BY e.checked_at,e.id) AS previous_at
                FROM history h JOIN check_ins e ON e.user_id=h.user_id CROSS JOIN viewer v
                WHERE e.checked_at<=v.server_time
            ), streak_span AS (
                SELECT max(checked_at) AS last_at,
                       max(checked_at) FILTER (WHERE previous_at IS NULL OR checked_at>previous_at+interval '24 hours') AS started_at
                FROM ordered_events
            ), daily AS (
                SELECT e.local_date, count(*) AS check_in_count
                  FROM history h JOIN check_ins e ON e.user_id = h.user_id
                  CROSS JOIN bounds b
                 WHERE e.local_date >= b.month_start
                   AND e.local_date < (b.month_start + interval '1 month')::date
                   AND e.checked_at <= b.server_time
                 GROUP BY e.local_date
            ), history_bounds AS (
                SELECT min(found.local_date) AS earliest_date, max(latest.local_date) AS latest_date
                  FROM history h LEFT JOIN LATERAL (
                    SELECT e.local_date FROM check_ins e CROSS JOIN viewer v
                     WHERE e.user_id = h.user_id AND e.checked_at <= v.server_time
                     ORDER BY e.local_date, e.checked_at LIMIT 1
                  ) found ON true
                  LEFT JOIN LATERAL (
                    SELECT e.local_date FROM check_ins e CROSS JOIN viewer v
                     WHERE e.user_id = h.user_id AND e.checked_at <= v.server_time
                     ORDER BY e.local_date DESC, e.checked_at DESC LIMIT 1
                  ) latest ON true
            )
            SELECT b.timezone_id, b.today, b.server_time, b.month_start,
                   CASE WHEN b.server_time<=streak_span.last_at+interval '24 hours' THEN streak_span.started_at END AS streak_started_at,
                   history_bounds.earliest_date, history_bounds.latest_date, daily.local_date, daily.check_in_count
              FROM bounds b CROSS JOIN history_bounds CROSS JOIN streak_span LEFT JOIN daily ON true
             ORDER BY daily.local_date
            """.trimIndent(),
        ).use { statement ->
            statement.setBytes(1, tokenHash)
            statement.setObject(2, month?.atDay(1), java.sql.Types.DATE)
            statement.executeQuery().use { result ->
                if (!result.next()) return@withContext null
                val today = result.getObject("today", LocalDate::class.java)
                val selectedMonth = YearMonth.from(result.getObject("month_start", LocalDate::class.java))
                val timeZone = result.getString("timezone_id")
                val serverTime = result.getObject("server_time", OffsetDateTime::class.java)
                val first = result.getObject("earliest_date", LocalDate::class.java) ?: today
                val last = result.getObject("latest_date", LocalDate::class.java) ?: today
                val streakStartedAt = result.getObject("streak_started_at", OffsetDateTime::class.java)
                val days = buildList {
                    do {
                        val date = result.getObject("local_date", LocalDate::class.java)
                        if (date != null) add(CalendarDay(date, result.getLong("check_in_count")))
                    } while (result.next())
                }
                CheckInCalendarSnapshot(selectedMonth, today, timeZone, YearMonth.from(minOf(first, today)), days, serverTime,
                    lastMonth = YearMonth.from(maxOf(last, today)), streakStartedAt = streakStartedAt)
            }
        }
    }
}
