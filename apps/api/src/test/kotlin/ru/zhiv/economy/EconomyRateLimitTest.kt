package ru.zhiv.economy

import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import ru.zhiv.auth.AuthFailure
import ru.zhiv.checkins.CheckInRepository
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.checkins.DailyStreakSnapshot
import ru.zhiv.config.AppConfig
import ru.zhiv.identity.DisplayNameUpdateResult
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.UserSnapshot
import ru.zhiv.installZhivApi
import ru.zhiv.onboarding.OnboardingDecision
import ru.zhiv.onboarding.OnboardingRepository
import ru.zhiv.onboarding.OnboardingView
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Exercise the real application composition and Ktor buckets, not a test-only
 * limiter. Repository stubs isolate transport throttling from game balances. */
class EconomyRateLimitTest {
    @Test fun `ordinary active play continues for ninety minutes and permits the next construction on either device`() = testApplication {
        val fixture = Fixture(); installApi(fixture)
        val devices = listOf(fixture.first, fixture.otherDevice)
        // Twelve actions/minute includes starts, collections and sales. This
        // exhausted the old shared 120/hour bucket within eleven minutes.
        repeat(90 * 12) { index ->
            val response = client.command(fixture, devices[index % devices.size])
            assertEquals(HttpStatusCode.OK, response.status, "ordinary action $index")
            fixture.clock.addAndGet(5_000)
        }
        assertEquals(1_080, fixture.commands)
        assertEquals(HttpStatusCode.OK, client.command(fixture, fixture.otherDevice, "start_construction", "home").status)
        assertEquals(1_081, fixture.commands)
        assertEquals(HttpStatusCode.OK, client.guide(fixture, fixture.first).status,
            "normal economy traffic must not consume the account's separate world-write allowance")
    }

    @Test fun `excessive economy burst is shared by account while another account stays independent and recovers within one minute`() = testApplication {
        val fixture = Fixture(); installApi(fixture)
        repeat(120) { index ->
            assertEquals(HttpStatusCode.OK, client.command(fixture, if (index % 2 == 0) fixture.first else fixture.otherDevice).status)
        }
        val denied = client.command(fixture, fixture.otherDevice)
        assertEquals(HttpStatusCode.TooManyRequests, denied.status)
        assertTrue(assertNotNull(denied.headers[HttpHeaders.RetryAfter]).toLong() in 1..60)
        assertEquals(120, fixture.commands, "rejected requests cannot reach the economic mutation")
        assertEquals(HttpStatusCode.OK, client.command(fixture, fixture.otherAccount).status,
            "a second verified player behind the same IP keeps their own allowance")
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/economy") { header(HttpHeaders.Cookie, fixture.first) }.status)
        assertEquals(HttpStatusCode.OK, client.guide(fixture, fixture.first).status)

        fixture.clock.addAndGet(59_000)
        val stillDenied = client.command(fixture, fixture.first)
        assertEquals(HttpStatusCode.TooManyRequests, stillDenied.status)
        assertEquals("1", stillDenied.headers[HttpHeaders.RetryAfter])
        fixture.clock.addAndGet(1_001)
        assertEquals(HttpStatusCode.OK, client.command(fixture, fixture.first).status)
        assertEquals(122, fixture.commands)
    }

    @Test fun `world-write exhaustion cannot block production and its longer security window is retained`() = testApplication {
        val fixture = Fixture(); installApi(fixture)
        repeat(120) { assertEquals(HttpStatusCode.OK, client.guide(fixture, fixture.first).status) }
        val denied = client.guide(fixture, fixture.otherDevice)
        assertEquals(HttpStatusCode.TooManyRequests, denied.status)
        assertEquals("3600", denied.headers[HttpHeaders.RetryAfter])
        assertEquals(HttpStatusCode.OK, client.command(fixture, fixture.first).status)
        fixture.clock.addAndGet(60_001)
        assertEquals(HttpStatusCode.TooManyRequests, client.guide(fixture, fixture.first).status,
            "the economy fix does not loosen unrelated world writes")
        assertEquals(HttpStatusCode.OK, client.command(fixture, fixture.otherDevice).status)
    }

    @Test fun `changing forged cookies cannot create unlimited anonymous economic budgets`() = testApplication {
        val fixture = Fixture(); installApi(fixture)
        repeat(120) { index ->
            assertEquals(HttpStatusCode.Unauthorized,
                client.command(fixture, "${fixture.config.cookieName}=forged-$index").status)
        }
        assertEquals(HttpStatusCode.TooManyRequests,
            client.command(fixture, "${fixture.config.cookieName}=another-forged-cookie").status)
        assertEquals(0, fixture.commands)
        assertEquals(HttpStatusCode.OK, client.command(fixture, fixture.first).status)
    }

    private fun ApplicationTestBuilder.installApi(fixture: Fixture) {
        application {
            installZhivApi(fixture, fixture, fixture.config, economy = fixture, onboarding = fixture,
                rateLimitClock = fixture.clock::get)
        }
    }

    private suspend fun HttpClient.command(fixture: Fixture, cookie: String, action: String = "start_production", target: String = "grow_berries") =
        post("/api/v1/economy/commands") {
            header(HttpHeaders.Cookie, cookie)
            header(HttpHeaders.Origin, "http://localhost")
            contentType(ContentType.Application.Json)
            setBody("""{"requestId":"${UUID.randomUUID()}","ownerPublicId":"${fixture.owner(cookie)}","expectedRevision":${fixture.commands},"action":"$action","targetId":"$target"}""")
        }

    private suspend fun HttpClient.guide(fixture: Fixture, cookie: String) = post("/api/v1/onboarding") {
        header(HttpHeaders.Cookie, cookie)
        header(HttpHeaders.Origin, "http://localhost")
        contentType(ContentType.Application.Json)
        setBody("""{"ownerPublicId":"${fixture.owner(cookie)}","course":"world","status":"completed"}""")
    }

    private class Fixture : IdentityRepository, CheckInRepository, EconomyRepository, OnboardingRepository {
        val config = AppConfig("unused", "unused", "unused", false, setOf("http://localhost"))
        // Ktor removes idle buckets with wall-clock timers. Keep virtual time
        // ahead so only this clock triggers refills, even on a slow test runner.
        val clock = AtomicLong(System.currentTimeMillis() + 24 * 60 * 60 * 1_000L)
        private val codec = TokenCodec()
        private val sessions = mutableMapOf<List<Byte>, UserSnapshot>()
        private val userId = UUID.randomUUID()
        val first = session(userId, "AAAA-0000-0001")
        val otherDevice = session(userId, "AAAA-0000-0001")
        val otherAccount = session(UUID.randomUUID(), "AAAA-0000-0002")
        var commands = 0
            private set
        private val state = EconomyRules.initial()

        private fun session(id: UUID, publicId: String): String {
            val token = codec.issue()
            sessions[token.hash.toList()] = UserSnapshot(id, publicId, "Player", null, 0,
                DailyStreakSnapshot(0, 0, false, null), null, null, OffsetDateTime.now(ZoneOffset.UTC))
            return "${config.cookieName}=${token.raw}"
        }
        fun owner(cookie: String) = sessions[codec.hash(cookie.substringAfter('=')).toList()]?.publicId ?: "AAAA-0000-0001"
        private fun authenticated(hash: ByteArray) = sessions[hash.toList()]
            ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)

        override suspend fun findBySession(sessionTokenHash: ByteArray) = sessions[sessionTokenHash.toList()]
        override suspend fun bootstrap(displayName: String, bootstrapKeyHash: ByteArray, sessionTokenHash: ByteArray,
            sessionLifetimeDays: Long, timeZone: String): UserSnapshot = error("Unused")
        override suspend fun updateDisplayName(sessionTokenHash: ByteArray, displayName: String, idempotencyKey: UUID): DisplayNameUpdateResult = error("Unused")
        override suspend fun record(sessionTokenHash: ByteArray, idempotencyKey: UUID) = CheckInResult.Unauthorized

        override suspend fun snapshot(sessionHash: ByteArray) = EconomyView(authenticated(sessionHash).publicId, commands.toLong(),
            OffsetDateTime.now(ZoneOffset.UTC).toString(), state.wallet, state.inventory, state.buildings, state.jobs,
            state.migration, EconomyRules.catalog, EconomyRules.storage(state))
        override suspend fun command(sessionHash: ByteArray, command: EconomyCommand): EconomyResult {
            assertEquals(authenticated(sessionHash).publicId, command.ownerPublicId)
            assertEquals(commands.toLong(), command.expectedRevision)
            commands++
            return EconomyResult(snapshot(sessionHash), "accepted", commands.toLong())
        }
        override suspend fun read(hash: ByteArray, owner: String): OnboardingView {
            assertEquals(authenticated(hash).publicId, owner)
            return OnboardingView(owner, null, "completed")
        }
        override suspend fun save(hash: ByteArray, decision: OnboardingDecision) = read(hash, decision.ownerPublicId)
    }
}
