package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyFoodTest {
    private val now = Instant.parse("2026-10-07T12:00:00Z")
    private fun command(action: String, target: String, quantity: Long = 1) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, quantity: Long = 1) =
        EconomyRules.apply(state, command(action, target, quantity), at).first
    private fun stocked() = EconomyRules.initial().copy(wallet = EconomyWallet(100_000),
        inventory = EconomyRules.catalog.items.associate { it.id to 20L },
        buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.last().level })
    private fun failure(code: String, block: () -> Unit) { assertEquals(code, assertFailsWith<AuthFailure>(block = block).code) }

    @Test fun `old saved states default food and orders while new state roundtrips with paid jobs`() {
        val state = apply(stocked(), "eat_food", "fish_soup")
        val old = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(state)).jsonObject - setOf("food", "residentOrders"))
        val decoded = economyJson.decodeFromString<EconomyState>(old.toString())
        assertEquals(EconomyFoodState(), decoded.food)
        assertEquals(EconomyResidentOrders(), decoded.residentOrders)
        val trip = apply(state, "start_exploration", "forest")
        assertEquals(trip, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(trip)))
        assertEquals("fish_soup", EconomyPublicJobs.project(trip.jobs.single()).meal?.itemId)
    }

    @Test fun `selected fish costs are frozen in canonical recipe jobs and collections survive cooking`() {
        val state = stocked().copy(fishing = EconomyFishing(catches = mapOf("fish_silverfin" to 7)))
        val recipe = EconomyRules.catalog.recipes.single { it.id == "cook_grilled_fish" }
        val cooked = apply(state, "start_production", "${recipe.id}@fish_silverfin", quantity = 2)
        val job = cooked.jobs.single()
        val amount = recipe.cost.items.getValue("fish") * 2
        assertEquals(recipe.id, job.recipeId)
        assertEquals(amount, job.cost.items["fish_silverfin"])
        assertFalse(job.cost.items.containsKey("fish"))
        assertEquals(state.inventory.getValue("fish_silverfin") - amount, cooked.inventory["fish_silverfin"])
        assertEquals(state.inventory["fish"], cooked.inventory["fish"])
        assertEquals(state.fishing.catches, cooked.fishing.catches)
        assertEquals(recipe.cost.items.getValue("fish"), apply(state, "start_production", recipe.id).jobs.single().cost.items["fish"])
    }

    @Test fun `dish recipes never substitute rare fish or accept malformed selections silently`() {
        val state = stocked()
        val encoded = economyJson.encodeToString(state)
        failure("ECONOMY_RECIPE_FISH") { apply(state, "start_production", "cook_grilled_fish@fish_shark") }
        failure("ECONOMY_RECIPE_FISH") { apply(state, "start_production", "grow_berries@fish") }
        failure("ECONOMY_RECIPE_FISH") { apply(state, "start_production", "cook_grilled_fish@@fish") }
        failure("ECONOMY_RESOURCES") { apply(state.copy(inventory = state.inventory - "fish_silverfin"), "start_production", "cook_grilled_fish@fish_silverfin") }
        assertEquals(encoded, economyJson.encodeToString(state))
    }

    @Test fun `eating spends one dish and arms one persistent bonus only for the next successful trip`() {
        val state = stocked()
        val fed = apply(state, "eat_food", "fish_soup")
        assertEquals(state.inventory.getValue("fish_soup") - 1, fed.inventory["fish_soup"])
        assertEquals(state.wallet, fed.wallet)
        assertEquals("fish_soup", fed.food.heroMeal)
        assertEquals(state.residentOrders, fed.residentOrders)
        failure("ECONOMY_ALREADY_FED") { apply(fed, "eat_food", "grilled_fish") }
        failure("ECONOMY_RECIPE") { apply(fed, "start_production", "missing") }
        val route = EconomyRules.catalog.explorations.single { it.id == "forest" }
        val later = now.plusSeconds(86400 * 20)
        val trip = apply(fed, "start_exploration", route.id, later)
        val job = trip.jobs.single()
        val seconds = EconomyFood.mealDuration(route.seconds, 1500)
        assertEquals(later.plusSeconds(seconds), Instant.parse(job.finishesAt))
        assertEquals(EconomyJobMeal("fish_soup", "hero", 1500), job.meal)
        assertNull(trip.food.heroMeal)
        assertEquals(seconds, job.rareDrop?.seconds)
        val canceled = apply(trip, "cancel_exploration", job.id, later)
        assertNull(canceled.food.heroMeal, "cancellation does not refund a spent bonus")
        assertEquals(fed.inventory["fish_soup"], canceled.inventory["fish_soup"])
    }

    @Test fun `failed starts preserve the pending meal and running hero jobs reject another dish`() {
        val fed = apply(stocked(), "eat_food", "grilled_fish")
        val route = EconomyRules.catalog.explorations.first { it.cost.items.isNotEmpty() }
        val poor = fed.copy(inventory = emptyMap())
        failure("ECONOMY_RESOURCES") { apply(poor, "start_exploration", route.id) }
        assertEquals("grilled_fish", poor.food.heroMeal)
        val trip = apply(fed, "start_exploration", "forest")
        for (at in listOf(now, now.plusSeconds(86400))) {
            failure("ECONOMY_EXPLORER_BUSY") { apply(trip, "eat_food", "grilled_fish", at) }
        }
        assertTrue(EconomyRules.commandUsesActor(command("eat_food", "grilled_fish")))
        assertFalse(EconomyRules.commandUsesActor(command("feed_builder", "grilled_fish")))
    }

    @Test fun `special fishing consumes hero meal without changing draw count or tackle`() {
        val state = apply(stocked().copy(fishingCastSeed = "meal-draw-vector"), "eat_food", "hearty_fish")
        val route = EconomyRules.catalog.explorations.single { it.id == EconomyRules.catalog.fishing!!.routeIds.first() }
        val trip = apply(state, "start_fishing", route.id)
        val job = trip.jobs.single()
        assertEquals(now.plusSeconds(EconomyFood.mealDuration(route.seconds, 2500)), Instant.parse(job.finishesAt))
        assertNotNull(job.fishing)
        assertEquals(state.fishing, trip.fishing)
        assertNull(trip.food.heroMeal)
        val fishIds = EconomyRules.catalog.fishing!!.fish.map { it.itemId }.toSet()
        assertEquals(route.rewards.getValue("fish"), job.rewards.filterKeys { it in fishIds }.values.sum())
    }

    @Test fun `builder pending meal applies once and errors preserve the paid bonus`() {
        val state = stocked().copy(buildings = stocked().buildings + ("garden" to 1))
        val fed = apply(state, "feed_builder", "grilled_fish")
        assertEquals("grilled_fish", fed.food.builderMeal)
        failure("ECONOMY_ALREADY_FED") { apply(fed, "feed_builder", "fish_soup") }
        failure("ECONOMY_RESOURCES") { apply(fed.copy(wallet = EconomyWallet(0), inventory = emptyMap()), "start_construction", "garden") }
        val started = apply(fed, "start_construction", "garden")
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "garden" }.levels.single { it.level == 2 }
        val job = started.jobs.single()
        assertEquals(now.plusSeconds(EconomyFood.mealDuration(upgrade.seconds, 1000)), Instant.parse(job.finishesAt))
        assertEquals(EconomyJobMeal("grilled_fish", "builder", 1000), job.meal)
        assertNull(started.food.builderMeal)
        assertNull(started.food.heroMeal)
    }

    @Test fun `feeding active builder changes only remaining time once including fractional seconds`() {
        val job = EconomyJob("existing-build", "construction", "garden", targetLevel = 2,
            startedAt = now.minusSeconds(100).toString(), finishesAt = now.plusMillis(110_001).toString(), cost = EconomyCost(100, mapOf("wood" to 4)))
        val state = stocked().copy(jobs = listOf(job))
        val fed = apply(state, "feed_builder", "hearty_fish")
        val updated = fed.jobs.single()
        assertEquals(now.plusMillis(100_001), Instant.parse(updated.finishesAt))
        assertEquals(job.startedAt, updated.startedAt)
        assertEquals(job.cost, updated.cost)
        assertEquals(job.rewards, updated.rewards)
        assertEquals(state.wallet, fed.wallet)
        assertEquals(1000, updated.meal?.speedBps)
        assertNull(fed.food.builderMeal)
        failure("ECONOMY_ALREADY_FED") { apply(fed, "feed_builder", "grilled_fish") }
        failure("ECONOMY_JOB_READY") { apply(state, "feed_builder", "grilled_fish", Instant.parse(job.finishesAt)) }
        assertTrue(EconomyRules.constructionSpeedupPrice(updated, now) <= EconomyRules.constructionSpeedupPrice(job, now))
    }

    @Test fun `duration calculation is exact speed division with ceiling and no floating point drift`() {
        assertEquals(1000L, EconomyFood.mealDuration(1100, 1000))
        assertEquals(1001L, EconomyFood.mealDuration(1101, 1000))
        assertEquals(1L, EconomyFood.mealDuration(1, 2500))
        assertEquals(31536000L, EconomyFood.mealDuration(31536000, 0))
    }

    @Test fun `order board matches browser vectors and derives automatic refresh without a state write`() {
        val state = EconomyRules.initial()
        val before = economyJson.encodeToString(state)
        val board = EconomyFood.residentOrderBoard(state, now)
        assertEquals(listOf("order_82934_0_0_plesk_silver_catch", "order_82934_1_0_builder_berry_break",
            "order_82934_2_0_plesk_river_catch"), board.offers.map { it.id })
        assertEquals("2026-10-07T18:00:00Z", board.refreshAt)
        val next = EconomyFood.residentOrderBoard(state, Instant.parse(board.refreshAt))
        assertTrue(next.offers.all { it.id.startsWith("order_82935_") })
        assertEquals(before, economyJson.encodeToString(state))
    }

    @Test fun `orders pay only coins consume the displayed goods and cannot be delivered twice`() {
        val state = stocked().copy(food = EconomyFoodState("grilled_fish", "fish_soup"))
        val offer = EconomyFood.residentOrderBoard(state, now).offers.first()
        val completed = apply(state, "complete_resident_order", offer.id)
        assertEquals(state.wallet.coins + offer.coins, completed.wallet.coins)
        assertEquals(state.food, completed.food)
        assertEquals(state.fishing, completed.fishing)
        assertEquals(state.progression, completed.progression)
        offer.items.forEach { (id, amount) -> assertEquals(state.inventory.getValue(id) - amount, completed.inventory[id] ?: 0) }
        assertEquals(1L, completed.residentOrders.completed)
        assertEquals(offer.coins, completed.residentOrders.earnedCoins)
        failure("ECONOMY_ORDER_CHANGED") { apply(completed, "complete_resident_order", offer.id) }
        val next = EconomyFood.residentOrderBoard(completed, now).offers.single { it.slot == offer.slot }
        assertNotEquals(offer.templateId, next.templateId)
        failure("ECONOMY_ORDER_WAIT") { apply(completed, "complete_resident_order", next.id) }
        val ready = apply(completed, "complete_resident_order", next.id, Instant.parse(next.availableAt))
        assertEquals(2L, ready.residentOrders.completed)
    }

    @Test fun `replacement is free changes the offer and cannot bypass its cooldown`() {
        val state = EconomyRules.initial()
        val offer = EconomyFood.residentOrderBoard(state, now).offers.first()
        val swapped = apply(state, "replace_resident_order", offer.id)
        assertEquals(state.wallet, swapped.wallet)
        assertEquals(state.inventory, swapped.inventory)
        assertEquals(0L, swapped.residentOrders.completed)
        val next = EconomyFood.residentOrderBoard(swapped, now).offers.first()
        assertNotEquals(offer.templateId, next.templateId)
        assertEquals(now.plusSeconds(1800), Instant.parse(next.availableAt))
        failure("ECONOMY_ORDER_WAIT") { apply(swapped, "replace_resident_order", next.id) }
        failure("ECONOMY_ORDER_CHANGED") { apply(swapped, "replace_resident_order", offer.id) }
    }

    @Test fun `expired offers resources wallet and command shape are checked before any debit`() {
        val state = stocked()
        val offer = EconomyFood.residentOrderBoard(state, now).offers.first()
        val before = economyJson.encodeToString(state)
        failure("ECONOMY_ORDER_CHANGED") { apply(state, "complete_resident_order", offer.id, now.plusSeconds(21600)) }
        failure("ECONOMY_RESOURCES") { apply(state.copy(inventory = emptyMap()), "complete_resident_order", offer.id) }
        failure("ECONOMY_CAPACITY") { apply(state.copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE)), "complete_resident_order", offer.id) }
        failure("ECONOMY_CAPACITY") { apply(state.copy(residentOrders = EconomyResidentOrders(completed = ECONOMY_MAX_REVISION)), "complete_resident_order", offer.id) }
        failure("ECONOMY_CAPACITY") { apply(state.copy(residentOrders = EconomyResidentOrders(earnedCoins = ECONOMY_MAX_REVISION)), "complete_resident_order", offer.id) }
        for (action in listOf("complete_resident_order", "replace_resident_order", "eat_food", "feed_builder")) {
            val target = if (action.endsWith("order")) offer.id else "grilled_fish"
            failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command(action, target).copy(quantity = 2), now) }
            failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command(action, target).copy(totalPrice = 1), now) }
        }
        assertEquals(before, economyJson.encodeToString(state))
    }

    @Test fun `food and order history survive money conversion and account merging keeps stricter cooldowns`() {
        val legacy = EconomyRules.initial().copy(currencyScale = 1, pearlScale = 1,
            food = EconomyFoodState("grilled_fish", "fish_soup"), residentOrders = EconomyResidentOrders(completed = 3, earnedCoins = 100))
        val converted = EconomyMoney.redenominate(legacy)
        assertEquals(1000L, converted.residentOrders.earnedCoins)
        assertEquals(legacy.food, converted.food)
        assertEquals(3L, converted.residentOrders.completed)
        val a = EconomyResidentOrders(1, listOf(EconomyResidentOrderSlot(2, now.plusSeconds(60).toString())), 2, 200)
        val b = EconomyResidentOrders(1, listOf(EconomyResidentOrderSlot(1, now.plusSeconds(120).toString())), 4, 400)
        val merged = EconomyFood.mergeOrders(a, b)
        assertEquals(2L, merged.slots.single().sequence)
        assertEquals(now.plusSeconds(120), Instant.parse(merged.slots.single().readyAt))
        assertEquals(6L, merged.completed)
        assertEquals(600L, merged.earnedCoins)
    }
}
