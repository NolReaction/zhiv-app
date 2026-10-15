package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcAdminEconomyGrantsIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var config: AppConfig
    private val tokens = TokenCodec()
    private val secondHouseBuildings = mapOf("home" to 2, "woodlot" to 1, "dryer" to 1, "workshop" to 1)
    private data class User(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)
    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clear() { execute("TRUNCATE app_users CASCADE") }
    private fun execute(sql: String, vararg values: Any?): Int = source.connection.use { c ->
        c.prepareStatement(sql).use { s ->
            values.forEachIndexed { i, value -> s.setObject(i + 1, value) }; s.executeUpdate()
        }.also { c.commit() }
    }
    private fun scalar(sql: String, vararg values: Any?): String? = source.connection.use { c ->
        c.prepareStatement(sql).use { s ->
            values.forEachIndexed { i, value -> s.setObject(i + 1, value) }
            s.executeQuery().use { r -> if (r.next()) r.getString(1) else null }
        }
    }
    private suspend fun user(): User {
        val token = tokens.issue()
        val snapshot = identities.bootstrap("Игрок", tokens.issue().hash, token.hash, 365)
        return User(snapshot.id, snapshot.publicId, token.hash, token.raw)
    }
    private fun repository(vararg admins: User) = JdbcAdminRepository(source, AdminConfig(admins.map { it.publicId }.toSet()))
    private fun request(target: User) = AdminEconomyGrantRequest(UUID.randomUUID().toString(), target.publicId, "Компенсация сбоя производства")
    private suspend fun grant(repo: JdbcAdminRepository, actor: User, target: User, request: AdminEconomyGrantRequest) =
        repo.grantEconomy(actor.hash, target.publicId, UUID.fromString(request.requestId), request)

    @Test fun `concurrent requests grant once and immutable receipts cannot cross action actor or payload`() = runBlocking<Unit> {
        val admin = user(); val peer = user(); val target = user(); val stranger = user()
        val repo = repository(admin, peer)
        val command = request(target).copy(coins = 145, pearls = 7, items = mapOf("stone" to 3L),
            buildings = secondHouseBuildings, productionSlots = mapOf("garden" to 2),
            rods = listOf("river_rod"), hooks = listOf("barbed_hook"))
        assertEquals(403, assertFailsWith<AuthFailure> { grant(repo, stranger, target, command) }.status)
        assertEquals("0", scalar("SELECT count(*) FROM economy_profiles"))
        val replies = coroutineScope { List(2) { async(Dispatchers.IO) { grant(repo, admin, target, command) } }.awaitAll() }
        assertEquals(replies[0], replies[1]); assertTrue(replies[0].changed); assertEquals(1L, replies[0].acceptedRevision)
        val state = assertNotNull(repo.economyPlayer(admin.hash, target.publicId).economy)
        val starting = EconomyRules.initial()
        assertEquals(starting.wallet.coins + 145, state.wallet.coins)
        assertEquals(starting.wallet.pearls + 14, state.wallet.pearls)
        assertEquals((starting.inventory["stone"] ?: 0) + 3, state.inventory["stone"])
        assertEquals(2, state.buildings["home"])
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE kind='grant_economy'"))
        assertEquals("1", scalar("SELECT count(*) FROM admin_actions"))
        assertEquals("7", scalar("SELECT payload->>'pearls' FROM admin_actions"))
        assertEquals("14", scalar("SELECT pearls FROM economy_ledger WHERE kind='grant_economy'"))
        assertEquals("0", scalar("SELECT count(*) FROM game_monthly_scores"))
        for (conflict in listOf(command.copy(coins = 146), command.copy(reason = "Другая причина выдачи")))
            assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { grant(repo, admin, target, conflict) }.code)
        assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { grant(repo, peer, target, command) }.code)
        assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            repo.grantReward(admin.hash, target.publicId, UUID.fromString(command.requestId),
                AdminGrantRequest(command.requestId, target.publicId, "item", "flower", command.reason))
        }.code)
        val later = grant(repo, admin, target, request(target).copy(coins = 2))
        assertEquals(2L, later.acceptedRevision)
        assertEquals(replies[0], grant(repo, admin, target, command))
        assertEquals(state.wallet.coins + 2, repo.economyPlayer(admin.hash, target.publicId).economy!!.wallet.coins)
        val analytics = repo.analytics(admin.hash)
        assertEquals(0L, analytics.summary.activePlayers)
        assertEquals(1L, assertNotNull(analytics.progression).snapshot.unknownHistoryPlayers)
    }

    @Test fun `failed package rolls back initialization conversion currency and audit together`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val command = request(target).copy(coins = 100, items = mapOf("wood" to 10_000L))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { grant(repo, admin, target, command) }.code)
        for (table in listOf("economy_profiles", "economy_ledger", "economy_conversion_audit", "admin_actions"))
            assertEquals("0", scalar("SELECT count(*) FROM $table"), table)
        assertEquals("INVALID_ADMIN_QUERY", assertFailsWith<AuthFailure> {
            grant(repo, admin, target, command.copy(confirmationPublicId = admin.publicId))
        }.code)
        val repaired = grant(repo, admin, target, command.copy(items = mapOf("wood" to 75L),
            buildings = secondHouseBuildings + ("warehouse" to 2)))
        assertTrue(repaired.changed)
        assertEquals(2, repo.economyPlayer(admin.hash, target.publicId).economy!!.buildings["warehouse"])
    }

    @Test fun `escrow cannot be displaced and no-op unlocks do not mint inventory or revisions`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        JdbcEconomyRepository(source).snapshot(target.hash)
        val state = EconomyRules.initial(includeStartingPack = false).copy(inventory = mapOf("wood" to 45L))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), target.id)
        execute("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?,?,?,?)",
            UUID.randomUUID(), target.id, "wood", 5, 10)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            grant(repo, admin, target, request(target).copy(items = mapOf("stone" to 1L), coins = 100))
        }.code)
        val noOp = grant(repo, admin, target, request(target).copy(buildings = mapOf("home" to 1), rods = listOf("reed_rod")))
        assertFalse(noOp.changed); assertEquals(0L, noOp.acceptedRevision)
        assertEquals("0", scalar("SELECT count(*) FROM economy_ledger WHERE kind='grant_economy'"))
        assertEquals(0L, repo.economyPlayer(admin.hash, target.publicId).economy!!.wallet.coins)
        val expanded = grant(repo, admin, target, request(target).copy(items = mapOf("stone" to 1L),
            buildings = secondHouseBuildings + ("warehouse" to 2)))
        assertTrue(expanded.changed)
        assertEquals(5L, repo.economyPlayer(admin.hash, target.publicId).economy!!.storage.reserved)
    }

    @Test fun `new grant conflicts with a completed old admin action and replays need a live session`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val request = request(target).copy(coins = 10)
        repo.grantReward(admin.hash, target.publicId, UUID.fromString(request.requestId),
            AdminGrantRequest(request.requestId, target.publicId, "item", "flower", request.reason))
        assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { grant(repo, admin, target, request) }.code)
        val next = request.copy(requestId = UUID.randomUUID().toString())
        grant(repo, admin, target, next)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?", admin.hash)
        assertEquals(401, assertFailsWith<AuthFailure> { grant(repo, admin, target, next) }.status)
    }

    @Test fun `HTTP economy grants enforce origin allowlist and emit private bounded responses`() = testApplication {
        val admin = user(); val target = user(); val visitor = user(); val repo = repository(admin)
        val production = config.copy(production = true, allowedOrigins = setOf("https://example.test"))
        application { installZhivApi(identities, identities, production, admin = repo) }
        val path = "/api/v1/admin/users/${target.publicId}/grant-economy"
        val body = economyJson.encodeToString(request(target).copy(coins = 20, pearls = 3))
        for (origin in listOf<String?>(null, "https://evil.example")) {
            assertEquals(HttpStatusCode.Forbidden, client.post(path) {
                header(HttpHeaders.Cookie, "${production.cookieName}=${admin.raw}")
                if (origin != null) header(HttpHeaders.Origin, origin)
                contentType(ContentType.Application.Json); setBody(body)
            }.status)
        }
        assertEquals(HttpStatusCode.Forbidden, client.post(path) {
            header(HttpHeaders.Cookie, "${production.cookieName}=${visitor.raw}"); header(HttpHeaders.Origin, "https://example.test")
            contentType(ContentType.Application.Json); setBody(body)
        }.status)
        val accepted = client.post(path) {
            header(HttpHeaders.Cookie, "${production.cookieName}=${admin.raw}"); header(HttpHeaders.Origin, "https://example.test")
            contentType(ContentType.Application.Json); setBody(body)
        }
        assertEquals(HttpStatusCode.OK, accepted.status)
        assertEquals("no-store", accepted.headers[HttpHeaders.CacheControl])
        assertFalse(accepted.bodyAsText().contains("fishingCastSeed"))
        assertEquals(target.publicId, economyJson.decodeFromString<AdminEconomyGrantReceipt>(accepted.bodyAsText()).publicId)
    }
}
