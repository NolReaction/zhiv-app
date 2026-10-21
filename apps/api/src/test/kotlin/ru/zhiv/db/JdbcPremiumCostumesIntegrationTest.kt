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
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.security.TokenCodec
import ru.zhiv.world.*
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcPremiumCostumesIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var economy: JdbcEconomyRepository
    private lateinit var world: JdbcWorldRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray)
    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")))
        DatabaseFactory.migrate(source)
        economy = JdbcEconomyRepository(source); world = JdbcWorldRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private fun scalar(sql: String, vararg values: Any?): String = source.connection.use { c -> c.economyRows(sql, *values) { it.getString(1) }.single() }
    private suspend fun player(): Player {
        val session = tokens.issue()
        val user = JdbcZhivRepository(source).bootstrap("Примерочная", tokens.issue().hash, session.hash, 365)
        val p = Player(user.id, user.publicId, session.hash)
        economy.snapshot(p.hash); world.snapshot(p.hash)
        return p
    }

    @Test fun `premium wallet requests and legacy crafts leave balances ownership revisions receipts and ledger unchanged`() = runBlocking<Unit> {
        val p = player(); val before = economy.snapshot(p.hash); val beforeWorld = world.snapshot(p.hash)
        val saved = scalar("SELECT state::text || ':' || revision FROM economy_profiles WHERE user_id=?", p.id)
        val savedWorld = scalar("SELECT state::text || ':' || revision FROM world_profiles WHERE user_id=?", p.id)
        val premium = WorldRules.catalog.items.filter { it.premium }
        assertEquals(9, premium.size)
        for (item in premium) {
            for (target in listOf(item.id, "coins:${item.id}", "pearls:${item.id}")) {
                val command = EconomyCommand(UUID.randomUUID().toString(), p.publicId, before.revision, "buy_wardrobe_item", target, 1, 0)
                repeat(2) {
                    assertEquals("ECONOMY_WARDROBE_ITEM", assertFailsWith<AuthFailure> { economy.command(p.hash, command) }.code)
                }
                assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(command.requestId)))
                assertEquals("0", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND source_key=?", p.id, "command:${command.requestId}"))
            }
            val command = WorldCommand(UUID.randomUUID().toString(), p.publicId, beforeWorld.revision, "craft", item.id)
            assertEquals("WORLD_ECONOMY_MOVED", assertFailsWith<AuthFailure> { world.command(p.hash, command) }.code)
            assertEquals("WORLD_ITEM_NOT_OWNED", assertFailsWith<AuthFailure> { world.command(p.hash, command.copy(action = "equip")) }.code)
            assertEquals("0", scalar("SELECT count(*) FROM world_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(command.requestId)))
        }
        assertEquals(saved, scalar("SELECT state::text || ':' || revision FROM economy_profiles WHERE user_id=?", p.id))
        assertEquals(savedWorld, scalar("SELECT state::text || ':' || revision FROM world_profiles WHERE user_id=?", p.id))
        val after = economy.snapshot(p.hash)
        assertEquals(before.wallet, after.wallet); assertEquals(before.inventory, after.inventory); assertEquals(before.wardrobe, after.wardrobe)
        assertEquals(beforeWorld.state.equipment, world.snapshot(p.hash).state.equipment)
    }

    @Test fun `confirmed premium ownership projects to the world and equipped pieces survive repository recreation`() = runBlocking<Unit> {
        val p = player(); val before = economy.snapshot(p.hash)
        val special = WorldRules.catalog.items.filter { it.premium }.map { it.id }
        source.connection.use { c ->
            val state = readEconomyProfile(c, p.id).state
            c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state.copy(wardrobe = (state.wardrobe + special).sorted())), p.id)
            c.commit()
        }
        for (item in WorldRules.catalog.items.filter { it.premium }) {
            val snapshot = world.snapshot(p.hash)
            assertTrue(item.id in snapshot.state.inventory)
            val command = WorldCommand(UUID.randomUUID().toString(), p.publicId, snapshot.revision, "equip", item.id)
            val accepted = world.command(p.hash, command)
            assertEquals(accepted.snapshot.state.equipment, JdbcWorldRepository(source).snapshot(p.hash).state.equipment)
            assertTrue(world.command(p.hash, command).replayed)
        }
        val after = economy.snapshot(p.hash)
        assertEquals(before.wallet, after.wallet); assertEquals(before.inventory, after.inventory); assertEquals(before.jobs, after.jobs)
        assertEquals(9, after.wardrobe.count { it in special })
    }
}
