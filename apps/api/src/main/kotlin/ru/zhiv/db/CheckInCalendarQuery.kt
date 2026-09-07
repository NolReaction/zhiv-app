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
                   AND s.expires_at > statement_timestamp() AND u.deleted_at IS NULL
            ), bounds AS (
                SELECT v.*, COALESCE(?::date, date_trunc('month', v.today)::date) AS month_start
                  FROM viewer v
            ), history AS MATERIALIZED (
                SELECT h.user_id FROM viewer v
                CROSS JOIN LATERAL account_history_user_ids(v.id) h
            ), daily AS (
                SELECT e.local_date, count(*) AS check_in_count
                  FROM history h JOIN check_ins e ON e.user_id = h.user_id
                  CROSS JOIN bounds b
                 WHERE e.local_date >= b.month_start
                   AND e.local_date < (b.month_start + interval '1 month')::date
                   AND e.checked_at <= b.server_time
                 GROUP BY e.local_date
            ), first_day AS (
                SELECT min(found.local_date) AS earliest_date
                  FROM history h LEFT JOIN LATERAL (
                    SELECT e.local_date FROM check_ins e CROSS JOIN viewer v
                     WHERE e.user_id = h.user_id AND e.checked_at <= v.server_time
                     ORDER BY e.local_date, e.checked_at LIMIT 1
                  ) found ON true
            )
            SELECT b.timezone_id, b.today, b.server_time, b.month_start,
                   first_day.earliest_date, daily.local_date, daily.check_in_count
              FROM bounds b CROSS JOIN first_day LEFT JOIN daily ON true
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
                val days = buildList {
                    do {
                        val date = result.getObject("local_date", LocalDate::class.java)
                        if (date != null) add(CalendarDay(date, result.getLong("check_in_count")))
                    } while (result.next())
                }
                CheckInCalendarSnapshot(selectedMonth, today, timeZone, YearMonth.from(first), days, serverTime)
            }
        }
    }
}
