package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class EconomyRecipeUnlockTest {
    private val now = Instant.parse("2026-11-01T12:00:00Z")
    private val catalog = EconomyRules.catalog
    private val unlocks = mapOf(
        "grow_strawberries" to mapOf("cook_compote" to 1L),
        "cook_fish_soup" to mapOf("cook_grilled_fish" to 1L),
    )
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, quantity: Long = 1) = EconomyRules.apply(
        state, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity), at).first
    private fun mastered(select: (EconomyRecipe) -> Map<String, Long>): Map<String, Long> =
        catalog.recipes.flatMap { select(it).entries }.groupBy { it.key }.mapValues { (_, entries) -> entries.maxOf { it.value } }
    private fun supplied(target: String, prerequisite: String? = null, count: Long = 1) = EconomyRules.initial().copy(
        buildings = catalog.buildings.associate { it.id to it.levels.last().level },
        inventory = catalog.items.associate { it.id to 4L }, wallet = EconomyWallet(100_000),
        progression = EconomyProgression(recipes = mastered { it.requiredRecipes } + (prerequisite?.let { mapOf(it to count - 1) } ?: emptyMap()),
            routes = mastered { it.requiredExplorations }),
        fishing = EconomyFishing(catches = mapOf(catalog.fishing!!.fish.first().itemId to catalog.recipes.single { it.id == target }.requiredFishCaught)),
    )
    private fun locked(state: EconomyState, target: String, at: Instant = now) {
        val before = economyJson.encodeToString(state)
        assertEquals("ECONOMY_RECIPE_REQUIRED", assertFailsWith<AuthFailure> {
            apply(state, "start_production", target, at)
        }.code, target)
        assertEquals(before, economyJson.encodeToString(state), "Rejected starts cannot spend or alter jobs")
    }

    @Test fun `crafting lessons and strawberry compote require personally claimed results and survive persistence`() {
        unlocks.forEach { (target, required) -> required.forEach { (prerequisite, count) ->
            assertEquals(required, catalog.recipes.single { it.id == target }.requiredRecipes)
            val initial = supplied(target, prerequisite, count)
            // Bought or gifted products are already in stock, but do not open recipes.
            locked(initial, target)
            val started = apply(initial, "start_production", prerequisite)
            val job = started.jobs.single()
            val ready = Instant.parse(job.finishesAt)
            locked(started, target, ready)
            val claimed = apply(started, "claim_job", job.id, ready)
            assertEquals(count, claimed.progression.recipes[prerequisite], target)
            val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(claimed))
            assertEquals(target, apply(restored, "start_production", target, ready).jobs.single().recipeId)
        } }
    }

    @Test fun `previously received ordinary recipes remain learned after practice tasks change`() {
        for(target in listOf("make_trade_crate","grind_lens","cook_fish_soup")) {
            val supplied=supplied(target)
            val recipe=catalog.recipes.single { it.id==target }
            val state=supplied.copy(progression=EconomyProgression(),fishing=EconomyFishing(),unlockedItems=recipe.rewards.keys.toList())
            locked(state,target)
            val learned=state.copy(progression=state.progression.copy(recipes=mapOf(target to 1L)))
            val restored=economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(learned))
            assertTrue(EconomyRecipeUnlocks.met(restored,recipe))
            assertEquals(target,apply(restored,"start_production",target).jobs.single().recipeId)
        }
    }

    @Test fun `cancelled lessons never open their dependent recipes`() {
        unlocks.forEach { (target, required) -> required.forEach { (prerequisite, count) ->
            val started = apply(supplied(target, prerequisite, count), "start_production", prerequisite)
            val cancelled = apply(started, "cancel_production", started.jobs.single().id, now.plusMillis(1))
            assertEquals(count - 1, cancelled.progression.recipes[prerequisite] ?: 0L, target)
            locked(cancelled, target, now.plusMillis(1))
        } }
    }

    @Test fun `berries other than strawberries open at their actual level without crafting lessons or a kitchen`() {
        catalog.recipes.filter { it.buildingId == "garden" && it.id != "grow_strawberries" }.forEach { assertEquals(emptyMap(), it.requiredRecipes, it.id) }
        assertEquals(emptyMap(), catalog.recipes.single { it.id == "cook_strawberry_compote" }.requiredRecipes)
        catalog.recipes.filter { it.buildingId == "garden" && it.collection != null && !it.retired && it.id != "grow_strawberries" }.forEach { crop ->
            val initial = EconomyRules.initial()
            val state = initial.copy(buildings = initial.buildings + mapOf("home" to crop.requiredHomeLevel, "garden" to crop.buildingLevel))
            assertEquals(emptyMap(), state.progression.recipes)
            assertEquals(crop.id, apply(state, "start_production", crop.id).jobs.single().recipeId)
        }
    }

    @Test fun `expedition lessons require received results and all their practice conditions`() {
        catalog.recipes.filter { it.requiredExplorations.isNotEmpty() }.forEach { target ->
            target.requiredExplorations.forEach { (routeId, required) ->
                val supplied = supplied(target.id)
                val initial = supplied.copy(progression = supplied.progression.copy(routes = supplied.progression.routes + (routeId to required - 1)))
                locked(initial, target.id)
                val started = apply(initial, "start_exploration", routeId)
                val job = started.jobs.single()
                val ready = Instant.parse(job.finishesAt)
                locked(started, target.id, ready)
                val claimed = apply(started, "claim_job", job.id, ready)
                assertEquals(required, claimed.progression.routes[routeId])
                assertTrue(EconomyRecipeUnlocks.met(claimed, target))
                assertTrue(target.rewards.keys.all { it in EconomyFood.obtainableOrderItems(claimed) })
                target.requiredExplorations.filterKeys { it != routeId }.forEach { (otherRoute, count) ->
                    locked(claimed.copy(progression = claimed.progression.copy(routes = claimed.progression.routes +
                        (otherRoute to count - 1))), target.id, ready)
                }
                if (target.requiredFishCaught > 0) locked(claimed.copy(fishing = claimed.fishing.copy(catches = emptyMap())), target.id, ready)
                assertEquals(target.id, apply(claimed, "start_production", target.id, ready).jobs.single().recipeId)
            }
        }
    }

    @Test fun `partial and full clay claims preserve counters without replacing exploration practice`() {
        val target = catalog.recipes.single { it.id == "make_ceramic_jar" }
        val initial = supplied(target.id).let { it.copy(progression = it.progression.copy(routes = emptyMap())) }
        val started = apply(initial, "start_exploration", "quarry_clay", quantity = 2)
        val job = started.jobs.single()
        val ready = Instant.parse(job.finishesAt)
        val one = apply(started, "claim_mining_batch", job.id, ready)
        assertEquals(1L, one.progression.routes["quarry_clay"])
        assertFalse(EconomyRecipeUnlocks.met(one, target))
        val two = apply(one, "claim_mining_batch", job.id, ready)
        val all = apply(started, "claim_job", job.id, ready)
        assertEquals(2L, two.progression.routes["quarry_clay"])
        assertEquals(all.progression.routes, two.progression.routes)
        assertFalse(EconomyRecipeUnlocks.met(two, target))
        assertFalse(EconomyRecipeUnlocks.met(all, target))
    }

    @Test fun `personal fishing lesson accepts both routes after delivery and ignores purchased fish`() {
        val target = catalog.recipes.single { it.id == "cook_fish_soup" }
        val fishing = checkNotNull(catalog.fishing)
        fishing.routeIds.forEach { route ->
            val fishId = fishing.fish.first { it.rarity == "common" }.itemId
            var state = supplied(target.id, "cook_grilled_fish", 2).copy(fishing = EconomyFishing(),
                fishingShop = EconomyFishingShop("test-catch-shop", now.toString(), now.plusSeconds(86400).toString(), 1,
                    listOf(EconomyFishingOffer("fish-offer", "fish", fishId, 1, 4))))
            state = EconomyRules.apply(state, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0,
                "buy_fishing_item", "fish-offer", 4, 4), now).first
            assertEquals(0L, EconomyRecipeUnlocks.personallyCaughtFish(state))
            locked(state, target.id)
            var clock = now
            while (EconomyRecipeUnlocks.personallyCaughtFish(state) < target.requiredFishCaught) {
                state = apply(state, "start_fishing", route, clock)
                val job = state.jobs.single()
                val before = EconomyRecipeUnlocks.personallyCaughtFish(state)
                clock = Instant.parse(job.finishesAt)
                locked(state, target.id, clock)
                state = apply(state, "claim_job", job.id, clock)
                assertEquals(before + fishing.collectionDrawsByRoute.getValue(route), EconomyRecipeUnlocks.personallyCaughtFish(state))
            }
            assertTrue(EconomyRecipeUnlocks.met(state, target))
            assertEquals(target.id, apply(state, "start_production", target.id, clock).jobs.single().recipeId)
        }
    }

    @Test fun `old catalog recipes default to no new conditions and fish class counters cannot double count`() {
        val legacy = economyJson.decodeFromString<EconomyRecipe>("""{"id":"legacy","name":"legacy","buildingId":"workshop","seconds":1,"rewards":{"wood":1}}""")
        assertEquals(emptyMap(), legacy.requiredExplorations)
        assertEquals(0L, legacy.requiredFishCaught)
        assertEquals(null, legacy.unlockTitle)
        val species = checkNotNull(catalog.fishing).fish.first().itemId
        val state = supplied("cook_fish_soup", "cook_grilled_fish", 2).copy(fishing = EconomyFishing(
            catches = mapOf("fish_common" to 100, "unknown_fish" to 100, species to 3)))
        assertEquals(3L, EconomyRecipeUnlocks.personallyCaughtFish(state))
        assertFalse(EconomyRecipeUnlocks.met(state, catalog.recipes.single { it.id == "cook_fish_soup" }))
    }
}
