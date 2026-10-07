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
