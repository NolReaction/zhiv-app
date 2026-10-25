package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyOrderProgressionTest {
    private val now = Instant.parse("2026-10-07T12:00:00Z")
    private val catalog = EconomyRules.catalog
    @Serializable private data class ScaleVector(val templateId: String, val home: Int, val items: Map<String, Long>, val coins: Long)
    @Serializable private data class AvailabilityVector(val label: String, val buildings: Map<String, Int>, val ownedRods: List<String>,
        val ownedHooks: List<String>, val present: List<String>, val missing: List<String>)
    @Serializable private data class Vectors(val scaling: List<ScaleVector>, val availability: List<AvailabilityVector>)
    private val vectors = economyJson.decodeFromString<Vectors>(checkNotNull(javaClass.getResourceAsStream("/world/orders-progression-vectors.json"))
        .bufferedReader().use { it.readText() })
    @Serializable private data class BalanceVector(val templateId: String, val home: Int, val items: Map<String, Long>,
        val npcValue: Long, val manufacturingSeconds: Long,
        val previousCoins: Long = 0, val coins: Long)
    @Serializable private data class BalanceVectors(val policy: String, val npcValueMultiplierNumerator: Long,
        val npcValueMultiplierDenominator: Long, val manufacturingCoinsPerMinute: Long, val roundingCoins: Long,
        val orders: List<BalanceVector>)

    @Serializable private data class TimeBalanceVectors(val policy: String, val catalogVersion: Int,
        val orderBonusBps: Long, val roundingCoins: Long, val orders: List<BalanceVector>)

    @Test fun `historical v12 balance vectors preserve their original mathematical contract`() {
        val previous = economyJson.decodeFromString<BalanceVectors>(checkNotNull(javaClass.getResourceAsStream("/world/resident-order-balance-vectors.json"))
            .bufferedReader().use { it.readText() })
        assertEquals("npc-value-plus-manufacturing-time", previous.policy)
        assertEquals(85, previous.orders.size)
        assertEquals(3L, previous.npcValueMultiplierNumerator)
        assertEquals(2L, previous.npcValueMultiplierDenominator)
        assertEquals(1L, previous.manufacturingCoinsPerMinute)
        assertEquals(10L, previous.roundingCoins)
        previous.orders.forEach { row ->
            assertEquals((row.npcValue * 90 + row.manufacturingSeconds + 599) / 600 * 10, row.coins, row.templateId)
            assertTrue(row.coins >= row.previousCoins)
        }
    }

    @Test fun `all v13 orders include baseline item value and one final 25 percent bonus in shared browser vectors`() {
        val balance = economyJson.decodeFromString<TimeBalanceVectors>(checkNotNull(javaClass.getResourceAsStream("/world/time-economy-order-vectors.json"))
            .bufferedReader().use { it.readText() })
        assertEquals("baseline-time-value-plus-order-bonus", balance.policy)
        assertEquals(13, balance.catalogVersion)
        assertEquals(2500L, balance.orderBonusBps)
        assertEquals(1L, balance.roundingCoins)
        val templates = catalog.food!!.orders.templates.associateBy { it.id }
        val items = catalog.items.associateBy { it.id }
        val manufacturingRecipes = catalog.recipes.filter { !it.retired && it.cost.items.isNotEmpty() && it.rewards.size == 1 }
            .groupBy { it.rewards.keys.single() }
        val canonicalRecipeIds = catalog.timeEconomy!!.baselineRecipes
        fun manufacturingRecipe(itemId: String): EconomyRecipe? {
            val candidates = manufacturingRecipes[itemId] ?: return null
            val canonicalId = canonicalRecipeIds[itemId]
            return if (canonicalId == null) candidates.single() else candidates.single { it.id == canonicalId }
        }
        val memo = mutableMapOf<String, Long>()
        fun manufacturingSeconds(itemId: String, active: Set<String> = emptySet()): Long {
            memo[itemId]?.let { return it }
            assertFalse(itemId in active, "Cyclic production chain: $active -> $itemId")
            val recipe = manufacturingRecipe(itemId)
            val seconds = if (recipe == null) 0L else {
                val total = recipe.seconds + recipe.cost.items.entries.sumOf { (inputId, quantity) ->
                    quantity * manufacturingSeconds(inputId, active + itemId)
                }
                val quantity = recipe.rewards.getValue(itemId)
                assertEquals(0L, total % quantity, "Shared whole-second vectors must represent ${recipe.id} exactly")
                total / quantity
            }
            memo[itemId] = seconds
            return seconds
        }
        fun assertRecipeAvailable(recipe: EconomyRecipe, buildings: Map<String, Int>, label: String, active: Set<String> = emptySet()) {
            assertFalse(recipe.id in active, "$label: cyclic recipe prerequisite")
            assertTrue(recipe.requiredHomeLevel <= buildings.getValue("home"), "$label: ${recipe.id} needs a future home")
            assertTrue(recipe.effectiveBuildingLevel <= (buildings[recipe.buildingId] ?: 0), "$label: ${recipe.id} needs a future station")
            recipe.requiredBuildings.forEach { (id, level) ->
                assertTrue(level <= (buildings[id] ?: 0), "$label: ${recipe.id} needs future $id")
            }
            val inputRecipes = recipe.cost.items.keys.mapNotNull(::manufacturingRecipe)
            val prerequisites = recipe.requiredRecipes.keys.map { id -> catalog.recipes.single { it.id == id } }
            (inputRecipes + prerequisites).distinctBy { it.id }.forEach { dependency ->
                assertRecipeAvailable(dependency, buildings, label, active + recipe.id)
            }
        }
        val baselineIds = balance.orders.map { it.templateId }.toSet()
        assertEquals(127, baselineIds.size, "Every current ordinary order has an independently calculated vector")
        assertEquals(baselineIds, templates.keys)
        assertEquals(127, balance.orders.size)
        balance.orders.forEach { expected ->
            val source = templates.getValue(expected.templateId)
            assertEquals(source.requiredHomeLevel, expected.home, source.id)
            val startingBuildings = mapOf("home" to source.requiredHomeLevel, "garden" to 1, "warehouse" to 1) + source.requiredBuildings
            source.items.keys.mapNotNull(::manufacturingRecipe).forEach { assertRecipeAvailable(it, startingBuildings, source.id) }
            for (home in 1..5) {
                val actual = EconomyFood.progressedTemplate(source, home)
                val label = "${expected.templateId}@$home"
                val npcValue = actual.items.entries.sumOf { (id, quantity) -> quantity * items.getValue(id).baseSellPrice }
                val seconds = actual.items.entries.sumOf { (id, quantity) -> quantity * manufacturingSeconds(id) }
                // Manufacturing time is already included recursively in item prices.
                val quotedCoins = (npcValue * (10000L + balance.orderBonusBps) + 9999L) / 10000L
                assertEquals(expected.items, actual.items, label)
                assertEquals(expected.npcValue, npcValue, label)
                assertEquals(expected.manufacturingSeconds, seconds, label)
                assertEquals(expected.coins, quotedCoins, label)
                assertEquals(expected.coins, actual.coins, label)
            }
        }
        assertEquals(0L, manufacturingSeconds("berries"))
        assertEquals(0L, manufacturingSeconds("fiber"))
        assertEquals(0L, manufacturingSeconds("fish_common"))
        assertEquals(17 * 60L, manufacturingSeconds("iron_ingot"), "Early smelting plus charcoal uses the explicit baseline")
    }

    @Test fun `browser and Kotlin share scaled quotes and complete dependency reachability`() {
        vectors.scaling.forEach { expected ->
            val source = catalog.food!!.orders.templates.single { it.id == expected.templateId }
            val actual = EconomyFood.progressedTemplate(source, expected.home)
            assertEquals(expected.items, actual.items, "${expected.templateId}@${expected.home}")
            assertEquals(expected.coins, actual.coins, "${expected.templateId}@${expected.home}")
        }
        vectors.availability.forEach { scenario ->
            val state = EconomyRules.initial().copy(buildings = scenario.buildings,
                inventory = catalog.items.associate { it.id to 100L },
                fishing = EconomyFishing(ownedRods = scenario.ownedRods, ownedHooks = scenario.ownedHooks))
            val reachable = EconomyFood.obtainableOrderItems(state)
            scenario.present.forEach { assertTrue(it in reachable, "${scenario.label}: expected $it") }
            scenario.missing.forEach { assertFalse(it in reachable, "${scenario.label}: unexpected $it") }
            EconomyFood.eligibleOrderTemplates(state).forEach { order ->
                assertTrue(order.items.keys.all { it in reachable }, "${scenario.label}: ${order.id}")
            }
        }
    }

    @Test fun `every ordinary material appears once its full production chain is open`() {
        val onlyHome = EconomyRules.initial().copy(buildings = mapOf("home" to 5, "garden" to 1, "warehouse" to 1))
        val lockedItems = setOf("ore", "clay", "sand", "hardwood", "resin", "charcoal", "iron_ingot", "reinforced_parts")
        assertTrue(EconomyFood.eligibleOrderTemplates(onlyHome).all { order -> order.items.keys.none { it in lockedItems } })
        val allBuildings = onlyHome.copy(buildings = catalog.buildings.associate { it.id to it.levels.last().level })
        val requested = EconomyFood.eligibleOrderTemplates(allBuildings).flatMap { it.items.keys }.toSet()
        catalog.items.filter { it.category in setOf("material", "crafted") }.forEach { assertTrue(it.id in requested, it.id) }
    }

    @Test fun `saved card terms survive home upgrades catalog removals and JSON roundtrips`() {
        val initial = EconomyRules.initial()
        val saved = initial.copy(residentOrders = EconomyFood.normalizedOrders(initial, now))
        val before = EconomyFood.residentOrderBoard(saved, now)
        val changedCatalog = catalog.copy(food = catalog.food!!.copy(orders = catalog.food!!.orders.copy(
            templates = catalog.food!!.orders.templates.filter { it.id != before.offers.first().templateId }
                .map { it.copy(coins = it.coins * 2, items = it.items.mapValues { (_, count) -> count + 1 }) })))
        val upgraded = saved.copy(buildings = saved.buildings + ("home" to 5))
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(upgraded))
        assertEquals(before.offers, EconomyFood.residentOrderBoard(restored, now.plusSeconds(1), changedCatalog).offers)
        val changed = restored.copy(residentOrders = EconomyFood.advanceResidentOrder(restored, 1, now, changedCatalog))
        assertEquals(before.offers.filter { it.slot != 1 }, EconomyFood.residentOrderBoard(changed, now, changedCatalog).offers.filter { it.slot != 1 })
    }

    @Test fun `income boost preserves and pays an already saved 400 coin delivery`() {
        val template = catalog.food!!.orders.templates.single { it.id == "builder_wood_supply" }
        assertEquals(75L, template.coins)
        val initial = EconomyRules.initial()
        val board = EconomyFood.normalizedOrders(initial, now)
        val slots = board.slots.toMutableList()
        slots[1] = EconomyResidentOrderSlot(3, now.toString(), template.id, template.copy(coins = 400, items = mapOf("wood" to 8L)))
        val saved = initial.copy(residentOrders = board.copy(slots = slots), inventory = mapOf("wood" to 8L))
        val offer = EconomyFood.residentOrderBoard(saved, now).offers.single { it.slot == 1 }
        assertEquals(400L, offer.coins); assertEquals(mapOf("wood" to 8L), offer.items)
        val completed = EconomyRules.apply(saved, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0,
            "complete_resident_order", offer.id, 1, 0), now).first
        assertEquals(initial.wallet.coins + 400, completed.wallet.coins)
        assertEquals(400L, completed.residentOrders.earnedCoins)
        val next = EconomyFood.residentOrderBoard(completed, now).offers.single { it.slot == 1 }
        assertEquals(catalog.food!!.orders.templates.single { it.id == next.templateId }.coins, next.coins)
    }

    @Test fun `saved 180 coin trail snack survives reload and catalog update while the next card quotes 288`() {
        val updated = catalog.food!!.orders.templates.single { it.id == "builder_trail_snack" }
        assertEquals(288L, updated.coins)
        fun onlySnack(terms: EconomyResidentOrderTemplate) = catalog.copy(food = catalog.food!!.copy(
            orders = catalog.food!!.orders.copy(templates = listOf(terms))))
        val previousCatalog = onlySnack(updated.copy(coins = 180))
        val updatedCatalog = onlySnack(updated)
        val initial = EconomyRules.initial().copy(
            buildings = catalog.buildings.associate { it.id to it.levels.last().level }, inventory = updated.items,
            residentOrders = EconomyResidentOrders(completed = 7, earnedCoins = 1234))
        val saved = initial.copy(residentOrders = EconomyFood.normalizedOrders(initial, now, previousCatalog))
        val promised = EconomyFood.residentOrderBoard(saved, now, previousCatalog).offers.single()
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(saved))
        assertEquals(saved, restored)
        val retained = EconomyFood.residentOrderBoard(restored, now.plusSeconds(1), updatedCatalog).offers.single()
        assertEquals(promised, retained, "Saved items, reward and fingerprint are an accepted promise")
        assertEquals(180L, retained.coins)
        val completed = EconomyFood.order(restored, retained.id, false, now.plusSeconds(1), catalog = updatedCatalog).first
        assertEquals(restored.wallet.coins + 180, completed.wallet.coins)
        assertEquals(8L, completed.residentOrders.completed)
        assertEquals(1414L, completed.residentOrders.earnedCoins)
        updated.items.keys.forEach { assertEquals(0L, completed.inventory[it] ?: 0L) }
        val next = EconomyFood.residentOrderBoard(completed, now.plusSeconds(1), updatedCatalog).offers.single()
        assertEquals(updated.id, next.templateId)
        assertEquals(updated.items, next.items)
        assertEquals(288L, next.coins)
        assertNotEquals(promised.id, next.id)
        val reloaded = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(completed))
        assertEquals(next, EconomyFood.residentOrderBoard(reloaded, now.plusSeconds(1), updatedCatalog).offers.single())
    }

    @Test fun `legacy v2 card keeps old quote until completion then advances at developed level`() {
        val source = catalog.food!!.orders.templates.single { it.id == "builder_wood_supply" }
        val cycle = now.epochSecond / catalog.food!!.orders.refreshSeconds
        val initial = EconomyRules.initial().copy(buildings = mapOf("home" to 5, "garden" to 1, "warehouse" to 1),
            residentOrders = EconomyResidentOrders(version = 2, cycle = cycle, slots = listOf(
                EconomyResidentOrderSlot(2, now.toString(), "plesk_river_catch"), EconomyResidentOrderSlot(3, now.toString(), source.id)),
                completed = 11, earnedCoins = 8000, replacementCycle = cycle, freeReplacementsUsed = 2))
        val offer = EconomyFood.residentOrderBoard(initial, now).offers.single { it.slot == 1 }
        assertEquals(source.items, offer.items); assertEquals(source.coins, offer.coins)
        val normalized = initial.copy(residentOrders = EconomyFood.normalizedOrders(initial, now), inventory = source.items)
        assertEquals(11L, normalized.residentOrders.completed); assertEquals(8000L, normalized.residentOrders.earnedCoins)
        assertEquals(2, normalized.residentOrders.freeReplacementsUsed)
        val completed = EconomyRules.apply(normalized, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0,
            "complete_resident_order", offer.id, 1, 0), now).first
        assertEquals(initial.wallet.coins + offer.coins, completed.wallet.coins)
        assertEquals(12L, completed.residentOrders.completed)
        val next = EconomyFood.residentOrderBoard(completed, now).offers.single { it.slot == 1 }
        val expected = EconomyFood.progressedTemplate(catalog.food!!.orders.templates.single { it.id == next.templateId }, 5)
        assertEquals(expected.items, next.items); assertEquals(expected.coins, next.coins)
    }
}
