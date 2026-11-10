package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.admin.AdminConfig
import ru.zhiv.game.ProgressionRewardClaim
import ru.zhiv.installZhivApi
import ru.zhiv.presence.*
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcGameplayGenerationIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var config: AppConfig
    private lateinit var identities: JdbcZhivRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val raw: String, val hash: ByteArray)

    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
    }
    @AfterAll fun close() = source.close()
    @BeforeEach fun initialGeneration() { execute("UPDATE gameplay_generations SET generation=0,reset_at=NULL") }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(sql: String, vararg values: Any?): Long = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getLong(1) }.single()
    }
    private suspend fun player(): Player {
        val token = tokens.issue()
        val user = identities.bootstrap("Новый старт", tokens.issue().hash, token.hash, 365)
        return Player(user.id, user.publicId, token.raw, token.hash)
    }
    private fun resume() = PresenceRequest("resume", UUID.randomUUID().toString(), 0, true)
    private fun HttpRequestBuilder.owner(p: Player, generation: String? = null) {
        cookie(config.cookieName, p.raw)
        header(HttpHeaders.Origin, "http://localhost")
        generation?.let { header(GAMEPLAY_GENERATION_HEADER, it) }
        contentType(ContentType.Application.Json)
    }

    @Test fun `old generation cannot resume presence or replay any gameplay writer while login survives`() = testApplication {
        val p = runBlocking { player() }
        val presence = JdbcPresenceRepository(source)
        val opened = resume()
        runBlocking { presence.update(p.hash, opened) }
        application { installZhivApi(identities, identities, config, presence = presence,
            worlds = JdbcWorldRepository(source), games = JdbcGameRepository(source), economy = JdbcEconomyRepository(source),
            economyMarket = JdbcEconomyMarketRepository(source), economyBarter = JdbcEconomyBarterRepository(source),
            forestMemory = JdbcForestMemoryRepository(source), progressionRewards = JdbcProgressionRewardsRepository(source),
            guestWorlds = JdbcGuestWorldRepository(source), promo = JdbcPromoRepository(source), playerMail = JdbcMailRepository(source)) }
        execute("UPDATE gameplay_generations SET generation=1,reset_at=clock_timestamp()")
        val me = client.get("/api/v1/me") { owner(p) }
        assertEquals(HttpStatusCode.OK, me.status)
        assertTrue(me.bodyAsText().contains("\"gameplayGeneration\":1"))
        val paths = listOf("/api/v1/economy/commands", "/api/v1/economy/market/commands", "/api/v1/economy/barter/commands",
            "/api/v1/world/commands", "/api/v1/world/forest-memory/commands", "/api/v1/game/sessions", "/api/v1/game/batches",
            "/api/v1/game/rewards/claims", "/api/v1/economy/promo", "/api/v1/people/${UUID.randomUUID()}/world/market/commands",
            "/api/v1/mail/${UUID.randomUUID()}/claim")
        for (generation in listOf(null, "0")) for (path in paths) {
            val response = client.post(path) { owner(p, generation); header(PRESENCE_HEADER, opened.presenceId); setBody("{}") }
            assertEquals(HttpStatusCode.Conflict, response.status, path)
            assertTrue(response.bodyAsText().contains("GAME_PROGRESS_RESET"), path)
        }
        val visibility = client.patch("/api/v1/game/visibility") { owner(p); header(PRESENCE_HEADER, opened.presenceId); setBody("{}") }
        assertTrue(visibility.bodyAsText().contains("GAME_PROGRESS_RESET"))
        val oldCheckin = client.post("/api/v1/check-ins") { owner(p); header("Idempotency-Key", UUID.randomUUID()); setBody("{}") }
        assertTrue(oldCheckin.bodyAsText().contains("GAME_PROGRESS_RESET"))
        for (generation in listOf(null, "0", "01", "-1", "1.0", "9007199254740991")) {
            val response = client.post("/api/v1/presence") { owner(p, generation); setBody(Json.encodeToString(resume())) }
            assertEquals(HttpStatusCode.Conflict, response.status)
            assertTrue(response.bodyAsText().contains("GAME_PROGRESS_RESET"))
        }
        assertEquals(0L, scalar("SELECT count(*) FROM check_ins WHERE user_id=?", p.id))
        assertEquals(1L, scalar("SELECT count(*) FROM game_presence_clients WHERE user_id=?", p.id))
        assertNotNull(identities.findBySession(p.hash))
        val resumed = client.post("/api/v1/presence") { owner(p, "1"); setBody(Json.encodeToString(resume())) }
        assertEquals(HttpStatusCode.OK, resumed.status)
        // A service check-in remains available without a gameplay presence lease.
        val checkin = client.post("/api/v1/check-ins") { owner(p, "1"); header("Idempotency-Key", UUID.randomUUID()); setBody("{}") }
        assertEquals(HttpStatusCode.OK, checkin.status)
        val timezone = client.patch("/api/v1/me/time-zone") { owner(p); header("Idempotency-Key", UUID.randomUUID()); setBody("{\"timeZone\":\"UTC\"}") }
        assertEquals(HttpStatusCode.OK, timezone.status)
        assertTrue(timezone.bodyAsText().contains("\"gameplayGeneration\":1"))
    }

    @Test fun `deleted reward receipts cannot turn an old request into a new grant`() = testApplication {
        val p = runBlocking { player() }
        val presence = JdbcPresenceRepository(source)
        val opened = resume()
        runBlocking { presence.update(p.hash, opened) }
        val rewards = JdbcProgressionRewardsRepository(source)
        val old = ProgressionRewardClaim(UUID.randomUUID().toString(), p.publicId, "daily")
        runBlocking { rewards.claim(p.hash, old) }
        application { installZhivApi(identities, identities, config, presence = presence, progressionRewards = rewards) }
        // Model the reward portion of the operator reset; the separate reset test
        // runs the actual SQL and verifies every preserved/deleted table.
        execute("DELETE FROM game_reward_claims WHERE user_id=?", p.id)
        execute("DELETE FROM game_daily_rewards WHERE user_id=?", p.id)
        execute("UPDATE gameplay_generations SET generation=1,reset_at=clock_timestamp()")
        val before = source.connection.use { readEconomyProfile(it, p.id) }
        val stale = client.post("/api/v1/game/rewards/claims?catalog=8") {
            owner(p, "0"); header(PRESENCE_HEADER, opened.presenceId); setBody(Json.encodeToString(old))
        }
        assertEquals(HttpStatusCode.Conflict, stale.status)
        assertTrue(stale.bodyAsText().contains("GAME_PROGRESS_RESET"))
        assertEquals(before, source.connection.use { readEconomyProfile(it, p.id) })
        assertEquals(0L, scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=?", p.id))
        val request = old.copy(requestId = UUID.randomUUID().toString())
        repeat(2) { attempt ->
            val response = client.post("/api/v1/game/rewards/claims?catalog=8") {
                owner(p, "1"); header(PRESENCE_HEADER, opened.presenceId); setBody(Json.encodeToString(request))
            }
            assertEquals(HttpStatusCode.OK, response.status)
            assertTrue(response.bodyAsText().contains("\"replayed\":${attempt == 1}"))
        }
        assertEquals(1L, scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=?", p.id))
    }

    @Test fun `preserved friends do not recreate gameplay achievements but verified email still does`() = runBlocking<Unit> {
        val p = player()
        execute("INSERT INTO account_login_identities(provider,subject,user_id) VALUES ('email',?,?)", "${p.id}@example.invalid", p.id)
        suspend fun friend(at: OffsetDateTime) {
            val peer = player()
            execute("""INSERT INTO circles(kind,created_by_user_id,direct_user_low_id,direct_user_high_id,created_at)
                VALUES ('DIRECT',?,least(?::uuid,?::uuid),greatest(?::uuid,?::uuid),?)""", p.id, p.id, peer.id, p.id, peer.id, at)
        }
        repeat(5) { friend(OffsetDateTime.now().minusDays(1)) }
        assertEquals(5L, scalar("SELECT gameplay_friend_count(?)", p.id))
        execute("UPDATE gameplay_generations SET generation=1,reset_at=clock_timestamp()-interval '1 second'")
        val games = JdbcGameRepository(source)
        val rewards = JdbcProgressionRewardsRepository(source)
        assertEquals(0L, games.achievements(p.hash).achievements.single { it.id == "five_friends" }.progress)
        assertFalse(rewards.snapshot(p.hash).achievementRewards.single { it.achievementId == "five_friends" }.eligible)
        source.connection.use { c -> recordMergedAchievements(c, p.id, OffsetDateTime.now()); c.commit() }
        assertEquals(0L, scalar("SELECT count(*) FROM game_achievements WHERE user_id=? AND achievement_id='five_friends'", p.id))
        assertEquals(1L, scalar("SELECT count(*) FROM game_achievements WHERE user_id=? AND achievement_id='linked_email'", p.id))
        assertEquals(5L, scalar("SELECT count(*) FROM active_direct_friend_ids(?)", p.id))
        repeat(5) { friend(OffsetDateTime.now()) }
        assertNotNull(games.achievements(p.hash).achievements.single { it.id == "five_friends" }.unlockedAt)
        assertTrue(rewards.snapshot(p.hash).achievementRewards.single { it.achievementId == "five_friends" }.eligible)
    }

    @Test fun `cleared tap buckets before reset are unknown instead of observed zero`() = runBlocking<Unit> {
        val admin = player()
        execute("UPDATE game_tap_collection_metadata SET started_at=clock_timestamp()-interval '7 days'")
        execute("UPDATE gameplay_generations SET generation=1,reset_at=date_trunc('minute',clock_timestamp())-interval '2 minutes'")
        val resetAt = source.connection.use { c -> c.economyRows("SELECT reset_at FROM gameplay_generations") {
            it.getObject(1, OffsetDateTime::class.java).toInstant().toString()
        }.single() }
        val history = JdbcAdminRepository(source, AdminConfig(setOf(admin.publicId)))
            .tapActivity(admin.hash, admin.publicId).history!!
        assertEquals(resetAt, history.coverageFrom)
        assertFalse(history.coverageComplete)
        assertTrue(history.buckets.any { !it.coverageComplete && it.receivedTaps == null })
        assertTrue(history.buckets.any { it.coverageComplete && it.receivedTaps == 0L })
    }
}
