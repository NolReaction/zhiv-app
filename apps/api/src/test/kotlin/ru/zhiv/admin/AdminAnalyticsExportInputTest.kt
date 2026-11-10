package ru.zhiv.admin

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.Base64
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class AdminAnalyticsExportInputTest {
    private val now = Instant.parse("2026-10-07T10:18:20.123456Z")
    private val player = "ABCD-EFGH-JKMN"
    private val query = AdminAnalyticsExportQuery(AdminAnalyticsQuery("2026-10-01", "2026-10-07", player),
        kind = "sell", resource = "wood", direction = "out")

    private fun cursor(query: AdminAnalyticsExportQuery = this.query): AdminAnalyticsExportCursor {
        val resolved = query.resolve(now)
        return AdminAnalyticsExportCursor(snapshotAt = now.toString(), context = resolved.context,
            total = 250_000, createdAt = "2026-10-07T09:00:00.123456Z", userId = UUID.randomUUID().toString(),
            sourceKey = "command:${UUID.randomUUID()}")
    }
    private fun invalid(block: () -> Unit) = assertEquals(400, assertFailsWith<AuthFailure>(block = block).status)

    @Test fun `export ranges fix the first server cutoff and allow larger pages without an offset`() {
        val resolved = query.resolve(now)
        assertEquals(Instant.parse("2026-10-01T00:00:00Z"), resolved.window.startAt)
        assertEquals(now, resolved.window.endAt)
        assertEquals(now, resolved.snapshotAt)
        assertEquals(1000, query.limit)
        assertNull(resolved.previous)
        val historical = query.copy(query = query.query.copy(to = "2026-10-02")).resolve(now)
        assertEquals(Instant.parse("2026-10-03T00:00:00Z"), historical.window.endAt)
    }

    @Test fun `all saved history requires an exact player and ignores selected calendar dates`() {
        val resolved = query.copy(query = AdminAnalyticsQuery("not-a-date", "also-ignored", player.lowercase(), "all"), allTime = true).resolve(now)
        assertEquals("0001-01-01", resolved.window.from.toString())
        assertEquals("2026-10-07", resolved.window.to.toString())
        assertEquals(Instant.parse("0001-01-01T00:00:00Z"), resolved.window.startAt)
        assertEquals(now, resolved.window.endAt)
        assertEquals(player, resolved.window.q)
        assertEquals("all", resolved.window.scope)
        for (search in listOf("", "Мохлик", "ABCD-EFGH", "ABCD-EFGH-JKMN-extra"))
            invalid { query.copy(query = AdminAnalyticsQuery(q = search), allTime = true).resolve(now) }
    }

    @Test fun `export keeps existing resource operation scope and date validation`() {
        for (bad in listOf(query.copy(limit = 0), query.copy(limit = 1001), query.copy(kind = "sell';--"),
            query.copy(resource = "WOOD"), query.copy(direction = "negative"), query.copy(query = query.query.copy(scope = "admin")),
            query.copy(query = query.query.copy(q = "x".repeat(101))), query.copy(query = query.query.copy(q = "Мох\nлик")),
            query.copy(query = AdminAnalyticsQuery("2025-10-06", "2026-10-07")))) invalid { bad.resolve(now) }
    }

    @Test fun `cursor retains microsecond tuple total above journal offset cap and frozen window`() {
        val saved = cursor()
        val resolved = query.copy(cursor = encodeAdminAnalyticsExportCursor(saved), limit = 1).resolve(now.plusSeconds(86400))
        assertEquals(saved, resolved.previous)
        assertEquals(now, resolved.snapshotAt)
        assertEquals(now, resolved.window.endAt)
        assertEquals(250_000L, resolved.previous!!.total)
        assertEquals("2026-10-07T09:00:00.123456Z", resolved.previous.createdAt)
    }

    @Test fun `cursor cannot be reused for another player range scope operation resource or direction`() {
        val saved = encodeAdminAnalyticsExportCursor(cursor())
        for (other in listOf(query.copy(query = query.query.copy(q = "PQRS-TVWX-YZ12")),
            query.copy(query = query.query.copy(from = "2026-10-02")), query.copy(query = query.query.copy(to = "2026-10-06")),
            query.copy(query = query.query.copy(scope = "all")), query.copy(kind = "market_sell"), query.copy(resource = "coins"),
            query.copy(direction = "in"), query.copy(allTime = true))) invalid { other.copy(cursor = saved).resolve(now) }
    }

    @Test fun `malformed cursors and impossible tuple boundaries are rejected before any database read`() {
        for (bad in listOf("", "not+url/safe", "a".repeat(4097), "a", Base64.getUrlEncoder().withoutPadding().encodeToString(byteArrayOf(-1))))
            invalid { query.copy(cursor = bad).resolve(now) }
        val saved = cursor()
        for (bad in listOf(saved.copy(version = 2), saved.copy(snapshotAt = now.plusSeconds(1).toString()),
            saved.copy(context = "0".repeat(64)), saved.copy(total = -1), saved.copy(total = 9_007_199_254_740_992L),
            saved.copy(createdAt = "2026-09-30T23:59:59Z"), saved.copy(createdAt = now.toString()),
            saved.copy(createdAt = "not-an-instant"), saved.copy(userId = "1-1-1-1-1"),
            saved.copy(sourceKey = ""), saved.copy(sourceKey = "x".repeat(513)), saved.copy(sourceKey = "line\nbreak")))
            invalid { query.copy(cursor = encodeAdminAnalyticsExportCursor(bad)).resolve(now) }
    }
}
