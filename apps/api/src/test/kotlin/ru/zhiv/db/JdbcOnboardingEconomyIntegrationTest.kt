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

    @Test fun `V53 preserves saved economies and initializes only future profiles with the small catalog pack`() = runBlocking<Unit> {
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
                Flyway.configure().dataSource(source).locations("classpath:db/migration").target("53").load().migrate()
            }
            source.connection.use { c ->
                val preserved = readEconomyProfile(c, old.id)
                assertEquals(7L, preserved.revision)
                assertEquals(saved.wallet, preserved.state.wallet); assertEquals(saved.inventory, preserved.state.inventory)
                assertEquals(saved, c.economyRows("SELECT state FROM economy_profiles WHERE user_id=?", old.id) {
                    economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single(), "V53 does not rewrite saved economies")
                for (include in listOf(true, false)) {
                    val legacy = WorldState(resources = WorldResources(sparks = 100, wood = 81, stone = 49), houseLevel = 4, workshop = true, workshopLevel = 2)
                    val initialized = c.economyRows("SELECT economy_v4_initial_state(?::jsonb,?)", worldJson.encodeToString(legacy), include) {
                        economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single()
                    // The V53 initializer changes future packs only and contains no gifted fish.
                    assertEquals(0L, initialized.inventory["fish"] ?: 0L)
                    assertFalse(initialized.inventory.containsKey("fish_common"))
                    val expected = EconomyRules.initial(100, 81, 49, 4, 2, includeStartingPack = include)
                    // Published SQL initializers omit later optional building keys; absence is level zero.
                    val publishedTutorial = if (include) EconomyTutorialOrder(
                        version = 2, ingredientsClaimed = true,
                        terms = EconomyResidentOrderTemplate("tutorial_first_order", "builder", "Первая малина",
                            description = "Вырасти и собери две малины для первого заказа. Учебная просьба не исчезнет.",
                            items = mapOf("berries" to 2L), coins = 30L),
                    ) else expected.tutorialOrder
                    assertEquals(expected.copy(itemUnlockVersion = 0, tutorialOrder = publishedTutorial,
                        buildings = expected.buildings - setOf("bridge", "lighthouse")), EconomyFishInventory.state(initialized))
                }
            }
            DatabaseFactory.migrate(source); DatabaseFactory.migrate(source)
            source.connection.use { c ->
                assertEquals(8L, readEconomyProfile(c, old.id).revision, "V55 fences item knowledge once")
                assertEquals(saved.copy(unlockedItems = listOf("stone")), c.economyRows("SELECT state FROM economy_profiles WHERE user_id=?", old.id) {
                    economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single(), "Current migration adds knowledge without changing the starter budget")
                for (include in listOf(true, false)) {
                    val legacy = WorldState(resources = WorldResources(sparks = 100, wood = 81, stone = 49), houseLevel = 4, workshop = true, workshopLevel = 2)
                    val initialized = c.economyRows("SELECT economy_v4_initial_state(?::jsonb,?)", worldJson.encodeToString(legacy), include) {
                        economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single()
                    val expected = EconomyRules.initial(100, 81, 49, 4, 2, includeStartingPack = include)
                    assertEquals(expected.copy(buildings = expected.buildings - setOf("bridge", "lighthouse")),
                        EconomyFishInventory.state(initialized), "The current initializer adds one introductory berry order, the knowledge marker and five market slots")
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

    @Test fun `saved second request is projected without a GET write and its original receipt still pays once`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Старый курс", tokens.issue().hash, token.hash, 365)
            val repository = JdbcEconomyRepository(source)
            repository.snapshot(token.hash)
            val terms = EconomyResidentOrderTemplate("tutorial_wood_order", "builder", "Сохранённые брёвна",
                items = mapOf("wood" to 2L), coins = 97L)
            source.connection.use { c ->
                val stored = readEconomyProfile(c, player.id).state
                c.economyUpdate("UPDATE economy_profiles SET revision=9,state=?::jsonb WHERE user_id=?",
                    economyJson.encodeToString(stored.copy(wallet = EconomyWallet(123, 7), inventory = terms.items,
                        tutorialOrder = EconomyTutorialOrder(version = 2, step = 1, ingredientsClaimed = true, terms = terms),
                        stageOrders = EconomyStageOrderState())), player.id)
                c.commit()
            }
            fun savedRow() = source.connection.use { c ->
                c.economyRows("SELECT to_jsonb(p)::text FROM economy_profiles p WHERE user_id=?", player.id) { it.getString(1) }.single()
            }
            val before = savedRow()
            val projected = repository.snapshot(token.hash)
            assertEquals(9L, projected.revision)
            assertEquals(3, projected.tutorialOrder.version)
            assertTrue(projected.tutorialOrder.completed)
            assertEquals(0, projected.stageOrders.stages.getValue("1").step)
            assertEquals(terms, projected.stageOrders.stages.getValue("1").terms)
            assertEquals(EconomyWallet(123, 7), projected.wallet)
            assertEquals(before, savedRow(), "Reading a v2 course must not rewrite its state, timestamp or revision")
            val request = EconomyCommand(UUID.randomUUID().toString(), player.publicId, projected.revision,
                "complete_resident_order", terms.id)
            val accepted = repository.command(token.hash, request)
            val replayed = repository.command(token.hash, request)
            assertTrue(replayed.replayed)
            assertEquals(accepted.acceptedRevision, replayed.acceptedRevision)
            val after = repository.snapshot(token.hash)
            assertEquals(10L, after.revision)
            assertEquals(EconomyWallet(220, 7), after.wallet)
            assertTrue(after.inventory.isEmpty())
            assertEquals(1, after.stageOrders.stages.getValue("1").step)
            assertEquals("stage1_compote_order", after.stageOrders.stages.getValue("1").terms?.id)
            source.connection.use { c ->
                assertEquals(3, readEconomyProfile(c, player.id).state.tutorialOrder.version)
                assertEquals(1L, c.economyRows("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='complete_resident_order'", player.id) { it.getLong(1) }.single())
            }
        }
    }

    @Test fun `one intro and three first-stage requests persist independently and racing receipts pay once`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Первый этап", tokens.issue().hash, token.hash, 365)
            val repository = JdbcEconomyRepository(source)
            repository.snapshot(token.hash)
            source.connection.use { c ->
                val stored = readEconomyProfile(c, player.id).state
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",
                    economyJson.encodeToString(stored.copy(inventory = mapOf("berries" to 1L, "wood" to 2L,
                        "berry_compote" to 2L, "planks" to 2L))), player.id)
                c.commit()
            }
            var current = repository.snapshot(token.hash)
            val initialCoins = current.wallet.coins
            val intro = EconomyTutorialOrders.orders(EconomyRules.catalog.onboarding!!).single()
            assertEquals(mapOf("berries" to 1L), intro.items)
            val requests = listOf(intro) + EconomyRules.catalog.stageOrders.single { it.homeLevel == 1 }.orders
            for ((index, terms) in requests.withIndex()) {
                if (index == 0) {
                    assertEquals(0, current.tutorialOrder.step)
                    assertFalse(current.tutorialOrder.completed)
                    assertEquals(terms, current.tutorialOrder.terms)
                } else {
                    assertEquals(1, current.tutorialOrder.step)
                    assertTrue(current.tutorialOrder.completed)
                    assertEquals(index - 1, current.stageOrders.stages.getValue("1").step)
                    assertEquals(terms, current.stageOrders.stages.getValue("1").terms)
                }
                val request = EconomyCommand(UUID.randomUUID().toString(), player.publicId, current.revision,
                    "complete_resident_order", terms.id)
                val responses = coroutineScope { List(2) { async(Dispatchers.IO) {
                    JdbcEconomyRepository(source).command(token.hash, request) } }.awaitAll() }
                assertEquals(1, responses.count { it.replayed })
                current = repository.snapshot(token.hash)
                assertTrue(current.tutorialOrder.completed)
                assertEquals(current.wallet, repository.command(token.hash, request).state.wallet)
                val code = if (index == 0) "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" else "ECONOMY_STAGE_ORDER_UNAVAILABLE"
                assertEquals(code, assertFailsWith<AuthFailure> {
                    repository.command(token.hash, request.copy(requestId = UUID.randomUUID().toString(),
                        expectedRevision = current.revision)) }.code)
            }
            assertEquals(initialCoins + requests.sumOf { it.coins }, current.wallet.coins)
            assertTrue(current.inventory.isEmpty())
            assertEquals(3, current.stageOrders.stages.getValue("1").step)
            assertTrue(current.stageOrders.stages.getValue("1").completed)
            source.connection.use { c ->
                assertEquals(4L, c.economyRows("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='complete_resident_order'", player.id) { it.getLong(1) }.single())
                assertEquals(4L, c.economyRows("SELECT count(*) FROM economy_commands WHERE user_id=?", player.id) { it.getLong(1) }.single())
                val stored = readEconomyProfile(c, player.id).state
                assertEquals(current.tutorialOrder, stored.tutorialOrder)
                assertEquals(current.stageOrders, stored.stageOrders)
            }
        }
    }
}
