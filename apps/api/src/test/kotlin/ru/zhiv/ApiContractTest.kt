package ru.zhiv

import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import ru.zhiv.checkins.CheckInRepository
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.checkins.DailyStreakSnapshot
import ru.zhiv.config.AppConfig
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.DisplayNameUpdateResult
import ru.zhiv.identity.UserSnapshot
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ApiContractTest {
    @Test
    fun `bootstrap sets an http-only cookie and check-in returns server time`() = testApplication {
        val repository = FakeRepository()
        application {
            installZhivApi(repository, repository, testConfig())
        }

        val created = client.post("/api/v1/bootstrap") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", UUID.randomUUID().toString())
            setBody("""{"displayName":"  Дима  "}""")
        }
        assertEquals(HttpStatusCode.Created, created.status)
        assertContains(created.bodyAsText(), "\"lastCheckInAt\":null")
        assertContains(created.bodyAsText(), "\"checkInCount\":0")
        assertContains(created.bodyAsText(), "\"currentDays\":0")
        assertContains(created.bodyAsText(), "\"displayNameChangeAvailableAt\":null")
        val setCookie = assertNotNull(created.headers[HttpHeaders.SetCookie])
        assertContains(setCookie, "HttpOnly")
        assertContains(setCookie, "SameSite=Lax")
        val cookie = setCookie.substringBefore(';')

        val checkedIn = client.post("/api/v1/check-ins") {
            header(HttpHeaders.Cookie, cookie)
            header("Idempotency-Key", UUID.randomUUID().toString())
        }
        assertEquals(HttpStatusCode.OK, checkedIn.status)
        assertContains(checkedIn.bodyAsText(), "\"replayed\":false")
        assertContains(checkedIn.bodyAsText(), "\"checkInCount\":1")
        assertContains(checkedIn.bodyAsText(), "\"currentDays\":1")
    }

    @Test
    fun `profile name changes once and then returns a cooldown`() = testApplication {
        val repository = FakeRepository()
        application {
            installZhivApi(repository, repository, testConfig())
        }

        val created = client.post("/api/v1/bootstrap") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", UUID.randomUUID().toString())
            setBody("""{"displayName":"Дима"}""")
        }
        val cookie = assertNotNull(created.headers[HttpHeaders.SetCookie]).substringBefore(';')

        val renamed = client.patch("/api/v1/me") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Cookie, cookie)
            header("Idempotency-Key", UUID.randomUUID().toString())
            setBody("""{"displayName":"  Дмитрий${'\u00A0'}Живой  "}""")
        }
        assertEquals(HttpStatusCode.OK, renamed.status)
        assertContains(renamed.bodyAsText(), "\"displayName\":\"Дмитрий Живой\"")
        assertContains(renamed.bodyAsText(), "\"displayNameChangedAt\":")

        val cooldown = client.patch("/api/v1/me") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Cookie, cookie)
            header("Idempotency-Key", UUID.randomUUID().toString())
            setBody("""{"displayName":"Дима снова"}""")
        }
        assertEquals(HttpStatusCode.TooManyRequests, cooldown.status)
        assertContains(cooldown.bodyAsText(), "\"code\":\"DISPLAY_NAME_COOLDOWN\"")
        assertNotNull(cooldown.headers[HttpHeaders.RetryAfter])
    }

    @Test
    fun `check-in rejects a missing session and malformed idempotency key`() = testApplication {
        val repository = FakeRepository()
        application {
            installZhivApi(repository, repository, testConfig())
        }

        val malformed = client.post("/api/v1/check-ins") {
            header("Idempotency-Key", "not-a-uuid")
        }
        assertEquals(HttpStatusCode.BadRequest, malformed.status)

        val unauthorized = client.post("/api/v1/check-ins") {
            header("Idempotency-Key", UUID.randomUUID().toString())
        }
        assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)
    }

    @Test
    fun `bootstrap requires a UUIDv4 key even with an authenticated cookie`() = testApplication {
        val repository = FakeRepository()
        application {
            installZhivApi(repository, repository, testConfig())
        }

        val created = client.post("/api/v1/bootstrap") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", UUID.randomUUID().toString())
            setBody("""{"displayName":"Дима"}""")
        }
        val cookie = assertNotNull(created.headers[HttpHeaders.SetCookie]).substringBefore(';')

        val missing = client.post("/api/v1/bootstrap") {
            header(HttpHeaders.Cookie, cookie)
        }
        assertEquals(HttpStatusCode.BadRequest, missing.status)

        val nonRandom = client.post("/api/v1/bootstrap") {
            header(HttpHeaders.Cookie, cookie)
            header("Idempotency-Key", "00000000-0000-0000-0000-000000000000")
        }
        assertEquals(HttpStatusCode.BadRequest, nonRandom.status)
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
        private var displayNameChangedAt: OffsetDateTime? = null

        private fun streak(currentDays: Long, checkedInToday: Boolean) = DailyStreakSnapshot(
            currentDays = currentDays,
            longestDays = currentDays,
            checkedInToday = checkedInToday,
            nextDayAt = OffsetDateTime.now(ZoneOffset.UTC).plusDays(1),
        )

        override suspend fun bootstrap(
            displayName: String,
            bootstrapKeyHash: ByteArray,
            sessionTokenHash: ByteArray,
            sessionLifetimeDays: Long,
        ): UserSnapshot {
            sessionHash = sessionTokenHash
            return UserSnapshot(
                id = UUID.randomUUID(),
                publicId = "7K3P-2Q9M-W8ZR",
                displayName = displayName,
                lastCheckInAt = null,
                checkInCount = 0,
                streak = streak(0, false),
                displayNameChangedAt = null,
                displayNameChangeAvailableAt = null,
                serverTime = OffsetDateTime.now(ZoneOffset.UTC),
            ).also { user = it }
        }

        override suspend fun findBySession(sessionTokenHash: ByteArray): UserSnapshot? =
            user?.takeIf { sessionHash?.contentEquals(sessionTokenHash) == true }

        override suspend fun updateDisplayName(
            sessionTokenHash: ByteArray,
            displayName: String,
            idempotencyKey: UUID,
        ): DisplayNameUpdateResult {
            val current = user?.takeIf { sessionHash?.contentEquals(sessionTokenHash) == true }
                ?: return DisplayNameUpdateResult.Unauthorized
            if (displayName == current.displayName) return DisplayNameUpdateResult.Success(current)
            val now = OffsetDateTime.now(ZoneOffset.UTC)
            val changedAt = displayNameChangedAt
            if (changedAt != null && changedAt.plusHours(24).isAfter(now)) {
                return DisplayNameUpdateResult.Cooldown(changedAt.plusHours(24), now)
            }
            displayNameChangedAt = now
            return DisplayNameUpdateResult.Success(
                current.copy(
                    displayName = displayName,
                    displayNameChangedAt = now,
                    displayNameChangeAvailableAt = now.plusHours(24),
                    serverTime = now,
                ).also { user = it },
            )
        }

        override suspend fun record(
            sessionTokenHash: ByteArray,
            idempotencyKey: UUID,
        ): CheckInResult {
            if (sessionHash?.contentEquals(sessionTokenHash) != true) return CheckInResult.Unauthorized
            val now = OffsetDateTime.now(ZoneOffset.UTC)
            return CheckInResult.Accepted(
                eventId = UUID.randomUUID(),
                checkedAt = now,
                checkInCount = 1,
                streak = streak(1, true),
                serverTime = now,
                nextAllowedAt = now.plusSeconds(30),
                replayed = false,
            )
        }
    }
}
