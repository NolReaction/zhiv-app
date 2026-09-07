package ru.zhiv.identity

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.YearMonth

class TimeZoneTest {
    @Test fun `next day starts at the first midnight when midnight repeats`() {
        val calendar = CheckInCalendarSnapshot(
            month = YearMonth.of(2026, 10), today = LocalDate.of(2026, 10, 31),
            timeZone = "America/Havana", firstMonth = YearMonth.of(2026, 10), days = emptyList(),
            serverTime = OffsetDateTime.parse("2026-10-31T12:00:00Z"),
        )
        assertEquals(OffsetDateTime.parse("2026-11-01T04:00:00Z").toInstant(), calendar.nextDayAt.toInstant())
    }

    @Test fun `timezone validation accepts IANA regions but rejects offsets and malformed names`() {
        for (zone in listOf("UTC", "Europe/Moscow", "Europe/Berlin", "Asia/Kathmandu", "Pacific/Kiritimati", "America/New_York", "Etc/GMT+12")) {
            assertEquals(zone, validTimeZone(zone))
        }
        for (zone in listOf("", " Europe/Moscow", "Europe/Moscow\n", "+03:00", "UTC+03:00", "GMT+3", "Not/AZone", "SystemV/EST5", "A".repeat(65))) {
            assertNull(validTimeZone(zone))
        }
    }
}
