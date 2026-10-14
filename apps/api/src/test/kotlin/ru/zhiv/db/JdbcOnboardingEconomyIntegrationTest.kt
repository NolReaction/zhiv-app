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

    @Test fun `V50 preserves saved economies and initializes only future profiles with the small catalog pack`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration/history").target("45").load().migrate()
            val tokens = TokenCodec(); val token = tokens.issue()
            val identities = JdbcZhivRepository(source)
            val old = identities.bootstrap("Сохранённый", tokens.issue().hash, token.hash, 365)
            val saved = EconomyRules.initial(includeStartingPack = false).copy(wallet = EconomyWallet(27, 8), inventory = mapOf("stone" to 2L))
            source.connection.use { c ->
                c.economyUpdate("INSERT INTO economy_profiles(user_id,state,revision) VALUES (?,?::jsonb,7)", old.id, economyJson.encodeToString(saved))
                c.commit()
            }
            repeat(2) {
                Flyway.configure().dataSource(source).locations("classpath:db/migration").target("50").load().migrate()
            }
            source.connection.use { c ->
                val preserved = readEconomyProfile(c, old.id)
                assertEquals(7L, preserved.revision)
                assertEquals(saved.wallet, preserved.state.wallet); assertEquals(saved.inventory, preserved.state.inventory)
                assertEquals(saved, c.economyRows("SELECT state FROM economy_profiles WHERE user_id=?", old.id) {
                    economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single(), "V50 does not rewrite saved economies")
                for (include in listOf(true, false)) {
                    val legacy = WorldState(resources = WorldResources(sparks = 100, wood = 81, stone = 49), houseLevel = 4, workshop = true, workshopLevel = 2)
                    val initialized = c.economyRows("SELECT economy_v4_initial_state(?::jsonb,?)", worldJson.encodeToString(legacy), include) {
                        economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single()
                    // The V50 initializer changes future packs only and contains no gifted fish.
                    assertEquals(0L, initialized.inventory["fish"] ?: 0L)
                    assertFalse(initialized.inventory.containsKey("fish_common"))
                    assertEquals(EconomyRules.initial(100, 81, 49, 4, 2, includeStartingPack = include).copy(itemUnlockVersion = 0),
                        EconomyFishInventory.state(initialized))
                }
            }
            DatabaseFactory.migrate(source); DatabaseFactory.migrate(source)
            source.connection.use { c ->
                assertEquals(8L, readEconomyProfile(c, old.id).revision, "V52 fences item knowledge once")
                assertEquals(saved.copy(unlockedItems = listOf("stone")), c.economyRows("SELECT state FROM economy_profiles WHERE user_id=?", old.id) {
                    economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single(), "Current migration adds knowledge without changing the starter budget")
                for (include in listOf(true, false)) {
                    val legacy = WorldState(resources = WorldResources(sparks = 100, wood = 81, stone = 49), houseLevel = 4, workshop = true, workshopLevel = 2)
                    val initialized = c.economyRows("SELECT economy_v4_initial_state(?::jsonb,?)", worldJson.encodeToString(legacy), include) {
                        economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single()
                    assertEquals(EconomyRules.initial(100, 81, 49, 4, 2, includeStartingPack = include),
                        EconomyFishInventory.state(initialized), "The current initializer adds the item knowledge marker and five market slots")
                }
            }
            val newToken = tokens.issue(); val newPlayer = identities.bootstrap("Новичок", tokens.issue().hash, newToken.hash, 365)
            val economy = JdbcEconomyRepository(source)
            val first = economy.snapshot(newToken.hash)
            assertEquals(EconomyWallet(100, 0), first.wallet)
            assertEquals(mapOf("wood" to 3L, "stone" to 5L), first.inventory)
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

    @Test fun `parallel legacy tutorial receipts pin terms without gifting goods and pay once`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Ученик", tokens.issue().hash, token.hash, 365)
            val repository = JdbcEconomyRepository(source)
            repository.snapshot(token.hash)
            val terms = EconomyResidentOrderTemplate(EconomyTutorialOrders.ID, "builder", "Старый заказ", items = mapOf("berries" to 3L, "wood" to 2L), coins = 100)
            source.connection.use { c ->
                val stored = readEconomyProfile(c, player.id).state
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",
                    economyJson.encodeToString(stored.copy(inventory = terms.items, tutorialOrder = EconomyTutorialOrder(terms = terms))), player.id)
                c.commit()
            }
            val before = repository.snapshot(token.hash)
            val gift = EconomyCommand(UUID.randomUUID().toString(), player.publicId, before.revision, "claim_tutorial_order", EconomyTutorialOrders.ID)
            val gifts = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(token.hash, gift) } }.awaitAll() }
            assertEquals(1, gifts.count { it.replayed })
            val accepted = JdbcEconomyRepository(source).snapshot(token.hash)
            assertTrue(accepted.tutorialOrder.ingredientsClaimed)
            assertEquals(before.revision + 1, accepted.revision)
            assertEquals(before.inventory, accepted.inventory); assertEquals(before.wallet, accepted.wallet)
            val submit = gift.copy(requestId = UUID.randomUUID().toString(), expectedRevision = accepted.revision, action = "complete_resident_order")
            val completed = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(token.hash, submit) } }.awaitAll() }
            assertEquals(1, completed.count { it.replayed })
            val after = repository.snapshot(token.hash)
            assertTrue(after.tutorialOrder.completed)
            assertTrue(after.inventory.isEmpty()); assertEquals(before.wallet.coins + 100, after.wallet.coins)
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

    @Test fun `fresh four-order course persists sequential progress and racing receipts pay once per step`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Четыре заказа", tokens.issue().hash, token.hash, 365)
            val repository = JdbcEconomyRepository(source)
            repository.snapshot(token.hash)
            source.connection.use { c ->
                val stored = readEconomyProfile(c, player.id).state
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",
                    economyJson.encodeToString(stored.copy(inventory = mapOf("berries" to 2L, "wood" to 2L, "berry_compote" to 2L, "planks" to 2L))), player.id)
                c.commit()
            }
            var current = repository.snapshot(token.hash)
            val initialCoins = current.wallet.coins
            for ((index, terms) in EconomyTutorialOrders.orders(EconomyRules.catalog.onboarding!!).withIndex()) {
                assertEquals(index, current.tutorialOrder.step); assertEquals(terms, current.tutorialOrder.terms)
                val request = EconomyCommand(UUID.randomUUID().toString(), player.publicId, current.revision,
                    "complete_resident_order", terms.id)
                val responses = coroutineScope { List(2) { async(Dispatchers.IO) {
                    JdbcEconomyRepository(source).command(token.hash, request) } }.awaitAll() }
                assertEquals(1, responses.count { it.replayed })
                current = repository.snapshot(token.hash)
                assertEquals(index + 1, current.tutorialOrder.step)
                assertEquals(index == 3, current.tutorialOrder.completed)
                assertEquals(current.wallet, repository.command(token.hash, request).state.wallet)
                assertEquals("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", assertFailsWith<AuthFailure> {
                    repository.command(token.hash, request.copy(requestId = UUID.randomUUID().toString(), expectedRevision = current.revision)) }.code)
            }
            assertEquals(initialCoins + 330, current.wallet.coins); assertTrue(current.inventory.isEmpty())
            source.connection.use { c ->
                assertEquals(4L, c.economyRows("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='complete_resident_order'", player.id) { it.getLong(1) }.single())
                assertEquals(4L, c.economyRows("SELECT count(*) FROM economy_commands WHERE user_id=?", player.id) { it.getLong(1) }.single())
                assertEquals(current.tutorialOrder, readEconomyProfile(c, player.id).state.tutorialOrder)
            }
        }
    }

}
