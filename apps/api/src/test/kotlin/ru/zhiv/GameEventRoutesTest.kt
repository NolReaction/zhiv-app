package ru.zhiv

import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import ru.zhiv.checkins.CheckInRepository
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.checkins.DailyStreakSnapshot
import ru.zhiv.config.AppConfig
import ru.zhiv.identity.DisplayNameUpdateResult
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.UserSnapshot
import ru.zhiv.observability.ClickerSeriesFinishedEvent
import ru.zhiv.observability.GameEventSink
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class GameEventRoutesTest {
    @Test
    fun `accepts one authenticated aggregate and rejects invalid or anonymous data`() = testApplication {
        val repository = FakeRepository()
        val events = mutableListOf<ClickerSeriesFinishedEvent>()
        application {
            installZhivApi(
                repository,
                repository,
                testConfig(),
                gameEvents = GameEventSink { events.add(it) },
            )
        }

        val created = client.post("/api/v1/bootstrap") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", UUID.randomUUID().toString())
            setBody("""{"displayName":"Дима"}""")
        }
        val cookie = assertNotNull(created.headers[HttpHeaders.SetCookie]).substringBefore(';')
        val body = """{
            "eventId":"${UUID.randomUUID()}",
            "type":"CLICKER_SERIES_FINISHED",
            "tapCount":20,
            "bestSeries":50,
            "level":5,
            "storyId":"space",
            "durationMs":12345,
            "reason":"IDLE_TIMEOUT"
        }""".trimIndent()

        val accepted = client.post("/api/v1/game-events") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Cookie, cookie)
            setBody(body)
        }
        assertEquals(HttpStatusCode.NoContent, accepted.status)
        assertEquals(1, events.size)
        assertEquals(20L, events.single().tapCount)
        assertEquals("space", events.single().storyId)

        val invalid = client.post("/api/v1/game-events") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Cookie, cookie)
            setBody(body.replace("\"tapCount\":20", "\"tapCount\":0"))
        }
        assertEquals(HttpStatusCode.BadRequest, invalid.status)
        assertEquals(1, events.size)

        val anonymous = client.post("/api/v1/game-events") {
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        assertEquals(HttpStatusCode.Unauthorized, anonymous.status)
        assertEquals(1, events.size)
    }

    private fun testConfig() = AppConfig(
        databaseUrl = "unused",
        databaseUser = "unused",
        databasePassword = "unused",
        production = false,
        allowedOrigins = setOf("http://localhost"),
    )

    private class FakeRepository : IdentityRepository, CheckInRepository {
        private var sessionHash: ByteArray? = null
        private var user: UserSnapshot? = null

        override suspend fun bootstrap(
            displayName: String,
            bootstrapKeyHash: ByteArray,
            sessionTokenHash: ByteArray,
            sessionLifetimeDays: Long,
        ): UserSnapshot {
            sessionHash = sessionTokenHash
            val now = OffsetDateTime.now(ZoneOffset.UTC)
            return UserSnapshot(
                id = UUID.randomUUID(),
                publicId = "7K3P-2Q9M-W8ZR",
                displayName = displayName,
                lastCheckInAt = null,
                checkInCount = 0,
                streak = DailyStreakSnapshot(0, 0, false, now.plusDays(1)),
                displayNameChangedAt = null,
                displayNameChangeAvailableAt = null,
                serverTime = now,
            ).also { user = it }
        }

        override suspend fun findBySession(sessionTokenHash: ByteArray): UserSnapshot? =
            user?.takeIf { sessionHash?.contentEquals(sessionTokenHash) == true }

        override suspend fun updateDisplayName(
            sessionTokenHash: ByteArray,
            displayName: String,
            idempotencyKey: UUID,
        ): DisplayNameUpdateResult = DisplayNameUpdateResult.Unauthorized

        override suspend fun record(
            sessionTokenHash: ByteArray,
            idempotencyKey: UUID,
        ): CheckInResult = CheckInResult.Unauthorized
    }
}
