package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyFishClassesTest {
    private val now = Instant.parse("2026-10-13T16:00:00Z")
    private val spec = checkNotNull(EconomyRules.catalog.fishing)
    private fun command(action: String, target: String, quantity: Long = 1) = EconomyCommand(
        UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity)

    @Test fun `legacy stock combines without creating collection entries and normalization is idempotent`() {
        val common = spec.fish.filter { it.rarity == "common" }.take(2)
        val state = EconomyRules.initial().copy(inventory = mapOf(
            common[0].itemId to 2L, common[1].itemId to 3L, "fish_common" to 4L, "wood" to 5L),
            fishing = EconomyFishing(catches = mapOf(common[0].itemId to 8L)))
        val normalized = EconomyFishInventory.state(state)
        assertEquals(mapOf("fish_common" to 9L, "wood" to 5L), normalized.inventory)
        assertEquals(state.inventory.values.sum(), normalized.inventory.values.sum())
        assertEquals(state.fishing.copy(stock = mapOf(common[0].itemId to 2L, common[1].itemId to 3L)), normalized.fishing)
        assertEquals(normalized, EconomyFishInventory.state(normalized))
        assertEquals(2L, state.inventory[common[0].itemId], "normalization does not mutate its input")
    }

    @Test fun `saved catch settles class goods while original species open collection once`() {
        val common = spec.fish.first { it.rarity == "common" }.itemId
        val uncommon = spec.fish.first { it.rarity == "uncommon" }.itemId
        val job = EconomyJob(UUID.randomUUID().toString(), "exploration", "shore", startedAt = now.minusSeconds(600).toString(),
            finishesAt = now.toString(), rewards = mapOf(common to 2L, uncommon to 1L), catalogVersion = 3,
            fishing = EconomyFishingCatch("reed_rod", null, common))
        val state = EconomyRules.initial().copy(inventory = emptyMap(), jobs = listOf(job))
        val next = EconomyRules.apply(state, command("claim_job", job.id), now).first
        assertEquals(mapOf("fish_common" to 2L, "fish_uncommon" to 1L), next.inventory)
        assertEquals(job.rewards, next.fishing.catches)
        assertEquals(job.rewards, next.fishing.stock)
        assertEquals(job, state.jobs.single(), "pending rewards remain the promised species")
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            EconomyRules.apply(next, command("claim_job", job.id), now)
        }.code)
        val sold = EconomyRules.apply(next, command("sell_fish", "fish_common", 2), now).first
        assertEquals(next.fishing.catches, sold.fishing.catches)
        assertEquals(mapOf("fish_uncommon" to 1L), sold.inventory)
    }

    @Test fun `full warehouse and escrow reject claim without consuming job or unlocking species`() {
        val fish = spec.fish.first().itemId
        val job = EconomyJob(UUID.randomUUID().toString(), "exploration", "shore", startedAt = now.minusSeconds(180).toString(),
            finishesAt = now.toString(), rewards = mapOf(fish to 2L), fishing = EconomyFishingCatch("reed_rod", null, fish))
        val state = EconomyRules.initial().copy(inventory = mapOf("wood" to 48L), jobs = listOf(job))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, command("claim_job", job.id), now, mapOf("stone" to 1L))
        }.code)
        assertTrue(state.fishing.catches.isEmpty())
        assertEquals(job, state.jobs.single())
        val claimed = EconomyRules.apply(state, command("claim_job", job.id), now).first
        assertEquals(50L, EconomyRules.storage(claimed).used)
    }

    @Test fun `recipe accepts mixed legacy common stock but never substitutes expensive classes`() {
        val recipe = EconomyRules.catalog.recipes.single { it.id == "cook_grilled_fish" }
        val fishCount = recipe.cost.items.getValue("fish_common")
        val common = spec.fish.filter { it.rarity == "common" }.take(2)
        val base = EconomyRules.initial().copy(buildings = EconomyRules.initial().buildings +
            recipe.requiredBuildings + ("home" to recipe.requiredHomeLevel) + (recipe.buildingId to recipe.buildingLevel))
        val inventory = (recipe.cost.items - "fish_common") + mapOf(common[0].itemId to 1L, common[1].itemId to fishCount - 1)
        val started = EconomyRules.apply(base.copy(inventory = inventory), command("start_production", recipe.id), now).first
        assertEquals(recipe.cost, started.jobs.single().cost)
        assertEquals(0L, started.inventory["fish_common"] ?: 0L)
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> {
            EconomyRules.apply(base.copy(inventory = (recipe.cost.items - "fish_common") + ("fish_legendary" to fishCount)),
                command("start_production", recipe.id), now)
        }.code)
        assertEquals("ECONOMY_RECIPE_FISH", assertFailsWith<AuthFailure> {
            EconomyRules.apply(base.copy(inventory = inventory), command("start_production", "${recipe.id}@${common[0].itemId}"), now)
        }.code)
    }

    @Test fun `adding species cannot change class weights and all species in a class are uniform`() {
        val original = EconomyRules.fishingClassWeights("river_rod", "worm_bait", "barbed_hook", spec)
        val expanded = spec.copy(fish = spec.fish + spec.fish.first().copy(itemId = "fish_new_collection_entry", weight = 9999))
        assertEquals(original, EconomyRules.fishingClassWeights("river_rod", "worm_bait", "barbed_hook", expanded))
        val weights = EconomyRules.fishingWeights("river_rod", "worm_bait", "barbed_hook")
        for (rarity in spec.classes.map { it.rarity }) {
            assertEquals(1, weights.filter { it.first.rarity == rarity }.map { it.second }.distinct().size)
        }
        assertTrue(EconomyRules.fishingClassWeights("reed_rod", "firefly_bait", "leviathan_hook")
            .single { it.first.rarity == "legendary" }.second == 0)
    }

    @Test fun `public job masks canonical classes as well as species`() {
        val job = EconomyJob(UUID.randomUUID().toString(), "exploration", "shore", startedAt = now.toString(),
            finishesAt = now.plusSeconds(180).toString(), rewards = mapOf("fish_rare" to 1L, "fish" to 1L),
            fishing = EconomyFishingCatch("reed_rod", null, "fish_rare"))
        assertEquals(mapOf("fish" to 2L), EconomyPublicJobs.project(job, now).rewards)
        assertEquals("fish", EconomyPublicJobs.project(job, now).fishing?.fishId)
        assertEquals(job.copy(fishing = job.fishing?.copy(catchRevealed = true)), EconomyPublicJobs.project(job, Instant.parse(job.finishesAt)))
    }

    @Test fun `canonical market unlocks exist and legendary class respects tackle home gate`() {
        for (tier in spec.classes) assertTrue(EconomyMarketRules.requiredHomeLevel(tier.itemId) in 1..5)
        assertEquals(4, EconomyMarketRules.requiredHomeLevel("fish_legendary"))
        assertEquals(1, EconomyMarketRules.requiredHomeLevel("fish_common"))
        assertEquals(4, EconomyMarketRules.requiredHomeLevel("star_bait"))
    }

    @Test fun `orders require a positive class chance from owned rods and no legendary hook`() {
        val state = EconomyRules.initial().copy(inventory = mapOf("fish_epic" to 2L, "fish_legendary" to 1L),
            buildings = EconomyRules.initial().buildings + ("home" to 5))
        val starter = EconomyFood.obtainableOrderItems(state)
        assertTrue(setOf("fish_common", "fish_uncommon", "fish_rare").all { it in starter })
        assertFalse("fish_epic" in starter)
        assertFalse("fish_legendary" in starter)
        val brook = state.copy(fishing = state.fishing.copy(ownedRods = state.fishing.ownedRods + "brook_rod"))
        assertTrue("fish_epic" in EconomyFood.obtainableOrderItems(brook))
        val legendary = state.copy(fishing = state.fishing.copy(ownedRods = state.fishing.ownedRods + "starfall_rod"))
        assertEquals(listOf("bare_hook"), legendary.fishing.ownedHooks)
        assertTrue("fish_legendary" in EconomyFood.obtainableOrderItems(legendary))
    }

    @Test fun `catalogue rebalance never rerolls a saved catch or rejects its old bait`() {
        val epic = spec.fish.first { it.rarity == "epic" }.itemId
        val job = EconomyJob(UUID.randomUUID().toString(), "exploration", "shore", startedAt = now.minusSeconds(180).toString(),
            finishesAt = now.toString(), rewards = mapOf(epic to 2L), catalogVersion = 4,
            cost = EconomyCost(items = mapOf("firefly_bait" to 1L)), fishing = EconomyFishingCatch("reed_rod", "firefly_bait", epic))
        val state = EconomyRules.initial().copy(inventory = emptyMap(), jobs = listOf(job),
            fishing = EconomyFishing(equippedBaitId = "firefly_bait"))
        assertFalse(EconomyRules.fishingBaitCompatible("reed_rod", "firefly_bait"))
        val claimed = EconomyRules.apply(state, command("claim_job", job.id), now).first
        assertEquals(mapOf("fish_epic" to 2L), claimed.inventory)
        assertEquals(job.rewards, claimed.fishing.catches)
        assertEquals(job, state.jobs.single())
    }
    @Test fun `saved species order preserves payout and sequence but rejects old fingerprint after class conversion`() {
        val common = spec.fish.filter { it.rarity == "common" }.take(2)
        val initial = EconomyRules.initial()
        val board = EconomyFood.normalizedOrders(initial, now)
        val terms = EconomyResidentOrderTemplate("legacy_fish_order", "plesk", "Старый заказ",
            items = mapOf(common[0].itemId to 2L, common[1].itemId to 3L), coins = 777)
        val state = initial.copy(inventory = terms.items, residentOrders = board.copy(slots = board.slots.mapIndexed { index, slot ->
            if (index == 0) slot.copy(sequence = 9, templateId = terms.id, terms = terms) else slot
        }))
        val oldCatalog = EconomyRules.catalog.copy(fishing = spec.copy(classes = emptyList()))
        val old = EconomyFood.residentOrderBoard(state, now, oldCatalog).offers.single { it.slot == 0 }
        val current = EconomyFood.residentOrderBoard(state, now).offers.single { it.slot == 0 }
        assertEquals(mapOf("fish_common" to 5L), current.items)
        assertEquals(777L, current.coins)
        assertEquals(9L, EconomyFood.normalizedOrders(state, now).slots.first().sequence)
        assertNotEquals(old.id, current.id)
        assertEquals("ECONOMY_ORDER_CHANGED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, command("complete_resident_order", old.id), now)
        }.code)
        val completed = EconomyRules.apply(state, command("complete_resident_order", current.id), now).first
        assertEquals(initial.wallet.coins + 777L, completed.wallet.coins)
        assertTrue(completed.inventory.isEmpty())
        assertTrue(completed.fishing.catches.isEmpty())
        assertEquals("ECONOMY_ORDER_CHANGED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(completed, command("complete_resident_order", current.id), now)
        }.code)
    }

    @Test fun `class aggregation preserves item cap and cannot subtract stock through a legacy alias`() {
        val common = spec.fish.filter { it.rarity == "common" }.take(2)
        assertEquals(mapOf("fish_common" to ECONOMY_MAX_ITEMS), EconomyFishInventory.items(
            mapOf(common[0].itemId to ECONOMY_MAX_ITEMS - 1, common[1].itemId to 1L)))
        for (invalid in listOf(mapOf(common[0].itemId to ECONOMY_MAX_ITEMS, common[1].itemId to 1L),
            mapOf("fish_common" to 5L, common[0].itemId to -1L), mapOf("wood" to Long.MAX_VALUE))) {
            assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> { EconomyFishInventory.items(invalid) }.code)
        }
        assertEquals(mapOf("fish_common" to 0L, "ancient_core" to 0L),
            EconomyFishInventory.items(mapOf("fish_common" to 0L, "ancient_core" to 0L)))
    }

}
