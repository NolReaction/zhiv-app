package ru.zhiv.game

import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.ratelimit.RateLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.minutes

class ProgressionRewardsRoutesTest {
    private val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))

    private class Rewards : ProgressionRewardsRepository {
        val owner = "ABCD-EFGH-JKMP"
        val now: Instant = Instant.parse("2026-10-26T12:00:00Z")
        var state = EconomyRules.initial(0, 0, 0)
        var daily = DailyRewardsState(rewardVersion = 7)
        var calls = 0
        val receipts = mutableMapOf<String, ProgressionRewardResult>()
        override suspend fun snapshot(sessionHash: ByteArray) = ProgressionRewardsView(owner, now.toString(),
            daily = ProgressionRewardRules.dailyView(daily, now), achievementRewards = GameRewards.tiers.flatMap { (id, targets) ->
                targets.mapIndexed { index, target -> AchievementRewardView(id, index + 1, target,
                    ProgressionRewardRules.achievementPearls.getValue(id)[index], null, null, false, "not_earned") }
            })
        override suspend fun claim(sessionHash: ByteArray, command: ProgressionRewardClaim): ProgressionRewardResult {
            calls++
            receipts[command.requestId]?.let { return it.copy(replayed = true) }
            val reward = ProgressionRewardRules.daily[0]
            state = ProgressionRewardRules.credit(state, reward)
            daily = ProgressionRewardRules.afterClaim(daily, now)
            val used = state.inventory.values.sum()
            val economy = EconomyView(owner, 1, now.toString(), state.wallet, state.inventory, state.buildings,
                state.jobs, state.migration, EconomyRules.catalog, EconomyStorage(100, used, 0, 100 - used, 0))
            return ProgressionRewardResult(command.requestId, snapshot(sessionHash), economy, 1, false,
                ProgressionRewardReceipt("daily", reward, now.toString(), step = 1)).also { receipts[command.requestId] = it }
        }
    }

    private fun ApplicationTestBuilder.setup(repository: Rewards) {
        application {
            install(ContentNegotiation) { json(progressionRewardsJson) }
            install(RateLimit) {
                for (name in listOf("world-read", "world-write"))
                    register(RateLimitName(name)) { rateLimiter(limit = 100, refillPeriod = 1.minutes) }
            }
            install(StatusPages) {
                exception<AuthFailure> { call, error ->
                    call.respond(HttpStatusCode.fromValue(error.status), ApiErrorResponse(error.code, error.message))
                }
            }
            routing { progressionRewardsRoutes(repository, TokenCodec(), config) }
        }
    }

    private fun HttpRequestBuilder.authorized(command: ProgressionRewardClaim) {
        cookie(config.cookieName, "cached-reward-session")
        header(HttpHeaders.Origin, "https://im-alive.ru")
        contentType(ContentType.Application.Json)
        setBody(progressionRewardsJson.encodeToString(command))
    }

    @Test fun `cached catalogs keep readable previews but cannot mutate before updating`() = testApplication {
        val repository = Rewards(); setup(repository)
        val before = repository.state
        val command = ProgressionRewardClaim(UUID.randomUUID().toString(), repository.owner, "daily")
        for (suffix in listOf("", "?catalog=4", "?catalog=5", "?catalog=6", "?catalog=7")) {
            val read = client.get("/api/v1/game/rewards$suffix") { cookie(config.cookieName, "cached-reward-session") }
            assertEquals(HttpStatusCode.OK, read.status)
            val view = progressionRewardsJson.decodeFromString<ProgressionRewardsView>(read.bodyAsText())
            assertEquals(if (suffix.isEmpty() || suffix == "?catalog=4") 21 else 33, view.achievementRewards.size)
            val denied = client.post("/api/v1/game/rewards/claims$suffix") { authorized(command) }
            assertEquals(HttpStatusCode.Conflict, denied.status)
            assertEquals("no-store", denied.headers[HttpHeaders.CacheControl])
            assertTrue(denied.bodyAsText().contains("APP_UPDATE_REQUIRED"))
        }
        assertEquals(0, repository.calls); assertEquals(before, repository.state); assertTrue(repository.receipts.isEmpty())

        val accepted = client.post("/api/v1/game/rewards/claims?catalog=8") { authorized(command) }
        assertEquals(HttpStatusCode.OK, accepted.status)
        val paid = progressionRewardsJson.decodeFromString<ProgressionRewardResult>(accepted.bodyAsText())
        assertFalse(paid.replayed); assertEquals(8, paid.rewards.catalogVersion)
        assertEquals(40, paid.rewards.achievementRewards.size); assertEquals(15, paid.economy.catalog.version)
        assertEquals(before.wallet.coins + 30, repository.state.wallet.coins)
        val rejectedReplay = client.post("/api/v1/game/rewards/claims?catalog=7") { authorized(command) }
        assertEquals(HttpStatusCode.Conflict, rejectedReplay.status); assertEquals(1, repository.calls)
        val replay = client.post("/api/v1/game/rewards/claims?catalog=8") { authorized(command) }
        assertEquals(HttpStatusCode.OK, replay.status)
        val result = progressionRewardsJson.decodeFromString<ProgressionRewardResult>(replay.bodyAsText())
        assertTrue(result.replayed); assertEquals(paid.claim, result.claim)
        assertEquals(paid.economy.wallet, result.economy.wallet); assertEquals(1, repository.receipts.size)
    }
}
