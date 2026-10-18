package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
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
import ru.zhiv.mail.MailAttachments
import ru.zhiv.mail.PlayerMailMessage
import ru.zhiv.world.WorldRules
import ru.zhiv.world.WorldState
import ru.zhiv.security.TokenCodec
import java.util.UUID
import java.sql.SQLException
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
    private fun adjustment(target: User, revision: Long) = AdminEconomyAdjustmentRequest(UUID.randomUUID().toString(), target.publicId,
        "Исправление внутренней ошибки расчёта", revision)
    private suspend fun adjust(repo: JdbcAdminRepository, actor: User, target: User, request: AdminEconomyAdjustmentRequest) =
        repo.adjustEconomy(actor.hash, target.publicId, UUID.fromString(request.requestId), request)

    @Test fun `notified grants atomically publish only actual additions and same receipt never sends another letter`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val command = request(target).copy(coins = 20, pearls = 3, items = mapOf("wood" to 2L), buildings = mapOf("home" to 1),
            rods = listOf("reed_rod"), delivery = "notify", playerMessage = PlayerMailMessage("Подарок лесному жителю", "Спасибо за помощь!"))
        val replies = coroutineScope { List(2) { async(Dispatchers.IO) { grant(repo, admin, target, command) } }.awaitAll() }
        assertEquals(replies[0], replies[1]); assertTrue(replies[0].changed)
        assertEquals("1", scalar("SELECT count(*) FROM player_mail_messages"))
        assertEquals("1", scalar("SELECT count(*) FROM notification_events WHERE category='mail'"))
        val attachments = economyJson.decodeFromString<MailAttachments>(assertNotNull(scalar("SELECT attachments::text FROM player_mail_messages")))
        assertEquals(20L, attachments.coins); assertEquals(3L, attachments.pearls); assertEquals(mapOf("wood" to 2L), attachments.items)
        assertTrue(attachments.buildings.isEmpty()); assertTrue(attachments.rods.isEmpty())
        assertEquals("Спасибо за помощь!", scalar("SELECT body FROM player_mail_messages"))
        assertFalse(assertNotNull(scalar("SELECT row_to_json(player_mail_messages)::text FROM player_mail_messages")).contains(command.reason))
        for (changed in listOf(command.copy(delivery = "silent", playerMessage = null), command.copy(playerMessage = PlayerMailMessage("Другой текст", "Другой текст игроку"))))
            assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { grant(repo, admin, target, changed) }.code)
        assertFalse(grant(repo, admin, target, request(target).copy(buildings = mapOf("home" to 1), delivery = "notify")).changed)
        grant(repo, admin, target, request(target).copy(coins = 1))
        assertEquals("1", scalar("SELECT count(*) FROM player_mail_messages"))
    }

    @Test fun `signed corrections are atomic revision guarded exact retryable and preserve half pearls`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val initial = JdbcEconomyRepository(source).snapshot(target.hash)
        val state = readState(target).copy(wallet = EconomyWallet(100, 15))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), target.id)
        val command = adjustment(target, initial.revision).copy(coinsDelta = -40, pearlsDelta = -3, delivery = "notify")
        val replies = coroutineScope { List(2) { async(Dispatchers.IO) { adjust(repo, admin, target, command) } }.awaitAll() }
        assertEquals(replies[0], replies[1]); assertEquals(initial.revision + 1, replies[0].acceptedRevision)
        assertEquals(EconomyWallet(60, 9), readState(target).wallet)
        assertEquals(state, readState(target).copy(wallet = state.wallet))
        assertEquals("-40", scalar("SELECT coins FROM economy_ledger WHERE kind='admin_adjustment'"))
        assertEquals("-6", scalar("SELECT pearls FROM economy_ledger WHERE kind='admin_adjustment'"))
        assertEquals("balance_correction", scalar("SELECT type FROM player_mail_messages"))
        val attachments = economyJson.decodeFromString<MailAttachments>(assertNotNull(scalar("SELECT attachments::text FROM player_mail_messages")))
        assertEquals(-40L, attachments.coins); assertEquals(-3L, attachments.pearls)
        grant(repo, admin, target, request(target).copy(coins = 2))
        assertEquals(replies[0], adjust(repo, admin, target, command), "lost ACK retry wins before expectedRevision check")
        val beforeFailures = readState(target)
        assertEquals("ECONOMY_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
            adjust(repo, admin, target, command.copy(requestId = UUID.randomUUID().toString()))
        }.code)
        assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { adjust(repo, admin, target, command.copy(coinsDelta = -41)) }.code)
        assertEquals("ADMIN_ADJUSTMENT_INSUFFICIENT_BALANCE", assertFailsWith<AuthFailure> {
            adjust(repo, admin, target, adjustment(target, replies[0].acceptedRevision + 1).copy(coinsDelta = -1000, delivery = "notify"))
        }.code)
        assertEquals(beforeFailures, readState(target))
        assertEquals("1", scalar("SELECT count(*) FROM admin_actions WHERE action='adjust_economy'"))
        assertEquals("1", scalar("SELECT count(*) FROM player_mail_messages"))
    }

    private fun readState(target: User): EconomyState = source.connection.use { c -> readEconomyProfile(c, target.id).state }

    @Test fun `two different corrections of one observed revision cannot both spend and silent correction emits no mail`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val initial = JdbcEconomyRepository(source).snapshot(target.hash)
        val first = adjustment(target, initial.revision).copy(coinsDelta = -1)
        val replies = coroutineScope { listOf(first, first.copy(requestId = UUID.randomUUID().toString())).map { command ->
            async(Dispatchers.IO) { runCatching { adjust(repo, admin, target, command) } }
        }.awaitAll() }
        assertEquals(1, replies.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT", (replies.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        assertEquals(initial.wallet.coins - 1, readState(target).wallet.coins)
        assertEquals("1", scalar("SELECT count(*) FROM admin_actions WHERE action='adjust_economy'"))
        assertEquals("0", scalar("SELECT count(*) FROM player_mail_messages"))
    }

    @Test fun `correction requires initialized target live authorized actor and matching confirmation`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val outsider = user(); val repo = repository(admin)
        val command = adjustment(target, 0).copy(coinsDelta = 1)
        assertEquals("ADMIN_ECONOMY_NOT_INITIALIZED", assertFailsWith<AuthFailure> { adjust(repo, admin, target, command) }.code)
        assertEquals(403, assertFailsWith<AuthFailure> { adjust(repo, outsider, target, command) }.status)
        assertEquals("INVALID_ADMIN_QUERY", assertFailsWith<AuthFailure> { adjust(repo, admin, target, command.copy(confirmationPublicId = admin.publicId)) }.code)
        assertEquals("0", scalar("SELECT count(*) FROM economy_profiles"))
        JdbcEconomyRepository(source).snapshot(target.hash)
        for (predicate in listOf("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE user_id=?",
            "UPDATE app_sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE user_id=?",
            "UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Test moderation' WHERE id=?",
            "UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?")) {
            val actor = user(); val actorsRepo = repository(actor)
            execute(predicate, actor.id)
            assertEquals(401, assertFailsWith<AuthFailure> { adjust(actorsRepo, actor, target, command) }.status)
        }
        assertEquals("0", scalar("SELECT count(*) FROM admin_actions"))
    }

    @Test fun `old pre-mail stored grant JSON replays silently and cannot be changed into a notification`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val command = request(target).copy(coins = 7)
        val oldPayload = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(command)).jsonObject - setOf("delivery", "playerMessage")).toString()
        source.connection.use { c ->
            c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE", admin.id, target.id) { true }
            val (changed, revision) = grantAdminEconomy(c, target.id, UUID.fromString(command.requestId), command, java.time.Instant.now())
            c.economyUpdate("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,action,reason,affected_sessions,payload,changed,accepted_revision)
                VALUES (?,?,?,?,?,'grant_economy',?,0,?::jsonb,?,?)""", UUID.fromString(command.requestId), admin.id, target.id,
                admin.publicId, target.publicId, command.reason, oldPayload, changed, revision)
            c.commit()
        }
        val before = readState(target)
        val reply = grant(repo, admin, target, command)
        assertTrue(reply.changed); assertEquals(before, readState(target))
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE kind='grant_economy'"))
        assertEquals("0", scalar("SELECT count(*) FROM player_mail_messages"))
        assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { grant(repo, admin, target, command.copy(delivery = "notify")) }.code)
        assertEquals(economyJson.parseToJsonElement(oldPayload).jsonObject,
            economyJson.parseToJsonElement(assertNotNull(scalar("SELECT payload::text FROM admin_actions"))).jsonObject)
    }

    @Test fun `mail insertion failure rolls back grant correction ledger and audit together`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val initial = JdbcEconomyRepository(source).snapshot(target.hash)
        execute("""CREATE FUNCTION admin_mail_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'forced mail insertion failure'; END $$""")
        execute("CREATE TRIGGER admin_mail_test_failure BEFORE INSERT ON player_mail_messages FOR EACH ROW EXECUTE FUNCTION admin_mail_test_failure()")
        try {
            assertFailsWith<SQLException> { grant(repo, admin, target, request(target).copy(coins = 10, delivery = "notify")) }
            assertFailsWith<SQLException> { adjust(repo, admin, target, adjustment(target, initial.revision).copy(coinsDelta = -1, delivery = "notify")) }
            assertEquals(initial.wallet, readState(target).wallet)
            for (table in listOf("admin_actions", "player_mail_messages")) assertEquals("0", scalar("SELECT count(*) FROM $table"))
            assertEquals("0", scalar("SELECT count(*) FROM economy_ledger WHERE kind IN ('grant_economy','admin_adjustment')"))
        } finally {
            execute("DROP TRIGGER admin_mail_test_failure ON player_mail_messages")
            execute("DROP FUNCTION admin_mail_test_failure()")
        }
    }

    @Test fun `legacy gifts discoveries and cosmetic rewards notify only on actual changes`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val cosmetic = AdminPlayerCommand(UUID.randomUUID().toString(), target.publicId, "Внутренняя причина подарка", "grant_world_item", "explorer_cap",
            delivery = "notify", playerMessage = PlayerMailMessage("Подарок", "Новый наряд уже доступен."))
        val first = repo.managePlayer(admin.hash, target.publicId, UUID.fromString(cosmetic.requestId), cosmetic)
        assertTrue(first.changed)
        assertEquals(first, repo.managePlayer(admin.hash, target.publicId, UUID.fromString(cosmetic.requestId), cosmetic))
        assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            repo.managePlayer(admin.hash, target.publicId, UUID.fromString(cosmetic.requestId), cosmetic.copy(playerMessage = PlayerMailMessage("Другой заголовок", "Другой текст")))
        }.code)
        val discovery = cosmetic.copy(requestId = UUID.randomUUID().toString(), action = "grant_find", target = WorldRules.catalog.finds.first().id)
        assertTrue(repo.managePlayer(admin.hash, target.publicId, UUID.fromString(discovery.requestId), discovery).changed)
        val reward = AdminGrantRequest(UUID.randomUUID().toString(), target.publicId, "item", "flower", "Внутренняя причина награды", delivery = "notify")
        assertTrue(repo.grantReward(admin.hash, target.publicId, UUID.fromString(reward.requestId), reward).granted)
        val duplicate = reward.copy(requestId = UUID.randomUUID().toString())
        assertFalse(repo.grantReward(admin.hash, target.publicId, UUID.fromString(duplicate.requestId), duplicate).granted)
        val award = reward.copy(requestId = UUID.randomUUID().toString(), kind = "achievement", rewardId = "explorer")
        assertTrue(repo.grantReward(admin.hash, target.publicId, UUID.fromString(award.requestId), award).granted)
        assertEquals("4", scalar("SELECT count(*) FROM player_mail_messages"))
        assertEquals("4", scalar("SELECT count(*) FROM notification_events WHERE category='mail'"))
        val messages = source.connection.use { c -> c.economyRows("SELECT body,attachments::text FROM player_mail_messages") {
            it.getString(1) to economyJson.decodeFromString<MailAttachments>(it.getString(2))
        } }
        assertFalse(messages.any { it.first.contains("Внутренняя причина") })
        assertTrue(messages.any { "explorer_cap" in it.second.worldItems })
        assertTrue(messages.any { discovery.target in it.second.finds })
        assertTrue(messages.any { "flower" in it.second.gameItems })
        assertTrue(messages.any { "explorer" in it.second.achievements })
        assertEquals("INVALID_ADMIN_QUERY", assertFailsWith<AuthFailure> {
            val command = cosmetic.copy(requestId = UUID.randomUUID().toString(), action = "watch", target = "")
            repo.managePlayer(admin.hash, target.publicId, UUID.fromString(command.requestId), command)
        }.code)
    }

    @Test fun `pre-mail manage and null-payload reward receipts remain silent and immutable`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val cosmetic = AdminPlayerCommand(UUID.randomUUID().toString(), target.publicId, "Историческая выдача подарка", "grant_world_item", "explorer_cap")
        val oldPayload = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(cosmetic)).jsonObject - setOf("delivery", "playerMessage")).toString()
        execute("INSERT INTO world_profiles(user_id,state,revision) VALUES (?,?::jsonb,1)", target.id,
            economyJson.encodeToString(WorldState(inventory = WorldState().inventory + "explorer_cap")))
        execute("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,action,reason,affected_sessions,payload,changed)
            VALUES (?,?,?,?,?,'grant_world_item',?,0,?::jsonb,true)""", UUID.fromString(cosmetic.requestId), admin.id, target.id,
            admin.publicId, target.publicId, cosmetic.reason, oldPayload)
        assertTrue(repo.managePlayer(admin.hash, target.publicId, UUID.fromString(cosmetic.requestId), cosmetic).changed)
        assertEquals("1", scalar("SELECT revision FROM world_profiles WHERE user_id=?", target.id))
        assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            repo.managePlayer(admin.hash, target.publicId, UUID.fromString(cosmetic.requestId), cosmetic.copy(delivery = "notify"))
        }.code)
        val reward = AdminGrantRequest(UUID.randomUUID().toString(), target.publicId, "item", "flower", "Историческая выдача награды")
        execute("INSERT INTO game_items(user_id,item_id) VALUES (?,'flower')", target.id)
        execute("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,action,reason,affected_sessions,reward_id,granted)
            VALUES (?,?,?,?,?,'grant_item',?,0,'flower',true)""", UUID.fromString(reward.requestId), admin.id, target.id,
            admin.publicId, target.publicId, reward.reason)
        assertTrue(repo.grantReward(admin.hash, target.publicId, UUID.fromString(reward.requestId), reward).granted)
        assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            repo.grantReward(admin.hash, target.publicId, UUID.fromString(reward.requestId), reward.copy(delivery = "notify"))
        }.code)
        assertEquals("0", scalar("SELECT count(*) FROM player_mail_messages"))
        assertEquals("2", scalar("SELECT count(*) FROM admin_actions"))
        assertEquals("1", scalar("SELECT count(*) FROM game_items WHERE user_id=?", target.id))
    }

    @Test fun `HTTP wallet correction rejects cross origin visitors fractional deltas and stale revisions`() = testApplication {
        val admin = user(); val target = user(); val visitor = user(); val repo = repository(admin)
        val state = JdbcEconomyRepository(source).snapshot(target.hash)
        val production = config.copy(production = true, allowedOrigins = setOf("https://example.test"))
        application { installZhivApi(identities, identities, production, admin = repo) }
        val path = "/api/v1/admin/users/${target.publicId}/adjust-economy"
        val command = adjustment(target, state.revision).copy(coinsDelta = -1)
        suspend fun send(body: String, token: String = admin.raw, origin: String? = "https://example.test") = client.post(path) {
            header(HttpHeaders.Cookie, "${production.cookieName}=$token")
            if (origin != null) header(HttpHeaders.Origin, origin)
            contentType(ContentType.Application.Json); setBody(body)
        }
        val body = economyJson.encodeToString(command)
        assertEquals(HttpStatusCode.Forbidden, send(body, origin = null).status)
        assertEquals(HttpStatusCode.Forbidden, send(body, origin = "https://evil.example").status)
        assertEquals(HttpStatusCode.Forbidden, send(body, token = visitor.raw).status)
        assertEquals(HttpStatusCode.BadRequest, send(body.replace("\"coinsDelta\":-1", "\"coinsDelta\":-1.5")).status)
        val accepted = send(body)
        assertEquals(HttpStatusCode.OK, accepted.status)
        assertEquals("no-store", accepted.headers[HttpHeaders.CacheControl])
        assertTrue(economyJson.decodeFromString<AdminEconomyGrantReceipt>(accepted.bodyAsText()).changed)
        assertEquals(HttpStatusCode.OK, send(body).status)
        assertEquals(HttpStatusCode.Conflict, send(economyJson.encodeToString(command.copy(requestId = UUID.randomUUID().toString()))).status)
        assertEquals("0", scalar("SELECT count(*) FROM player_mail_messages"))
    }

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
