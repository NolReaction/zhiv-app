package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyFamiliarItemsTest {
    private val now = Instant.parse("2026-11-02T12:00:00Z")
    private val catalog get() = EconomyRules.catalog
    private fun command(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)

    @Test fun `new profiles know only their received starting items and never obtainable market goods`() {
        val initial = EconomyRules.initial()
        assertEquals(listOf("stone", "wood"), initial.familiarItems)
        val developed = initial.copy(buildings = catalog.buildings.associate { it.id to it.levels.last().level },
            unlockedItems = catalog.items.map { it.id })
        assertEquals(initial.familiarItems, EconomyFamiliarItems.project(developed))
        assertTrue("berries" in EconomyItemUnlocks.project(developed))
        assertFalse("berries" in EconomyFamiliarItems.project(developed))
        assertEquals(emptyList(), EconomyRules.initial(includeStartingPack = false).familiarItems)
    }

    @Test fun `owned purchases and gifts stay familiar after their last unit is spent without unlocking their market source`() {
        val gifted = EconomyRules.initial().copy(inventory = mapOf("tools" to 1L))
        val before = economyJson.encodeToString(gifted)
        assertTrue("tools" in EconomyFamiliarItems.project(gifted))
        assertFalse("tools" in EconomyItemUnlocks.project(gifted))
        assertEquals(before, economyJson.encodeToString(gifted))
        val sold = EconomyRules.apply(gifted, command("sell", "tools"), now).first
        assertFalse("tools" in sold.inventory)
        assertTrue("tools" in sold.familiarItems.orEmpty())
        assertFalse("tools" in EconomyItemUnlocks.project(sold))
    }

    @Test fun `precise stock and caught fish retain both the exact species and its class without inventing siblings`() {
        val owned = EconomyRules.initial().copy(inventory = mapOf("fish_common" to 1L),
            fishing = EconomyFishing(stock = mapOf("fish_silverfin" to 1L), catches = mapOf("fish_shark" to 1L)))
        val familiar = EconomyFamiliarItems.project(owned)
        assertTrue(familiar.containsAll(listOf("fish_common", "fish_silverfin", "fish_shark", "fish_legendary")))
        assertFalse("fish_rudd" in familiar)
        val unidentified = owned.copy(fishing = EconomyFishing())
        assertTrue("fish_common" in EconomyFamiliarItems.project(unidentified))
        assertFalse("fish_silverfin" in EconomyFamiliarItems.project(unidentified))
        val staleMetadata = owned.copy(inventory = emptyMap(), fishing = EconomyFishing(stock = mapOf("fish_silverfin" to 9L)))
        assertFalse("fish_silverfin" in EconomyFamiliarItems.project(staleMetadata))
        val listed = owned.copy(inventory = emptyMap(), fishing = EconomyFishing(escrow = mapOf("listing" to mapOf("fish_silverfin" to 1L))))
        assertTrue(EconomyFamiliarItems.project(listed).containsAll(listOf("fish_silverfin", "fish_common")))
        val legacyExact = owned.copy(inventory = mapOf("fish_silverfin" to 1L), fishing = EconomyFishing())
        assertTrue(EconomyFamiliarItems.project(legacyExact).containsAll(listOf("fish_silverfin", "fish_common")))
    }

    @Test fun `claimed recipes reveal used ingredients and outputs but pending private rewards do not`() {
        val recipe = catalog.recipes.single { it.id == "make_tools" }
        val claimed = EconomyRules.initial().copy(inventory = emptyMap(), familiarItems = null,
            progression = EconomyProgression(recipes = mapOf(recipe.id to 1L)))
        assertEquals(EconomyFamiliarItems.canonical(recipe.cost.items.keys + recipe.rewards.keys), EconomyFamiliarItems.project(claimed))
        assertTrue(EconomyFamiliarItems.project(claimed.copy(familiarItems = emptyList())).isEmpty(),
            "Initialized knowledge cannot infer new ingredients after a catalog change")
        val pending = claimed.copy(progression = EconomyProgression(), jobs = listOf(EconomyJob(UUID.randomUUID().toString(),
            "production", "workshop", recipe.id, startedAt = now.toString(), finishesAt = now.plusSeconds(100).toString(),
            rewards = mapOf("tools" to 1L))))
        assertTrue(EconomyFamiliarItems.project(pending).isEmpty())
    }

    @Test fun `finished routes reveal guaranteed goods and positive minimum loot but never optional finds`() {
        val route = catalog.explorations.single { it.id == "ancient_ruins" }
        val state = EconomyRules.initial().copy(inventory = emptyMap(), familiarItems = null,
            progression = EconomyProgression(routes = mapOf(route.id to 1L)))
        assertTrue(EconomyFamiliarItems.project(state).containsAll(route.rewards.keys))
        assertFalse("lens" in EconomyFamiliarItems.project(state))
        assertFalse("glass_bottle" in EconomyFamiliarItems.project(state))
        val changed = catalog.copy(explorations = catalog.explorations.map { if (it.id != route.id) it else
            it.copy(loot = listOf(EconomyExpeditionLootRange("wood", 1, 2), EconomyExpeditionLootRange("glass", 0, 1))) })
        assertTrue("wood" in EconomyFamiliarItems.project(state, catalog = changed))
        assertFalse("glass" in EconomyFamiliarItems.project(state, catalog = changed))
        assertTrue(EconomyFamiliarItems.project(state.copy(familiarItems = emptyList()), catalog = changed).isEmpty())
        val fishing = state.copy(progression = EconomyProgression(routes = mapOf("shore" to 1L, "shore_camp" to 1L)),
            fishing = EconomyFishing(catches = mapOf("fish_reedperch" to 1L)))
        assertEquals(EconomyFamiliarItems.canonical(listOf("fish_reedperch")), EconomyFamiliarItems.project(fishing))
    }

    @Test fun `legacy history is inherited once while malformed and zero quantity evidence cannot teach an item`() {
        val old = EconomyRules.initial().copy(familiarItems = null, inventory = mapOf("tools" to 0L, "unknown-item" to 1L))
        val before = economyJson.encodeToString(old)
        val familiar = EconomyFamiliarItems.project(old, setOf("glass", "fish_silverfin", "unknown-history"))
        assertEquals(listOf("fish_common", "fish_silverfin", "glass"), familiar)
        assertEquals(before, economyJson.encodeToString(old))
        val saved = EconomyFamiliarItems.persist(old, setOf("glass"))
        assertEquals(listOf("glass"), EconomyFamiliarItems.project(saved.copy(inventory = emptyMap()), setOf("tools")))
        assertTrue(EconomyFamiliarItems.project(old.copy(familiarItems = emptyList()), setOf("tools")).isEmpty())
    }

    @Test fun `old wire snapshots omit familiarity and new empty knowledge serializes distinctly`() {
        val initial = EconomyRules.initial()
        val encoded = economyJson.encodeToJsonElement(initial).jsonObject
        val old = economyJson.decodeFromJsonElement<EconomyState>(JsonObject(encoded - "familiarItems"))
        assertNull(old.familiarItems)
        assertFalse("familiarItems" in economyJson.encodeToJsonElement(old).jsonObject)
        val fresh = initial.copy(familiarItems = emptyList())
        assertEquals(JsonArray(emptyList()), economyJson.encodeToJsonElement(fresh).jsonObject["familiarItems"])
        assertFailsWith<IllegalArgumentException> { initial.copy(familiarItems = listOf("wood", "wood")) }
    }

    @Test fun `failed commands cannot persist the familiar projection and retired paid claims teach only delivered items`() {
        val job = EconomyJob(UUID.randomUUID().toString(), "production", "workshop", "retired_recipe",
            startedAt = now.minusSeconds(100).toString(), finishesAt = now.toString(), rewards = mapOf("tools" to 1L), catalogVersion = 7)
        val full = EconomyRules.initial().copy(inventory = mapOf("wood" to 50L), familiarItems = null, jobs = listOf(job))
        val before = economyJson.encodeToString(full)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { EconomyRules.apply(full, command("claim_job", job.id), now) }.code)
        assertEquals(before, economyJson.encodeToString(full))
        val claimed = EconomyRules.apply(full.copy(inventory = emptyMap()), command("claim_job", job.id), now).first
        assertTrue("tools" in claimed.familiarItems.orEmpty())
    }
}
