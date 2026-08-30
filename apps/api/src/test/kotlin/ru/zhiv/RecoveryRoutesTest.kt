package ru.zhiv

import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.ratelimit.RateLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.Json
import ru.zhiv.checkins.DailyStreakSnapshot
import ru.zhiv.config.AppConfig
import ru.zhiv.identity.UserSnapshot
import ru.zhiv.recovery.RecoveryApprovalPreviewSnapshot
import ru.zhiv.recovery.RecoveryAttemptSnapshot
import ru.zhiv.recovery.RecoveryAttemptStatus
import ru.zhiv.recovery.RecoveryCompletionSnapshot
import ru.zhiv.recovery.RecoveryContactsSnapshot
import ru.zhiv.recovery.RecoveryRepository
import ru.zhiv.recovery.RecoveryResult
import ru.zhiv.recovery.recoveryRoutes
import ru.zhiv.relationships.UserReference
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.time.Duration.Companion.hours

class RecoveryRoutesTest {
    @Test
    fun `claim cookie is scoped and completion returns identity with two cookie updates`() = testApplication {
        val tokenCodec = TokenCodec()
        val approval = tokenCodec.issue()
        val repository = FakeRecoveryRepository()
        application {
            install(ContentNegotiation) {
                json(Json { explicitNulls = true; encodeDefaults = true })
            }
            install(RateLimit) {
                register(RateLimitName("relationships")) {
                    rateLimiter(limit = 100, refillPeriod = 1.hours)
                }
                register(RateLimitName("account-recovery-write")) {
                    rateLimiter(limit = 100, refillPeriod = 1.hours)
                }
                register(RateLimitName("account-recovery-read")) {
                    rateLimiter(limit = 100, refillPeriod = 1.hours)
                }
            }
            routing { recoveryRoutes(repository, tokenCodec, testConfig()) }
        }

        val creationKey = UUID.randomUUID()
        val starts = coroutineScope {
            List(2) {
                async {
                    client.post("/api/v1/account-recovery/attempts") {
                        contentType(ContentType.Application.Json)
                        header(HttpHeaders.Origin, "http://localhost")
                        header("Idempotency-Key", creationKey.toString())
                        setBody("""{"token":"${approval.raw}"}""")
                    }
                }
            }.awaitAll()
        }
        assertEquals(1, starts.count { it.status == HttpStatusCode.Created })
        assertEquals(1, starts.count { it.status == HttpStatusCode.OK })
        val created = starts.single { it.status == HttpStatusCode.Created }
        assertEquals(HttpStatusCode.Created, created.status)
        assertEquals("no-store", created.headers[HttpHeaders.CacheControl])
        assertContains(created.bodyAsText(), "\"status\":\"PENDING\"")
        assertContains(created.bodyAsText(), "\"target\":null")
        val startCookies = starts.map { response ->
            assertNotNull(response.headers.getAll(HttpHeaders.SetCookie))
                .single { it.startsWith("zhiv_recovery=") }
        }
        assertEquals(1, startCookies.toSet().size)
        val recoverySetCookie = startCookies.first()
        assertContains(recoverySetCookie, "Max-Age=600")
        assertContains(recoverySetCookie, "Path=/api/v1/account-recovery")
        assertContains(recoverySetCookie, "HttpOnly")
        assertContains(recoverySetCookie, "SameSite=Strict")
        val recoveryCookie = recoverySetCookie.substringBefore(';')

        val lostResponseRetry = client.post("/api/v1/account-recovery/attempts") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Origin, "http://localhost")
            header("Idempotency-Key", creationKey.toString())
            setBody("""{"token":"${approval.raw}"}""")
        }
        assertEquals(HttpStatusCode.OK, lostResponseRetry.status)
        assertEquals(
            recoverySetCookie,
            assertNotNull(lostResponseRetry.headers.getAll(HttpHeaders.SetCookie))
                .single { it.startsWith("zhiv_recovery=") },
        )

        val current = client.get("/api/v1/account-recovery/attempts/current") {
            header(HttpHeaders.Cookie, recoveryCookie)
        }
        assertEquals(HttpStatusCode.OK, current.status)
        assertContains(current.bodyAsText(), "\"attemptId\":")

        repository.approve()
        val completed = client.post("/api/v1/account-recovery/attempts/current/complete") {
            header(HttpHeaders.Cookie, recoveryCookie)
            header(HttpHeaders.Origin, "http://localhost")
            header("Idempotency-Key", UUID.randomUUID().toString())
        }
        assertEquals(HttpStatusCode.OK, completed.status)
        assertContains(completed.bodyAsText(), "\"user\":")
        assertContains(completed.bodyAsText(), "\"displayName\":\"Старый профиль\"")
        val completionCookies = assertNotNull(completed.headers.getAll(HttpHeaders.SetCookie))
        assertEquals(2, completionCookies.size)
        val claimRaw = recoveryCookie.substringAfter('=')
        assertEquals(true, completionCookies.any { it.startsWith("zhiv_session_dev=$claimRaw;") })
        assertEquals(true, completionCookies.any { it.startsWith("zhiv_recovery=; Max-Age=0") })

        val forbiddenDelete = client.delete("/api/v1/account-recovery/attempts/current") {
            header(HttpHeaders.Cookie, recoveryCookie)
            header(HttpHeaders.Origin, "https://evil.example")
        }
        assertEquals(HttpStatusCode.Forbidden, forbiddenDelete.status)
        assertEquals(null, forbiddenDelete.headers[HttpHeaders.SetCookie])

        val cancelledWithoutCookie = client.delete("/api/v1/account-recovery/attempts/current") {
            header(HttpHeaders.Origin, "http://localhost")
        }
        assertEquals(HttpStatusCode.NoContent, cancelledWithoutCookie.status)
    }

    @Test
    fun `production claim cookie is host-only and ignores the legacy cookie name`() = testApplication {
        val tokenCodec = TokenCodec()
        val approval = tokenCodec.issue()
        val repository = FakeRecoveryRepository()
        val config = AppConfig(
            databaseUrl = "unused",
            databaseUser = "unused",
            databasePassword = "unused",
            production = true,
            allowedOrigins = setOf("https://app.example"),
        )
        application {
            install(ContentNegotiation) {
                json(Json { explicitNulls = true; encodeDefaults = true })
            }
            install(RateLimit) {
                register(RateLimitName("relationships")) {
                    rateLimiter(limit = 100, refillPeriod = 1.hours)
                }
                register(RateLimitName("account-recovery-write")) {
                    rateLimiter(limit = 100, refillPeriod = 1.hours)
                }
                register(RateLimitName("account-recovery-read")) {
                    rateLimiter(limit = 100, refillPeriod = 1.hours)
                }
            }
            routing { recoveryRoutes(repository, tokenCodec, config) }
        }

        val created = client.post("/api/v1/account-recovery/attempts") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Origin, "https://app.example")
            header("Idempotency-Key", UUID.randomUUID().toString())
            setBody("""{"token":"${approval.raw}"}""")
        }
        assertEquals(HttpStatusCode.Created, created.status)
        val setCookie = assertNotNull(created.headers.getAll(HttpHeaders.SetCookie))
            .single { it.startsWith("__Host-zhiv_recovery=") }
        assertContains(setCookie, "; Path=/;")
        assertContains(setCookie, "; Secure")
        assertContains(setCookie, "; HttpOnly")
        assertContains(setCookie, "; SameSite=Strict")
        assertEquals(false, setCookie.contains("Domain=", ignoreCase = true))
        val claimRaw = setCookie.substringBefore(';').substringAfter('=')

        val legacyCookie = client.get("/api/v1/account-recovery/attempts/current") {
            header(HttpHeaders.Cookie, "zhiv_recovery=$claimRaw")
        }
        assertEquals(HttpStatusCode.Unauthorized, legacyCookie.status)

        val productionCookie = "__Host-zhiv_recovery=$claimRaw"
        val current = client.get("/api/v1/account-recovery/attempts/current") {
            header(HttpHeaders.Cookie, productionCookie)
        }
        assertEquals(HttpStatusCode.OK, current.status)

        repository.approve()
        val completed = client.post("/api/v1/account-recovery/attempts/current/complete") {
            header(HttpHeaders.Cookie, productionCookie)
            header(HttpHeaders.Origin, "https://app.example")
            header("Idempotency-Key", UUID.randomUUID().toString())
        }
        assertEquals(HttpStatusCode.OK, completed.status)
        val completionCookies = assertNotNull(completed.headers.getAll(HttpHeaders.SetCookie))
        val clearedRecovery = completionCookies.single {
            it.startsWith("__Host-zhiv_recovery=; Max-Age=0")
        }
        assertContains(clearedRecovery, "; Path=/;")
        assertContains(clearedRecovery, "; Secure")
        assertEquals(false, clearedRecovery.contains("Domain=", ignoreCase = true))
        assertEquals(true, completionCookies.any { it.startsWith("__Host-zhiv_session=$claimRaw;") })
    }

    private fun testConfig() = AppConfig(
        databaseUrl = "unused",
        databaseUser = "unused",
        databasePassword = "unused",
        production = false,
        allowedOrigins = setOf("http://localhost"),
    )

    private class FakeRecoveryRepository : RecoveryRepository {
        private val now = OffsetDateTime.now(ZoneOffset.UTC)
        private var status = RecoveryAttemptStatus.PENDING
        private var creationKey: UUID? = null
        private var claimHash: ByteArray? = null
        private val target = UserReference("ABCD-EFGH-JKLM", "Старый профиль")

        fun approve() {
            status = RecoveryAttemptStatus.APPROVED
        }

        private fun attempt(replayed: Boolean = false) = RecoveryAttemptSnapshot(
            UUID.fromString("0198f000-0000-7000-8000-000000000001"),
            status,
            now.plusMinutes(10),
            target.takeIf { status != RecoveryAttemptStatus.PENDING },
            replayed,
            now,
        )

        override suspend fun list(sessionTokenHash: ByteArray) =
            RecoveryResult.Success(RecoveryContactsSnapshot(emptyList(), emptyList(), emptyList(), now))

        override suspend fun add(sessionTokenHash: ByteArray, circleId: UUID, key: UUID) = list(sessionTokenHash)

        override suspend fun remove(sessionTokenHash: ByteArray, contactId: UUID, key: UUID) = list(sessionTokenHash)

        override suspend fun createAttempt(
            approvalTokenHash: ByteArray,
            claimTokenHash: ByteArray,
            key: UUID,
            initiatingSessionTokenHash: ByteArray?,
        ): RecoveryResult<RecoveryAttemptSnapshot> = synchronized(this) {
            val replayed = creationKey != null
            if (replayed && (creationKey != key || claimHash?.contentEquals(claimTokenHash) != true)) {
                return@synchronized RecoveryResult.Conflict
            }
            creationKey = key
            claimHash = claimTokenHash.copyOf()
            RecoveryResult.Success(attempt(replayed))
        }

        override suspend fun currentAttempt(claimTokenHash: ByteArray): RecoveryResult<RecoveryAttemptSnapshot> =
            RecoveryResult.Success(attempt())

        override suspend fun cancelAttempt(claimTokenHash: ByteArray): RecoveryResult<Unit> =
            RecoveryResult.Success(Unit)

        override suspend fun previewApproval(
            sessionTokenHash: ByteArray,
            approvalTokenHash: ByteArray,
        ): RecoveryResult<RecoveryApprovalPreviewSnapshot> = RecoveryResult.Success(
            RecoveryApprovalPreviewSnapshot(emptyList(), now.plusMinutes(10), now),
        )

        override suspend fun confirmApproval(
            sessionTokenHash: ByteArray,
            approvalTokenHash: ByteArray,
            contactId: UUID,
            key: UUID,
        ): RecoveryResult<RecoveryAttemptSnapshot> {
            approve()
            return RecoveryResult.Success(attempt())
        }

        override suspend fun completeAttempt(
            claimTokenHash: ByteArray,
            key: UUID,
            sessionLifetimeDays: Long,
        ): RecoveryResult<RecoveryCompletionSnapshot> {
            status = RecoveryAttemptStatus.COMPLETED
            return RecoveryResult.Success(
                RecoveryCompletionSnapshot(
                    attempt(),
                    UserSnapshot(
                        UUID.fromString("0198f000-0000-7000-8000-000000000002"),
                        target.publicId,
                        target.displayName,
                        null,
                        7,
                        DailyStreakSnapshot(2, 5, true, now.plusHours(12)),
                        null,
                        null,
                        now,
                    ),
                ),
            )
        }
    }
}
