package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyV14RuntimeTest {
    private val now = Instant.parse("2026-10-26T12:00:00Z")
    private fun command(action: String, target: String, selection: Map<String, Long>? = null) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, fishSelection = selection)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, command(action, target), at).first
    private fun error(code: String, action: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = action).code)

    @Test fun `strict fish requirements reject wrong species and unidentified fish without double charging classes`() {
        val state = EconomyRules.initial().copy(inventory = mapOf("fish_common" to 4L),
            fishing = EconomyFishing(stock = mapOf("fish_silverfin" to 2L, "fish" to 2L)))
        val cost = EconomyCost(items = mapOf("fish_silverfin" to 2L))
        val spent = EconomyRules.spend(state, cost, exactSpecies = true)
        assertEquals(2L, spent.inventory["fish_common"])
        assertNull(spent.fishing.stock?.get("fish_silverfin"))
        assertEquals(2L, spent.fishing.stock?.get("fish"))
        error("ECONOMY_FISH_SELECTION_CHANGED") { EconomyRules.spend(state, cost, mapOf("fish" to 2L), exactSpecies = true) }
        error("ECONOMY_FISH_SELECTION_CHANGED") { EconomyRules.spend(state.copy(fishing = EconomyFishing()), cost, exactSpecies = true) }
        // The optional mode must not reinterpret old class-based contracts.
        assertEquals(2L, EconomyRules.spend(state, cost, mapOf("fish" to 2L)).inventory["fish_common"])
        assertEquals(4L, state.inventory["fish_common"])
    }

    @Test fun `species dishes enforce ownership through real commands and cancellation refunds the exact saved species`() {
        for (recipe in EconomyRules.catalog.recipes.filter { it.fishInput?.exactSpecies == true }) {
            val fishIds = recipe.fishInput!!.itemIds.toSet()
            val species = recipe.cost.items.filterKeys { it in fishIds }
            val state = EconomyRules.initial().copy(wallet = EconomyWallet(recipe.cost.coins),
                inventory = EconomyFishInventory.items(recipe.cost.items), fishing = EconomyFishing(stock = species),
                buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.last().level },
                progression = EconomyProgression(recipes = recipe.requiredRecipes))
            error("ECONOMY_FISH_SELECTION_CHANGED") { apply(state.copy(fishing = EconomyFishing()), "start_production", recipe.id) }
            val started = apply(state, "start_production", recipe.id)
            val job = started.jobs.single()
            assertEquals(species, job.fishStockCost)
            assertTrue(started.inventory.isEmpty())
            val restored = apply(started, "cancel_production", job.id)
            assertEquals(state.inventory, restored.inventory)
            assertEquals(species, restored.fishing.stock)
            assertEquals(state.wallet, restored.wallet)
            val claimed = apply(started, "claim_job", job.id, Instant.parse(job.finishesAt))
            assertEquals(recipe.rewards, claimed.inventory)
            assertTrue(claimed.fishing.stock.orEmpty().isEmpty())
        }
    }

    @Test fun `frozen work budget spans short trips with exact last partial duration and cancellation never refunds`() {
        val food = EconomyFoodState(heroMeal = "fish_soup", heroMealEffect = EconomyHeroMealEffect(400, 400, 2500))
        val state = EconomyRules.initial().copy(food = food)
        val first = EconomyFood.heroTrip(state, 180)
        assertEquals(144L, first.seconds)
        assertEquals(180L, first.meal?.workSeconds)
        assertEquals(220L, first.food.heroMealEffect?.remainingWorkSeconds)
        val second = EconomyFood.heroTrip(state.copy(food = first.food), 180)
        assertEquals(144L, second.seconds)
        assertEquals(40L, second.food.heroMealEffect?.remainingWorkSeconds)
        val third = EconomyFood.heroTrip(state.copy(food = second.food), 180)
        assertEquals(172L, third.seconds)
        assertEquals(40L, third.meal?.workSeconds)
        assertNull(third.food.heroMeal)
        assertNull(third.food.heroMealEffect)
        assertEquals(400L, food.heroMealEffect?.remainingWorkSeconds)
        val ready = state.copy(food = food.copy(heroMealEffect = EconomyHeroMealEffect(1000, 1000, 2500)))
        val trip = apply(ready, "start_fishing", "shore")
        val canceled = apply(trip, "cancel_exploration", trip.jobs.single().id)
        assertEquals(trip.food, canceled.food)
        val discarded = apply(canceled, "cancel_meal", "hero")
        assertNull(discarded.food.heroMeal)
        assertEquals(ready.inventory, discarded.inventory)
        assertEquals(0, EconomyFood.pendingPortions(canceled))
    }

    @Test fun `legacy pending meals preserve old speed and one job while fresh meals freeze catalog speed`() {
        val legacy = EconomyRules.initial().copy(food = EconomyFoodState(heroMeal = "fish_soup", builderMeal = "berry_fish"))
        assertEquals(2500, EconomyFood.pendingMeal(legacy, "hero")?.speedBps)
        assertEquals(3500, EconomyFood.pendingMeal(legacy, "builder")?.speedBps)
        assertNull(EconomyFood.heroTrip(legacy, 180).food.heroMeal)
        val fresh = apply(EconomyRules.initial().copy(inventory = mapOf("fish_soup" to 2L)), "eat_food", "fish_soup")
        val spec = EconomyRules.catalog.food!!.meals.single { it.itemId == "fish_soup" }
        assertEquals(spec.heroWorkSeconds, fresh.food.heroMealEffect?.totalWorkSeconds)
        assertEquals(spec.heroSpeedBps, fresh.food.heroMealEffect?.speedBps)
        val returned = apply(fresh, "cancel_meal", "hero")
        assertEquals(2L, returned.inventory["fish_soup"])
        assertNull(returned.food.heroMealEffect)
        val builder = apply(returned, "feed_builder", "fish_soup")
        assertEquals(spec.builderSpeedBps, builder.food.builderMealSpeedBps)
        assertNull(apply(builder, "cancel_meal", "builder").food.builderMealSpeedBps)
    }

    @Test fun `one weighted find is private even when ready and saved outcome survives serialization and failed storage claim`() {
        val spec = EconomyExpeditionFinds(2, listOf(EconomyExpeditionFind("wood", 2, 3), EconomyExpeditionFind("stone", 1, 5)))
        for (roll in 0..9) {
            var calls = 0
            val result = EconomyExpeditionLoot.draw(spec) { bound -> calls++; assertEquals(10, bound); roll }
            assertEquals(1, calls)
            assertEquals(when (roll) { 0, 1 -> emptyMap(); in 2..4 -> mapOf("wood" to 2L); else -> mapOf("stone" to 1L) }, result)
        }
        val job = EconomyJob("saved-private-find", "exploration", "forest", startedAt = now.toString(), finishesAt = now.plusSeconds(1).toString(),
            rewards = mapOf("wood" to 1L), expeditionFinds = mapOf("stone" to 2L), catalogVersion = 14)
        val saved = economyJson.decodeFromString<EconomyJob>(economyJson.encodeToString(job))
        assertEquals(job, saved)
        for (at in listOf(now, now.plusSeconds(2))) {
            val public = EconomyPublicJobs.project(saved, at)
            assertNull(public.expeditionFinds)
            assertEquals(mapOf("wood" to 1L), public.rewards)
            assertFalse("expeditionFinds" in economyJson.parseToJsonElement(economyJson.encodeToString(public)).jsonObject)
        }
        val full = EconomyRules.initial().copy(inventory = mapOf("fiber" to 49L), jobs = listOf(saved))
        error("ECONOMY_STORAGE_FULL") { apply(full, "claim_job", job.id, now.plusSeconds(2)) }
        assertEquals(job, full.jobs.single())
        val cleared = full.copy(inventory = mapOf("fiber" to 47L))
        val claimed = apply(cleared, "claim_job", job.id, now.plusSeconds(2))
        assertEquals(mapOf("fiber" to 47L, "wood" to 1L, "stone" to 2L), claimed.inventory)
        assertTrue(claimed.jobs.isEmpty())
        error("ECONOMY_JOB_GONE") { apply(claimed, "claim_job", job.id, now.plusSeconds(2)) }
        assertEquals(full.inventory, apply(full, "cancel_exploration", job.id).inventory)
    }

    @Test fun `weekly final pearls are frozen paid once and capacity failure preserves goods and promise`() {
        val initial = EconomyRules.initial().copy(wallet = EconomyWallet(100_000),
            buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.last().level })
        val choice = EconomyTradeRelations.weeklyBoard(initial, now).offers.first()
        val accepted = apply(initial, "accept_weekly_order", choice.id)
        val progress = checkNotNull(accepted.tradeRelations.weekly).copy(stage = 2)
        val state = accepted.copy(inventory = progress.stages[2].items,
            tradeRelations = accepted.tradeRelations.copy(weekly = progress))
        val offer = checkNotNull(EconomyTradeRelations.weeklyBoard(state, now).active)
        assertEquals(choice.pearls, offer.pearls)
        assertTrue(offer.pearls in setOf(40L, 80L, 140L))
        val full = state.copy(wallet = state.wallet.copy(pearls = ECONOMY_MAX_PEARLS - offer.pearls + 1L))
        error("ECONOMY_CAPACITY") { apply(full, "complete_resident_order", offer.id) }
        assertEquals(state.inventory, full.inventory)
        assertEquals(progress, full.tradeRelations.weekly)
        val paid = apply(state, "complete_resident_order", offer.id)
        assertEquals(state.wallet.pearls + offer.pearls, paid.wallet.pearls)
        assertNull(paid.tradeRelations.weekly)
        error("ECONOMY_WEEKLY_CHANGED") { apply(paid, "complete_resident_order", offer.id) }
        for (oldPearls in listOf(0L, 20L)) {
            val legacyProgress = progress.copy(stages = progress.stages.mapIndexed { index, stage -> stage.copy(pearls = if (index == 2) oldPearls else 0L) })
            val legacy = state.copy(tradeRelations = state.tradeRelations.copy(weekly = legacyProgress))
            val legacyOffer = checkNotNull(EconomyTradeRelations.weeklyBoard(legacy, now).active)
            assertNotEquals(offer.id, legacyOffer.id)
            assertEquals(oldPearls, apply(legacy, "complete_resident_order", legacyOffer.id).wallet.pearls)
        }
    }
}
