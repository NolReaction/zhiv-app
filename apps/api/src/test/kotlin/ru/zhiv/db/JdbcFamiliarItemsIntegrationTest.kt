package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.*

/** Actual contact survives consumption, old receipts, and account merges without a GET migration. */
@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcFamiliarItemsIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var economy: JdbcEconomyRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray)

    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")))
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
        economy = JdbcEconomyRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private suspend fun player(): Player {
        val token = tokens.issue()
        val user = identities.bootstrap("Мохлик", tokens.issue().hash, token.hash, 365)
        economy.snapshot(token.hash) // Initialize the merchant cycle before checking read-only projections.
        return Player(user.id, user.publicId, token.hash)
    }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c -> c.economyUpdate(sql, *values).also { c.commit() } }
    private fun scalar(sql: String, vararg values: Any?): String = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getString(1) }.single()
    }
    private fun raw(p: Player) = scalar("SELECT jsonb_build_object('revision',revision,'state',state)::text FROM economy_profiles WHERE user_id=?", p.id)
    private fun state(p: Player) = source.connection.use { readEconomyProfile(it, p.id).state }
    private fun put(p: Player, state: EconomyState) = execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), p.id)

    @Test fun `legacy receipts project once on player and admin reads then persist with the accepted command`() = runBlocking<Unit> {
        val p = player()
        put(p, state(p).copy(familiarItems = null, inventory = emptyMap()))
        execute("""INSERT INTO economy_ledger(user_id,source_key,kind,items) VALUES
            (?,'familiar-old-gift','gift','{"glass":1,"fish_silverfin":1,"tools":0,"unknown_item":1}')""", p.id)
        val before = raw(p)
        val view = economy.snapshot(p.hash)
        assertEquals(listOf("fish_common", "fish_silverfin", "glass", "stone", "wood"), view.familiarItems)
        val admin = source.connection.use { readAdminEconomyPlayer(it, p.publicId, OffsetDateTime.now()) }!!
        assertEquals(view.familiarItems, admin.economy!!.familiarItems)
        assertEquals(before, raw(p), "Neither view can mutate saved JSON or revision")
        val request = EconomyCommand(UUID.randomUUID().toString(), p.publicId, view.revision, "start_production", "grow_berries")
        val accepted = economy.command(p.hash, request)
        assertFalse(accepted.replayed)
        assertEquals(view.familiarItems, accepted.state.familiarItems, "A pending berry is not yet familiar")
        val saved = raw(p)
        assertTrue(economy.command(p.hash, request).replayed)
        assertEquals(saved, raw(p))
        execute("""INSERT INTO economy_ledger(user_id,source_key,kind,items)
            VALUES (?,'late-legacy-history','claim_job','{"tools":1}')""", p.id)
        assertFalse("tools" in economy.snapshot(p.hash).familiarItems, "Initialized knowledge never reimports the legacy ledger")
    }

    @Test fun `central reward save learns a gift and keeps it after sale without granting market obtainability`() = runBlocking<Unit> {
        val p = player()
        val original = state(p)
        source.connection.use { c ->
            c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", p.id) { true }
            saveEconomyProfile(c, p.id, original.copy(inventory = mapOf("tools" to 1L)), recordAwards = false)
            c.commit()
        }
        val owned = economy.snapshot(p.hash)
        assertTrue("tools" in owned.familiarItems)
        assertFalse("tools" in owned.unlockedItems)
        val sold = economy.command(p.hash, EconomyCommand(UUID.randomUUID().toString(), p.publicId, owned.revision, "sell", "tools")).state
        assertFalse("tools" in sold.inventory)
        assertTrue("tools" in sold.familiarItems)
        assertFalse("tools" in sold.unlockedItems)
        assertTrue("tools" in JdbcEconomyRepository(source).snapshot(p.hash).familiarItems)
    }

    @Test fun `merge unions spent knowledge and legacy exact fish held in market escrow`() = runBlocking<Unit> {
        val a = player(); val b = player()
        put(a, state(a).copy(inventory = emptyMap(), familiarItems = listOf("glass")))
        put(b, state(b).copy(inventory = emptyMap(), familiarItems = null,
            fishing = EconomyFishing(escrow = mapOf(UUID.randomUUID().toString() to mapOf("fish_silverfin" to 1L)))))
        execute("""INSERT INTO economy_ledger(user_id,source_key,kind,items)
            VALUES (?,'known-before-merge','gift','{"tools":1}')""", b.id)
        source.connection.use { c ->
            listOf(a.id, b.id).sorted().forEach { id -> c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", id) { true } }
            mergeEconomyProfiles(c, a.id, b.id)
            c.commit()
        }
        assertEquals(listOf("fish_common", "fish_silverfin", "glass", "stone", "tools", "wood"), economy.snapshot(a.hash).familiarItems)
        assertEquals(emptyMap(), economy.snapshot(a.hash).inventory, "Familiarity does not manufacture any goods")
    }
}
