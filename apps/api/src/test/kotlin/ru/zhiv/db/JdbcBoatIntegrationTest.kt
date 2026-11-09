package ru.zhiv.db

import io.ktor.client.request.cookie
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import ru.zhiv.installZhivApi
import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.game.GameVisibilityRequest
import ru.zhiv.relationships.DirectRequestActionSnapshot
import ru.zhiv.relationships.DirectRequestMutationSnapshot
import ru.zhiv.relationships.RelationshipResult
import ru.zhiv.relationships.RequestAction
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcBoatIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var economy: JdbcEconomyRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray)
    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")))
        DatabaseFactory.migrate(source); identities = JdbcZhivRepository(source); economy = JdbcEconomyRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private suspend fun player(name: String = "Мохлик"): Player {
        val token = tokens.issue(); val user = identities.bootstrap(name, tokens.issue().hash, token.hash, 365)
        economy.snapshot(token.hash)
        return Player(user.id, user.publicId, token.hash)
    }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c -> c.economyUpdate(sql, *values).also { c.commit() } }
    private fun scalar(sql: String, vararg values: Any?): String = source.connection.use { c -> c.economyRows(sql, *values) { it.getString(1) }.single() }
    private fun state(p: Player) = source.connection.use { readEconomyProfile(it, p.id).state }
    private fun put(p: Player, s: EconomyState) = execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(s), p.id)
    private fun raw(p: Player) = scalar("SELECT jsonb_build_object('revision',revision,'state',state)::text FROM economy_profiles WHERE user_id=?", p.id)
    private fun command(p: Player, view: EconomyView, action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), p.publicId, view.revision, action, target)

    @Test fun `departure receipt freezes private slots across repository restart and both public mappers redact them`() = runBlocking<Unit> {
        val p = player()
        val bait = EconomyRules.catalog.fishing!!.baits.first { EconomyRules.fishingBaitCompatible("reed_rod", it.itemId) }.itemId
        put(p, state(p).copy(boat = EconomyBoatState(level = 1), inventory = mapOf(bait to 2L), fishing = EconomyFishing(equippedBaitId = bait)))
        val request = command(p, economy.snapshot(p.hash), "depart_boat", "river_reach")
        val first = economy.command(p.hash, request)
        assertEquals(1, first.state.boat.fuel!!.cells); assertEquals(1L, first.state.inventory[bait]); assertNotNull(first.state.boat.voyage)
        val saved = raw(p); val privateSlots = state(p).boat!!.voyage!!.slots
        assertEquals(6, privateSlots.size)
        assertTrue(JdbcEconomyRepository(source).command(p.hash, request).replayed)
        assertEquals(saved, raw(p)); assertEquals(privateSlots, state(p).boat!!.voyage!!.slots)
        val admin = source.connection.use { readAdminEconomyPlayer(it, p.publicId, OffsetDateTime.now()) }!!.economy!!
        for (view in listOf(first.state, admin, JdbcEconomyRepository(source).snapshot(p.hash))) {
            val json = economyJson.encodeToString(view)
            val voyage = economyJson.parseToJsonElement(json).jsonObject
                .getValue("boat").jsonObject.getValue("voyage").jsonObject
            // Other public systems legitimately expose slots; only the voyage draw is private.
            assertFalse("slots" in voyage, "Public voyage must not expose future catches")
            assertFalse("challengeSeed" in json)
            assertTrue(assertNotNull(view.boat.voyage).catches.isEmpty())
            assertEquals(first.state.boat, view.boat)
        }
        assertEquals(saved, raw(p), "Public observations do not advance or reselect the voyage")
    }

    @Test fun `concurrent refill and exact replay after restart debit one cell once`() = runBlocking<Unit> {
        val p = player()
        val price = EconomyRules.catalog.boat!!.fuel.refillPricePearls
        val recharge = Instant.now().plusSeconds(1200).toString()
        put(p, state(p).copy(boat = EconomyBoatState(level = 1, fuel = EconomyBoatFuel(0, recharge)), wallet = EconomyWallet(100, 100)))
        val request = command(p, economy.snapshot(p.hash), "buy_boat_fuel", "fuel_cell").copy(totalPrice = price)
        val results = listOf(async { economy.command(p.hash, request) }, async { economy.command(p.hash, request) }).awaitAll()
        assertEquals(1, results.count { it.replayed })
        val snapshot = economy.snapshot(p.hash)
        assertEquals(100 - price, snapshot.wallet.pearls)
        assertEquals(EconomyBoatFuel(1, recharge), snapshot.boat.fuel)
        assertEquals(snapshot.boat.fuel, state(p).boat!!.fuel)
        val replayed = JdbcEconomyRepository(source).command(p.hash, request)
        assertTrue(replayed.replayed); assertEquals(snapshot.wallet, replayed.state.wallet)
        assertEquals((-price).toString(), scalar("SELECT sum(pearls) FROM economy_ledger WHERE user_id=? AND kind='buy_boat_fuel'", p.id))
        val second = command(p, snapshot, "buy_boat_fuel", "fuel_cell").copy(totalPrice = price)
        assertEquals("ECONOMY_BOAT_FUEL", assertFailsWith<AuthFailure> { economy.command(p.hash, second) }.code)
    }

    @Test fun `ready claim persists exact fish and legacy fragments once and the receipt replays after reconnect`() = runBlocking<Unit> {
        val p = player(); val time = Instant.now().minusSeconds(2500)
        val pages = EconomyBoatBlueprints(2, 1)
        val artifacts = listOf("telescope")
        val departed = EconomyBoats.command(state(p).copy(boat = EconomyBoatState(level = 1, blueprints = pages, artifacts = artifacts), inventory = emptyMap()),
            EconomyCommand(UUID.randomUUID().toString(), p.publicId, 0, "depart_boat", "river_reach"), time, random = { 0L }).first
        val b = departed.boat!!; val v = b.voyage!!
        put(p, departed.copy(boat = b.copy(voyage = v.copy(castsUsed = v.maxCasts,
            catches = listOf(EconomyBoatCatch(0, "fish_silverfin", 600, time.plusSeconds(330).toString()))))))
        val request = command(p, economy.snapshot(p.hash), "claim_boat", v.id)
        val first = economy.command(p.hash, request)
        assertNull(first.state.boat.voyage); assertEquals(1L, first.state.inventory["fish_common"])
        assertEquals(1L, first.state.fishing.stock!!["fish_silverfin"])
        assertEquals(1L, first.state.boat.qualifiedVoyages)
        assertEquals(pages, first.state.boat.blueprints); assertEquals(artifacts, first.state.boat.artifacts)
        val after = raw(p)
        val replay = JdbcEconomyRepository(source).command(p.hash, request)
        assertTrue(replay.replayed); assertEquals(first.state.boat, replay.state.boat)
        assertEquals(after, raw(p))
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='claim_boat'", p.id))
    }

    @Test fun `confirmed species leaders respect direct friends opt-in ties and revocation`() = runBlocking<Unit> {
        val viewer = player("Зритель"); val friend = player("Друг"); val stranger = player("Чужой"); val hidden = player("Скрытый")
        val games = JdbcGameRepository(source)
        val relationships = JdbcRelationshipRepository(source)
        val sent = assertIs<RelationshipResult.Success<DirectRequestMutationSnapshot>>(
            relationships.sendRequest(viewer.hash, friend.publicId, UUID.randomUUID())).value.request
        val link = assertIs<RelationshipResult.Success<DirectRequestActionSnapshot>>(
            relationships.actOnRequest(friend.hash, sent.requestId, RequestAction.ACCEPTED)).value
        val now = Instant.now().toString()
        val fish = "fish_silverfin"
        fun record(owner: Player, weight: Int) {
            put(owner, state(owner).copy(boat = EconomyBoatState(level = 1, records = mapOf(fish to EconomyBoatRecord(weight, now)))))
        }
        record(viewer, 500); record(friend, 500); record(stranger, 650); record(hidden, 900)
        games.setVisibility(hidden.hash, true, 0, hidden.publicId) // The older tap ranking permission grants no access to fish.
        suspend fun visibility(p: Player, visible: Boolean, version: Long) =
            games.setFishingVisibility(p.hash, GameVisibilityRequest(visible, version, p.publicId))
        val privateBoard = games.fishingRecords(viewer.hash, "friends")
        assertFalse(privateBoard.leaderboardOptIn); assertEquals(0L, privateBoard.visibilityVersion)
        assertTrue(privateBoard.entries.isEmpty())
        visibility(friend, true, 0); visibility(stranger, true, 0)
        val friendBest = games.fishingRecords(viewer.hash, "friends").entries.single()
        assertEquals("Друг", friendBest.displayName); assertEquals(500, friendBest.weightGrams); assertFalse(friendBest.isMe)
        val scope = "global"
        val worldBest = games.fishingRecords(viewer.hash, scope).entries.single { it.fishId == fish }
        assertEquals(650, worldBest.weightGrams); assertEquals("Чужой", worldBest.displayName)
        val opted = visibility(viewer, true, 0)
        assertEquals(opted, visibility(viewer, true, 0), "replaying a lost response cannot advance the version")
        val tied = games.fishingRecords(viewer.hash, "friends").entries.single()
        assertTrue(tied.isMe); assertEquals("Зритель", tied.displayName); assertEquals(2L, tied.tiedCount)
        assertEquals("GAME_VISIBILITY_CONFLICT", assertFailsWith<AuthFailure> { visibility(viewer, false, 0) }.code)
        assertEquals("GAME_OWNER_CHANGED", assertFailsWith<AuthFailure> {
            games.setFishingVisibility(viewer.hash, GameVisibilityRequest(false, 1, stranger.publicId))
        }.code)
        assertEquals("INVALID_GAME_SCOPE", assertFailsWith<AuthFailure> { games.fishingRecords(viewer.hash, "self") }.code)
        relationships.removePerson(viewer.hash, assertNotNull(link.person).circleId)
        assertEquals(1L, games.fishingRecords(viewer.hash, "friends").entries.single().tiedCount)
        execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Fishing moderation test' WHERE id=?", stranger.id)
        assertEquals(500, games.fishingRecords(viewer.hash, scope).entries.single { it.fishId == fish }.weightGrams)
        visibility(viewer, false, 1); visibility(friend, false, 1)
        assertTrue(games.fishingRecords(viewer.hash, "friends").entries.isEmpty())
        assertEquals(500, state(viewer).boat!!.records.getValue(fish).weightGrams)
    }

    @Test fun `fishing record routes require a session preserve privacy and reject competing scopes and untrusted writes`() = testApplication {
        val config = AppConfig(source.jdbcUrl, "postgres", "", false, setOf("http://localhost"))
        application { installZhivApi(identities, identities, config, games = JdbcGameRepository(source)) }
        val token = tokens.issue()
        val owner = identities.bootstrap("Рыболов", tokens.issue().hash, token.hash, 365)
        val path = "/api/v1/game/fishing-records"
        assertEquals(HttpStatusCode.Unauthorized, client.get(path).status)
        assertEquals(HttpStatusCode.BadRequest, client.get("$path?scope=global&scope=friends") { cookie(config.cookieName, token.raw) }.status)
        val privateBoardResponse = client.get("$path?scope=friends") { cookie(config.cookieName, token.raw) }
        assertEquals(HttpStatusCode.OK, privateBoardResponse.status)
        assertEquals("no-store", privateBoardResponse.headers[HttpHeaders.CacheControl])
        val board = economyJson.decodeFromString<ru.zhiv.game.FishingRecordsBoard>(privateBoardResponse.bodyAsText())
        assertEquals(owner.publicId, board.ownerPublicId); assertEquals("friends", board.scope); assertFalse(board.leaderboardOptIn)
        suspend fun change(origin: String) = client.post("$path/visibility") {
            cookie(config.cookieName, token.raw); header(HttpHeaders.Origin, origin); contentType(ContentType.Application.Json)
            setBody(economyJson.encodeToString(GameVisibilityRequest(true, 0, owner.publicId)))
        }
        assertEquals(HttpStatusCode.Forbidden, change("https://elsewhere.test").status)
        val response = change("http://localhost")
        assertEquals(HttpStatusCode.OK, response.status)
        val settings = economyJson.decodeFromString<ru.zhiv.game.FishingRecordVisibility>(response.bodyAsText())
        assertTrue(settings.leaderboardOptIn); assertEquals(1L, settings.visibilityVersion)
    }

    @Test fun `publication and confirmed claim serialize on the owner including an opt-out racing another claim`() = runBlocking<Unit> {
        val p = player()
        val games = JdbcGameRepository(source)
        val fish = "fish_silverfin"
        val start = Instant.now().minusSeconds(2500)
        suspend fun ready(weight: Int): EconomyCommand {
            val before = state(p)
            val b = before.boat ?: EconomyBoatState(level = 1)
            val departed = EconomyBoats.command(before.copy(boat = b.copy(level = 1, fuel = EconomyBoatFuel(2))),
                EconomyCommand(UUID.randomUUID().toString(), p.publicId, 0, "depart_boat", "river_reach"), start, random = { 0L }).first
            val atRiver = departed.boat!!; val v = atRiver.voyage!!
            put(p, departed.copy(boat = atRiver.copy(voyage = v.copy(castsUsed = v.maxCasts,
                catches = listOf(EconomyBoatCatch(0, fish, weight, start.plusSeconds(330).toString()))))))
            return command(p, economy.snapshot(p.hash), "claim_boat", v.id)
        }
        for ((i, publish) in listOf(true, false).withIndex()) {
            val claim = ready(300 + i)
            assertEquals(if (i == 0) null else 300, games.fishingRecords(p.hash, "friends").entries.singleOrNull()?.weightGrams)
            val preference = async { games.setFishingVisibility(p.hash, GameVisibilityRequest(publish, i.toLong(), p.publicId)) }
            val collecting = async { economy.command(p.hash, claim) }
            preference.await(); collecting.await()
            assertTrue(economy.command(p.hash, claim).replayed)
            val board = games.fishingRecords(p.hash, "friends")
            assertEquals(publish, board.leaderboardOptIn)
            assertEquals(if (publish) 300 else null, board.entries.singleOrNull()?.weightGrams)
            assertEquals(300 + i, state(p).boat!!.records.getValue(fish).weightGrams)
            assertEquals(if (publish) "1" else "0", scalar("SELECT count(*) FROM game_fishing_records WHERE user_id=?", p.id))
        }
    }

    @Test fun `merge review and mutation refuse active voyages and profile reset recreates an empty boat`() = runBlocking<Unit> {
        val a = player(); val b = player()
        val departed = EconomyBoats.command(state(b).copy(boat = EconomyBoatState(level = 1)),
            EconomyCommand(UUID.randomUUID().toString(), b.publicId, 0, "depart_boat", "river_reach"), Instant.now(), random = { 0L }).first
        put(b, departed)
        val savedA = raw(a); val savedB = raw(b)
        assertTrue(source.connection.use { economyMergeConflicts(it, a.id, b.id) }.any { "лодке" in it })
        assertEquals("ACCOUNT_MERGE_CONFLICT", assertFailsWith<AuthFailure> {
            source.connection.use { c ->
                listOf(a.id, b.id).sorted().forEach { id -> c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", id) { true } }
                mergeEconomyProfiles(c, a.id, b.id)
            }
        }.code)
        assertEquals(savedA, raw(a)); assertEquals(savedB, raw(b))
        // Existing authorized reset removes the economy profile; the permanent conversion fence remains.
        execute("DELETE FROM economy_profiles WHERE user_id=?", b.id)
        val reset = JdbcEconomyRepository(source).snapshot(b.hash)
        assertEquals(EconomyBoatView(), reset.boat)
        assertEquals(0L, reset.wallet.coins); assertTrue(reset.inventory.isEmpty())
        assertEquals("1", scalar("SELECT count(*) FROM economy_conversion_audit WHERE user_id=?", b.id))
    }
}
