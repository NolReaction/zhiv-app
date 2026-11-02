package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
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
    private suspend fun player(): Player {
        val token = tokens.issue(); val user = identities.bootstrap("Мохлик", tokens.issue().hash, token.hash, 365)
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
        assertEquals(1L, first.state.inventory[bait]); assertNotNull(first.state.boat.voyage)
        val saved = raw(p); val privateSlots = state(p).boat!!.voyage!!.slots
        assertEquals(4, privateSlots.size)
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
