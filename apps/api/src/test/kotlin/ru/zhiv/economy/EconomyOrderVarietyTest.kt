package ru.zhiv.economy

import kotlinx.serialization.Serializable
import org.junit.jupiter.api.Test
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class EconomyOrderVarietyTest {
    private val now = Instant.parse("2026-10-16T09:00:00Z")
    @Serializable private data class Scenario(
        val label: String, val buildings: Map<String, Int>, val recipes: Map<String, Long> = emptyMap(),
        val ownedRods: List<String>, val ownedHooks: List<String>, val present: List<String>, val missing: List<String>,
    )
    private fun scenarios() = economyJson.decodeFromString<List<Scenario>>(checkNotNull(
        javaClass.getResourceAsStream("/world/orders-variety-vectors.json")).bufferedReader().use { it.readText() })
    private fun state(scenario: Scenario) = EconomyRules.initial().copy(buildings = scenario.buildings,
        progression = EconomyProgression(recipes = scenario.recipes),
        fishing = EconomyFishing(ownedRods = scenario.ownedRods, ownedHooks = scenario.ownedHooks))

    @Test fun `browser and server share varied requests with complete ingredient recipe and gear gates`() {
        val catalog = EconomyRules.catalog
        scenarios().forEach { scenario ->
            // Buying future ingredients must not open an unavailable supply chain.
            val state = state(scenario).copy(inventory = catalog.items.associate { it.id to 100L })
            val eligible = EconomyFood.eligibleOrderTemplates(state)
            val ids = eligible.map { it.id }.toSet()
            val expectedResidents = eligible.map { it.residentId }.toSet()
            scenario.present.forEach { assertTrue(it in ids, "${scenario.label}: expected $it") }
            scenario.missing.forEach { assertFalse(it in ids, "${scenario.label}: unexpected $it") }
            repeat(24) { cycle ->
                val board = EconomyFood.residentOrderBoard(state, now.plusSeconds(cycle * catalog.food!!.orders.refreshSeconds))
                assertEquals(expectedResidents.size, board.offers.size, scenario.label)
                assertEquals(expectedResidents, board.offers.map { it.residentId }.toSet(), scenario.label)
                assertEquals(board.offers.size, board.offers.map { it.items }.distinct().size, scenario.label)
                board.offers.forEach { assertTrue(it.templateId in ids, "${scenario.label}: unavailable ${it.templateId}") }
            }
        }
    }

    @Test fun `Plesk receives berries and compact mixed meals instead of only raw fish`() {
        var state = state(scenarios().first())
        var templates = EconomyFood.eligibleOrderTemplates(state).filter { it.residentId == "plesk" }
        assertTrue(templates.any { template -> template.items.keys.none { it.startsWith("fish_") } })
        state = state.copy(buildings = state.buildings + ("dryer" to 1))
        templates = EconomyFood.eligibleOrderTemplates(state).filter { it.residentId == "plesk" }
        assertTrue(templates.any { "grilled_fish" in it.items && "berry_compote" in it.items })
        assertTrue(templates.any { "fish_common" in it.items && "berries" in it.items })
        assertTrue(templates.any { template -> "berry_compote" in template.items && template.items.keys.none { it.contains("fish") } })
        val seen = mutableSetOf<String>()
        repeat(32) {
            val offer = EconomyFood.residentOrderBoard(state, now).offers.single { it.slot == 0 }
            seen += offer.templateId
            state = state.copy(residentOrders = EconomyFood.advanceResidentOrder(state, 0, now))
        }
        assertTrue(seen.size >= 6)
        assertTrue(EconomyRules.catalog.food!!.orders.templates.any { it.id in seen && "berry_compote" in it.items })
    }

    @Test fun `unknown tackle and zero hook weights cannot promise an impossible fish class`() {
        val initial = state(scenarios().first())
        assertFalse("fish_common" in EconomyFood.obtainableOrderItems(initial.copy(fishing = EconomyFishing(ownedRods = listOf("missing_rod")))))
        assertFalse("fish_common" in EconomyFood.obtainableOrderItems(initial.copy(fishing = EconomyFishing(ownedHooks = listOf("missing_hook")))))
        val catalog = EconomyRules.catalog
        val fishing = checkNotNull(catalog.fishing)
        val fixture = catalog.copy(fishing = fishing.copy(hooks = fishing.hooks.map { hook ->
            if (hook.id == "bare_hook") hook.copy(rarityWeights = mapOf("common" to 100, "uncommon" to 0, "rare" to 0, "epic" to 0, "legendary" to 0)) else hook
        }))
        val reachable = EconomyFood.obtainableOrderItems(initial, fixture)
        assertTrue("fish_common" in reachable)
        assertFalse("fish_uncommon" in reachable)
        assertFalse("fish_rare" in reachable)
    }
}
