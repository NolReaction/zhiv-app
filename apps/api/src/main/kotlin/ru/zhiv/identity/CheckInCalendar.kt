package ru.zhiv.identity

import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.YearMonth

data class CalendarDay(val date: LocalDate, val count: Long)

data class CheckInCalendarSnapshot(
    val month: YearMonth,
    val today: LocalDate,
    val timeZone: String,
    val firstMonth: YearMonth,
    val days: List<CalendarDay>,
    val serverTime: OffsetDateTime,
    val nextDayAt: OffsetDateTime = today.plusDays(1).atStartOfDay(java.time.ZoneId.of(timeZone)).toOffsetDateTime(),
    val lastMonth: YearMonth = YearMonth.from(today),
)

fun parseCalendarMonth(value: String): YearMonth? {
    if (!Regex("^[0-9]{4}-(0[1-9]|1[0-2])$").matches(value) || value.startsWith("0000")) return null
    return runCatching { YearMonth.parse(value) }.getOrNull()
}
