package ru.zhiv.db

import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.security.TokenCodec
import ru.zhiv.world.WorldResources
import ru.zhiv.world.WorldState
import ru.zhiv.world.worldJson
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcOnboardingEconomyIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")

    @Test fun `V46 preserves saved economies and initializes only future profiles with the catalog pack`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("45").load().migrate()
            val tokens = TokenCodec(); val token = tokens.issue()
            val identities = JdbcZhivRepository(source)
            val old = identities.bootstrap("Сохранённый", tokens.issue().hash, token.hash, 365)
            val saved = EconomyRules.initial(includeStartingPack = false).copy(wallet = EconomyWallet(27, 8), inventory = mapOf("stone" to 2L))
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO economy_profiles(user_id,state,revision) VALUES (?,?::jsonb,7)", old.id, economyJson.encodeToString(saved))
                c.commit()
            }
            DatabaseFactory.migrate(source); DatabaseFactory.migrate(source)
            source.connection.use { c ->
                val preserved = readEconomyProfile(c, old.id)
                assertEquals(7L, preserved.revision)
                assertEquals(saved.wallet, preserved.state.wallet); assertEquals(saved.inventory, preserved.state.inventory)
                for (include in listOf(true, false)) {
                    val legacy = WorldState(resources = WorldResources(sparks = 100, wood = 81, stone = 49), houseLevel = 4, workshop = true, workshopLevel = 2)
                    val initialized = c.economyRows("SELECT economy_v4_initial_state(?::jsonb,?)", worldJson.encodeToString(legacy), include) {
                        economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single()
                    assertEquals(EconomyRules.initial(100, 81, 49, 4, 2, includeStartingPack = include), initialized)
                }
            }
            val newToken = tokens.issue(); val newPlayer = identities.bootstrap("Новичок", tokens.issue().hash, newToken.hash, 365)
            val economy = JdbcEconomyRepository(source)
            val first = economy.snapshot(newToken.hash)
            assertEquals(EconomyWallet(2500, 1000), first.wallet)
            assertEquals(mapOf("fish_common" to 10L, "wood" to 10L, "stone" to 10L), first.inventory)
            assertEquals(first.wallet, economy.snapshot(newToken.hash).wallet)
            source.connection.use { c ->
                val ledger = c.economyRows("SELECT kind,coins,pearls,items FROM economy_ledger WHERE user_id=? ORDER BY kind", newPlayer.id) {
                    Triple(it.getString(1), EconomyWallet(it.getLong(2), it.getLong(3)), economyJson.decodeFromString<Map<String, Long>>(it.getString(4))) }
                assertEquals(2, ledger.size)
                assertEquals("legacy_conversion", ledger[0].first); assertEquals(EconomyWallet(), ledger[0].second)
                assertEquals("starting_pack", ledger[1].first); assertEquals(first.wallet, ledger[1].second); assertEquals(first.inventory, ledger[1].third)
                // Existing audit prevents an administrative removal from reissuing the starting pack.
                c.economyUpdate("DELETE FROM economy_profiles WHERE user_id=?", newPlayer.id)
                c.commit()
            }
            val reset = economy.snapshot(newToken.hash)
            assertEquals(EconomyWallet(), reset.wallet); assertTrue(reset.inventory.isEmpty())
        }
    }

    @Test fun `parallel tutorial receipts persist one gift and reward across repository sessions`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Ученик", tokens.issue().hash, token.hash, 365)
            val repository = JdbcEconomyRepository(source); val before = repository.snapshot(token.hash)
            val gift = EconomyCommand(UUID.randomUUID().toString(), player.publicId, before.revision, "claim_tutorial_order", EconomyTutorialOrders.ID)
            val gifts = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(token.hash, gift) } }.awaitAll() }
            assertEquals(1, gifts.count { it.replayed })
            val accepted = JdbcEconomyRepository(source).snapshot(token.hash)
            assertTrue(accepted.tutorialOrder.ingredientsClaimed)
            assertEquals(before.revision + 1, accepted.revision)
            val submit = gift.copy(requestId = UUID.randomUUID().toString(), expectedRevision = accepted.revision, action = "complete_resident_order")
            val completed = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(token.hash, submit) } }.awaitAll() }
            assertEquals(1, completed.count { it.replayed })
            val after = repository.snapshot(token.hash)
            assertTrue(after.tutorialOrder.completed)
            assertEquals(before.inventory, after.inventory); assertEquals(before.wallet.coins + 100, after.wallet.coins)
            assertEquals(before.wallet.pearls, after.wallet.pearls)
            assertEquals(accepted.revision, repository.command(token.hash, gift).acceptedRevision)
            assertEquals(after.wallet, repository.command(token.hash, submit).state.wallet)
            assertEquals("ECONOMY_TUTORIAL_ORDER_CLAIMED", assertFailsWith<AuthFailure> {
                repository.command(token.hash, gift.copy(requestId = UUID.randomUUID().toString(), expectedRevision = after.revision)) }.code)
            assertEquals("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", assertFailsWith<AuthFailure> {
                repository.command(token.hash, submit.copy(requestId = UUID.randomUUID().toString(), expectedRevision = after.revision)) }.code)
            source.connection.use { c ->
                assertEquals(1L, c.economyRows("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='claim_tutorial_order'", player.id) { it.getLong(1) }.single())
                assertEquals(1L, c.economyRows("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='complete_resident_order'", player.id) { it.getLong(1) }.single())
                val stored = readEconomyProfile(c, player.id).state
                assertTrue(stored.tutorialOrder.ingredientsClaimed); assertTrue(stored.tutorialOrder.completed)
            }
        }
    }
}
