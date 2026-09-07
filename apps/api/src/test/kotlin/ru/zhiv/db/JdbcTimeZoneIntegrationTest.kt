package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.config.AppConfig
import ru.zhiv.identity.InvalidTimeZoneException
import ru.zhiv.identity.TimeZoneUpdateResult
import ru.zhiv.security.TokenCodec
import java.sql.SQLException
import java.time.ZoneId
import java.time.YearMonth
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcTimeZoneIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var repository: JdbcZhivRepository
    private val tokens = TokenCodec()

    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")))
        DatabaseFactory.migrate(source)
        repository = JdbcZhivRepository(source)
    }
    @AfterAll fun close() { source.close() }

    @Test fun `new bootstrap uses supplied timezone and retries preserve the original choice`() = runBlocking<Unit> {
        val key = tokens.issue().hash; val first = tokens.issue(); val retry = tokens.issue()
        val created = repository.bootstrap("Timezone", key, first.hash, 365, "Asia/Tokyo")
        assertEquals("Asia/Tokyo", created.timeZone)
        val replay = repository.bootstrap("Changed", key, retry.hash, 365, "Pacific/Honolulu")
        assertEquals(created.id, replay.id)
        assertEquals("Asia/Tokyo", replay.timeZone)
        assertFailsWith<InvalidTimeZoneException> {
            repository.bootstrap("Invalid", tokens.issue().hash, tokens.issue().hash, 365, "+03:00")
        }
    }

    @Test fun `timezone writes do not rewrite historical marks or grant streak days or bypass cooldown`() = runBlocking<Unit> {
        val token = tokens.issue()
        val user = repository.bootstrap("History", tokens.issue().hash, token.hash, 365, "Pacific/Kiritimati")
        val event = assertIs<CheckInResult.Accepted>(repository.record(token.hash, UUID.randomUUID()))
        val savedDate = event.checkedAt.atZoneSameInstant(ZoneId.of(user.timeZone)).toLocalDate()
        val updated = assertIs<TimeZoneUpdateResult.Success>(repository.updateTimeZone(token.hash, "Etc/GMT+12", UUID.randomUUID())).user
        assertEquals("Etc/GMT+12", updated.timeZone)
        assertEquals(event.checkInCount, updated.checkInCount)
        assertEquals(event.checkedAt.toInstant(), updated.lastCheckInAt?.toInstant())
        assertEquals(event.streak, updated.streak)
        assertIs<CheckInResult.Cooldown>(repository.record(token.hash, UUID.randomUUID()))
        val calendar = assertNotNull(repository.calendar(token.hash, YearMonth.from(savedDate)))
        assertEquals(savedDate, calendar.days.single().date)
        assertEquals(YearMonth.from(maxOf(savedDate, calendar.today)), calendar.lastMonth)
        assertEquals(1L, calendar.days.single().count)
        source.connection.use { connection ->
            connection.prepareStatement("SELECT timezone_id, local_date FROM check_ins WHERE id = ?").use { statement ->
                statement.setObject(1, event.eventId)
                statement.executeQuery().use { rows ->
                    assertTrue(rows.next())
                    assertEquals("Pacific/Kiritimati", rows.getString(1))
                    assertEquals(savedDate, rows.getObject(2, java.time.LocalDate::class.java))
                }
            }
            assertFailsWith<SQLException> {
                connection.prepareStatement("UPDATE check_ins SET timezone_id = 'UTC', local_date = (checked_at AT TIME ZONE 'UTC')::date WHERE id = ?").use { statement ->
                    statement.setObject(1, event.eventId); statement.executeUpdate()
                }
            }
            connection.rollback()
        }
    }

    @Test fun `timezone retries cannot undo a later selection and keys cannot be repurposed`() = runBlocking<Unit> {
        val token = tokens.issue()
        repository.bootstrap("Retry", tokens.issue().hash, token.hash, 365)
        val firstKey = UUID.randomUUID()
        assertIs<TimeZoneUpdateResult.Success>(repository.updateTimeZone(token.hash, "Asia/Kathmandu", firstKey))
        assertIs<TimeZoneUpdateResult.Success>(repository.updateTimeZone(token.hash, "Europe/Berlin", UUID.randomUUID()))
        val replay = assertIs<TimeZoneUpdateResult.Success>(repository.updateTimeZone(token.hash, "Asia/Kathmandu", firstKey))
        assertEquals("Europe/Berlin", replay.user.timeZone)
        assertIs<TimeZoneUpdateResult.IdempotencyConflict>(repository.updateTimeZone(token.hash, "UTC", firstKey))
        assertIs<TimeZoneUpdateResult.Invalid>(repository.updateTimeZone(token.hash, "+02:00", UUID.randomUUID()))
        assertIs<TimeZoneUpdateResult.Unauthorized>(repository.updateTimeZone(tokens.issue().hash, "UTC", UUID.randomUUID()))
        assertEquals("Europe/Berlin", repository.findBySession(token.hash)?.timeZone)
    }

    @Test fun `calendar next midnight is a server instant in the selected named timezone`() = runBlocking<Unit> {
        val token = tokens.issue()
        repository.bootstrap("Midnight", tokens.issue().hash, token.hash, 365)
        for (zone in listOf("Europe/Berlin", "America/New_York", "Asia/Kathmandu", "Pacific/Kiritimati", "Etc/GMT+12")) {
            assertIs<TimeZoneUpdateResult.Success>(repository.updateTimeZone(token.hash, zone, UUID.randomUUID()))
            val calendar = assertNotNull(repository.calendar(token.hash, null))
            val today = calendar.serverTime.atZoneSameInstant(ZoneId.of(zone)).toLocalDate()
            assertEquals(today, calendar.today)
            assertEquals(YearMonth.from(today), calendar.month)
            assertEquals(YearMonth.from(today), calendar.firstMonth)
            assertEquals(YearMonth.from(today), calendar.lastMonth)
            assertEquals(today.plusDays(1).atStartOfDay(ZoneId.of(zone)).toInstant(), calendar.nextDayAt.toInstant())
            assertTrue(calendar.nextDayAt.isAfter(calendar.serverTime))
        }
    }
}
