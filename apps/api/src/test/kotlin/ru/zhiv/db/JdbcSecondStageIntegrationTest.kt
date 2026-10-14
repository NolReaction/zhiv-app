package ru.zhiv.db

import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.security.TokenCodec
import java.sql.SQLException
import java.time.Instant
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcSecondStageIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    @Container private val postgres = Postgres("postgres:18-alpine")
    private fun config() = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))

    @Test fun `stage quotes do not write on reads failures do not pin and racing submissions pay each saved order once`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Второй этап", tokens.issue().hash, token.hash, 365)
            val repository = JdbcEconomyRepository(source)
            repository.snapshot(token.hash)
            source.connection.use { c ->
                val stored = readEconomyProfile(c, player.id).state
                val ready = stored.copy(wallet = EconomyWallet(50), inventory = emptyMap(), buildings = stored.buildings + ("home" to 2),
                    tutorialOrder = stored.tutorialOrder.copy(step = 4, completed = true))
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(ready), player.id)
                c.commit()
            }
            val course = EconomyRules.catalog.stageOrders.single { it.homeLevel == 2 }
            assertEquals(7, course.orders.size)
            val quote = repository.snapshot(token.hash)
            assertEquals(course.orders.first(), quote.stageOrders.stages.getValue("2").terms)
            source.connection.use { c -> assertTrue(readEconomyProfile(c, player.id).state.stageOrders.stages.isEmpty()) }
            val missing = EconomyCommand(UUID.randomUUID().toString(), player.publicId, quote.revision, "complete_resident_order", course.orders.first().id)
            assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { repository.command(token.hash, missing) }.code)
            assertEquals(quote.revision, repository.snapshot(token.hash).revision)
            source.connection.use { c ->
                val stored = readEconomyProfile(c, player.id).state
                assertTrue(stored.stageOrders.stages.isEmpty())
                val goods = course.orders.flatMap { it.items.entries }.groupBy { it.key }.mapValues { (_, entries) -> entries.sumOf { it.value } }
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(inventory = goods)), player.id)
                c.commit()
            }
            var current = repository.snapshot(token.hash)
            for ((index, terms) in course.orders.withIndex()) {
                val request = EconomyCommand(UUID.randomUUID().toString(), player.publicId, current.revision, "complete_resident_order", terms.id)
                val results = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(token.hash, request) } }.awaitAll() }
                assertEquals(1, results.count { it.replayed })
                current = repository.snapshot(token.hash)
                assertEquals(index + 1, current.stageOrders.stages.getValue("2").step)
                assertEquals(index == course.orders.lastIndex, current.stageOrders.stages.getValue("2").completed)
                assertEquals("ECONOMY_STAGE_ORDER_UNAVAILABLE", assertFailsWith<AuthFailure> {
                    repository.command(token.hash, request.copy(requestId = UUID.randomUUID().toString(), expectedRevision = current.revision)) }.code)
                assertEquals(current.wallet, repository.command(token.hash, request).state.wallet)
            }
            assertEquals(50 + course.orders.sumOf { it.coins }, current.wallet.coins)
            assertTrue(current.inventory.isEmpty())
            source.connection.use { c ->
                assertEquals(current.stageOrders, readEconomyProfile(c, player.id).state.stageOrders)
                assertEquals(course.orders.size.toLong(), c.economyRows("SELECT count(*) FROM economy_commands WHERE user_id=?", player.id) { it.getLong(1) }.single())
                assertEquals(course.orders.size.toLong(), c.economyRows("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='complete_resident_order'", player.id) { it.getLong(1) }.single())
            }
        }
    }

    @Test fun `V51 persists seventeen and eighteen legitimate parallel jobs and rejects a nineteenth without losing saved work`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Полные очереди", tokens.issue().hash, token.hash, 365)
            val repository = JdbcEconomyRepository(source)
            repository.snapshot(token.hash)
            val warehouse = EconomyRules.catalog.buildings.single { it.id == "warehouse" }.levels.single { it.level == 10 }
            source.connection.use { c ->
                val stored = readEconomyProfile(c, player.id).state
                val ready = stored.copy(wallet = EconomyWallet(100_000_000),
                    inventory = EconomyRules.addItems(warehouse.cost.items, mapOf("wood" to 6L, "berries" to 6L)),
                    buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.last().level } + ("warehouse" to 9),
                    productionSlots = mapOf("garden" to 3, "woodlot" to 3, "workshop" to 3, "dryer" to 3, "kiln" to 3))
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(ready), player.id)
                c.commit()
            }
            var current = repository.snapshot(token.hash)
            suspend fun act(action: String, target: String) {
                current = repository.command(token.hash, EconomyCommand(UUID.randomUUID().toString(), player.publicId, current.revision, action, target)).state
            }
            for (recipe in listOf("grow_berries", "gather_wood", "make_planks", "cook_compote", "make_charcoal")) repeat(3) { act("start_production", recipe) }
            assertEquals(15, current.jobs.size)
            act("start_exploration", "forest")
            act("start_exploration", "quarry_stone")
            assertEquals(17, current.jobs.size)
            source.connection.use { c -> assertEquals(17, readEconomyProfile(c, player.id).state.jobs.size) }
            act("start_construction", "warehouse")
            assertEquals(18, current.jobs.size)
            val public = economyJson.encodeToJsonElement(current).jsonObject
            assertFalse("minerRareDropState" in public); assertFalse("rareDropState" in public)
            source.connection.use { c ->
                val saved = readEconomyProfile(c, player.id).state
                assertEquals(18, saved.jobs.size)
                val invalid = saved.copy(jobs = saved.jobs + saved.jobs.first().copy(id = UUID.randomUUID().toString()))
                assertFailsWith<SQLException> {
                    c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(invalid), player.id) }
                c.rollback()
            }
            source.connection.use { c -> assertEquals(current.jobs, readEconomyProfile(c, player.id).state.jobs) }
        }
    }

    @Test fun `account merge preserves furthest stage terms and merges the two private rare clocks independently`() = runBlocking<Unit> {
        DatabaseFactory.create(config()).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val firstToken = tokens.issue(); val secondToken = tokens.issue()
            val identities = JdbcZhivRepository(source)
            val first = identities.bootstrap("Первый курс", tokens.issue().hash, firstToken.hash, 365)
            val second = identities.bootstrap("Продвинутый курс", tokens.issue().hash, secondToken.hash, 365)
            val repository = JdbcEconomyRepository(source)
            repository.snapshot(firstToken.hash); repository.snapshot(secondToken.hash)
            val course = EconomyRules.catalog.stageOrders.single { it.homeLevel == 2 }
            val heroFar = EconomyRareDropClock(remainingSeconds = 400_000, itemId = "moon_crystal")
            val minerFar = EconomyRareDropClock(remainingSeconds = 450_000, itemId = "living_resin")
            source.connection.use { c ->
                for ((user, step) in listOf(first.id to 1, second.id to 3)) {
                    val stored = readEconomyProfile(c, user).state
                    val next = stored.copy(wallet = EconomyWallet(100), inventory = emptyMap(), buildings = stored.buildings + ("home" to 2),
                        tutorialOrder = stored.tutorialOrder.copy(step = 4, completed = true),
                        stageOrders = EconomyStageOrderState(stages = mapOf("2" to EconomyStageOrderProgress(step, false, course.orders[step]))),
                        rareDropState = if (user == first.id) heroFar else EconomyRareDropClock(remainingSeconds = 500, itemId = "ancient_core"),
                        minerRareDropState = if (user == second.id) minerFar else EconomyRareDropClock(remainingSeconds = 1000, itemId = "ancient_core"))
                    c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(next), user)
                }
                c.commit()
            }
            source.connection.use { c ->
                for (user in listOf(first.id, second.id).sorted()) c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", user) { true }
                mergeEconomyProfiles(c, first.id, second.id)
                c.commit()
            }
            source.connection.use { c ->
                val merged = readEconomyProfile(c, first.id).state
                assertEquals(EconomyWallet(200), merged.wallet)
                assertEquals(3, merged.stageOrders.stages.getValue("2").step)
                assertEquals(course.orders[3], merged.stageOrders.stages.getValue("2").terms)
                assertEquals(heroFar, merged.rareDropState); assertEquals(minerFar, merged.minerRareDropState)
                assertTrue(merged.jobs.isEmpty())
            }
        }
    }

}
