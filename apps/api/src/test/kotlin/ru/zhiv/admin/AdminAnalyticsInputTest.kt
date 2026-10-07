package ru.zhiv.admin

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class AdminAnalyticsInputTest {
    private val now = Instant.parse("2026-10-07T10:18:20Z")

    @Test fun `calendar ranges use UTC include the final day and cap today at server time`() {
        val defaults = AdminAnalyticsQuery().resolve(now)
        assertEquals("2026-09-08", defaults.from.toString())
        assertEquals(now, defaults.endAt)
        val historic = AdminAnalyticsQuery("2026-10-01", "2026-10-02", "  Мохлик  ", "all").resolve(now)
        assertEquals(Instant.parse("2026-10-01T00:00:00Z"),historic.startAt)
        assertEquals(Instant.parse("2026-10-03T00:00:00Z"),historic.endAt)
        assertEquals("Мохлик",historic.q)
        assertEquals("2025-10-07",AdminAnalyticsQuery("2025-10-07","2026-10-07").resolve(now).from.toString())
    }

    @Test fun `invalid dates scopes controls and unbounded ranges are rejected`() {
        val queries = listOf(
            AdminAnalyticsQuery("2026-10-07"), AdminAnalyticsQuery(to="2026-10-07"),
            AdminAnalyticsQuery("2026-2-01","2026-10-07"), AdminAnalyticsQuery("2026-02-30","2026-10-07"),
            AdminAnalyticsQuery("2026-10-07","2026-10-08"),AdminAnalyticsQuery("2026-10-07","2026-10-06"),
            AdminAnalyticsQuery("2025-10-06","2026-10-07"),AdminAnalyticsQuery(q="x".repeat(101)),
            AdminAnalyticsQuery(q="Мох\nлик"),AdminAnalyticsQuery(scope="admin"),
        )
        queries.forEach { assertEquals(400,assertFailsWith<AuthFailure> { it.resolve(now) }.status) }
    }

    @Test fun `journal filters remain bounded and pagination anchor can only narrow its period`() {
        val query = AdminAnalyticsQuery("2026-10-01","2026-10-07")
        val events = AdminAnalyticsEventsQuery(query,resource="wood",direction="out",at="2026-10-06T16:00:00Z")
        assertEquals(Instant.parse("2026-10-06T16:00:00Z"),events.resolve(now).endAt)
        listOf(events.copy(kind="sell';--"),events.copy(resource="WOOD"),events.copy(direction="negative"),
            events.copy(offset=-1),events.copy(offset=100001),events.copy(limit=0),events.copy(limit=101),
            events.copy(at="not-a-time"),events.copy(at="2026-09-30T23:59:59Z"),events.copy(at="2026-10-07T10:18:21Z"))
            .forEach { assertEquals(400,assertFailsWith<AuthFailure> { it.resolve(now) }.status) }
        assertEquals(Instant.parse("2026-10-02T00:00:00Z"),events.copy(query=AdminAnalyticsQuery("2026-10-01","2026-10-01")).resolve(now).endAt)
    }
}
