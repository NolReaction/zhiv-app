package ru.zhiv.economy

import kotlinx.serialization.Serializable
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
    private fun command(action: String, target: String, quantity: Long = 1, totalPrice: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity, totalPrice)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, quantity: Long = 1, totalPrice: Long = 0) =
        EconomyRules.apply(state, command(action, target, quantity, totalPrice), at).first
    private fun stocked() = EconomyRules.initial().copy(wallet = EconomyWallet(100_000),
        inventory = EconomyRules.catalog.items.filter { item -> EconomyRules.catalog.fishing!!.fish.none { it.itemId == item.id } }.associate { it.id to 20L },
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

    @Test fun `class fish costs are frozen in recipe jobs and collections survive cooking`() {
        val state = stocked().copy(fishing = EconomyFishing(catches = mapOf("fish_silverfin" to 7)))
        val recipe = EconomyRules.catalog.recipes.single { it.id == "cook_grilled_fish" }
        failure("INVALID_ECONOMY_COMMAND") { apply(state, "start_production", recipe.id, quantity = 2) }
        val cooked = apply(state, "start_production", recipe.id)
        val job = cooked.jobs.single()
        val amount = recipe.cost.items.getValue("fish_common")
        assertEquals(recipe.id, job.recipeId)
        assertEquals(mapOf("grilled_fish" to 1L), job.rewards)
        assertEquals(amount, job.cost.items["fish_common"])
        assertFalse(job.cost.items.containsKey("fish_silverfin"))
        assertEquals(state.inventory.getValue("fish_common") - amount, cooked.inventory["fish_common"])
        assertEquals(state.inventory["fish_rare"], cooked.inventory["fish_rare"])
        assertEquals(state.fishing.catches, cooked.fishing.catches)
        assertEquals(recipe.cost.items.getValue("fish_common"), apply(state, "start_production", recipe.id).jobs.single().cost.items["fish_common"])
    }

    @Test fun `dish recipes require their exact class and reject old species selectors`() {
        val state = stocked()
        val encoded = economyJson.encodeToString(state)
        for (target in listOf("cook_grilled_fish@fish_shark", "grow_berries@fish", "cook_grilled_fish@@fish", "cook_grilled_fish@fish_silverfin"))
            failure("ECONOMY_RECIPE_FISH") { apply(state, "start_production", target) }
        failure("ECONOMY_RESOURCES") { apply(state.copy(inventory = state.inventory - "fish_common"), "start_production", "cook_grilled_fish") }
        failure("ECONOMY_RESOURCES") { apply(state.copy(inventory = state.inventory - "fish_rare"), "start_production", "cook_hearty_fish") }
        val dinner = apply(state, "start_production", "cook_hearty_fish")
        assertEquals(1L, dinner.jobs.single().cost.items["fish_rare"])
        assertEquals(state.inventory["fish_epic"], dinner.inventory["fish_epic"])
        assertEquals(encoded, economyJson.encodeToString(state))
    }

    @Test fun `eating spends one dish and arms one persistent bonus only for the next successful trip`() {
        val state = stocked()
        val fed = apply(state, "eat_food", "fish_soup")
        assertEquals(state.inventory.getValue("fish_soup") - 1, fed.inventory["fish_soup"])
        assertEquals(state.wallet, fed.wallet)
        assertEquals("fish_soup", fed.food.heroMeal)
        assertEquals(EconomyFood.normalizedOrders(state, now), fed.residentOrders)
        failure("ECONOMY_ALREADY_FED") { apply(fed, "eat_food", "grilled_fish") }
        failure("ECONOMY_RECIPE") { apply(fed, "start_production", "missing") }
        val route = EconomyRules.catalog.explorations.single { it.id == "forest" }
        val later = now.plusSeconds(86400 * 20)
        val trip = apply(fed, "start_exploration", route.id, later)
        val job = trip.jobs.single()
        val seconds = EconomyFood.mealDuration(route.seconds, 2500)
        assertEquals(later.plusSeconds(seconds), Instant.parse(job.finishesAt))
        assertEquals(EconomyJobMeal("fish_soup", "hero", 2500), job.meal)
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
        assertEquals(now.plusSeconds(EconomyFood.mealDuration(route.seconds, 6000)), Instant.parse(job.finishesAt))
        assertNotNull(job.fishing)
        assertEquals(state.fishing, trip.fishing)
        assertNull(trip.food.heroMeal)
        val fishIds = EconomyRules.catalog.fishing!!.fish.map { it.itemId }.toSet()
        assertEquals(route.rewards.getValue("fish"), job.rewards.filterKeys { it in fishIds }.values.sum())
    }

    @Test fun `pending portions return once to the pantry independently without granting a bonus`() {
        val original = stocked().copy(inventory = mapOf("grilled_fish" to 2L, "fish_soup" to 1L))
        val fed = apply(apply(original, "eat_food", "grilled_fish"), "feed_builder", "fish_soup")
        val heroReturned = apply(fed, "cancel_meal", "hero")
        assertEquals(mapOf("grilled_fish" to 2L), heroReturned.inventory)
        assertEquals(EconomyFoodState(null, "fish_soup"), heroReturned.food)
        failure("ECONOMY_MEAL_UNAVAILABLE") { apply(heroReturned, "cancel_meal", "hero") }
        val returned = apply(heroReturned, "cancel_meal", "builder")
        assertEquals(original.inventory, returned.inventory)
        assertEquals(EconomyFoodState(), returned.food)
        assertEquals(original.jobs, returned.jobs)
        assertEquals(original.wallet, returned.wallet)
        failure("ECONOMY_MEAL_UNAVAILABLE") { apply(returned, "cancel_meal", "builder") }
    }

    @Test fun `pending return preserves owned overflow including escrow but cannot grow new stock`() {
        val original = EconomyRules.initial()
        val capacity = EconomyRules.storage(original).capacity
        val reserved = mapOf("stone" to 1L)
        var state = original.copy(inventory = mapOf("wood" to capacity - 1), food = EconomyFoodState("grilled_fish", "fish_soup"))
        for (consumer in listOf("hero", "builder")) {
            val before = state
            state = EconomyRules.apply(state, command("cancel_meal", consumer), now, reserved).first
            EconomyRules.assertStorageTransition(before, state, reserved)
        }
        assertEquals(2L, EconomyRules.storage(state, reserved).overflow)
        assertEquals(1L, state.inventory["grilled_fish"])
        assertEquals(1L, state.inventory["fish_soup"])
        failure("ECONOMY_STORAGE_FULL") {
            EconomyRules.assertStorageTransition(state, state.copy(inventory = EconomyRules.addItems(state.inventory, mapOf("wood" to 1L))), reserved)
        }
        repeat(3) { state = apply(apply(state, "eat_food", "grilled_fish"), "cancel_meal", "hero") }
        assertEquals(1L, state.inventory["grilled_fish"])
        assertEquals(2L, EconomyRules.storage(state, reserved).overflow)
    }

    @Test fun `refund decoder rejects forged consumer amounts price and fish while capacity errors retain pending meal`() {
        val request = command("cancel_meal", "hero")
        fun decode(value: EconomyCommand) = decodeEconomyCommand(economyJson.parseToJsonElement(economyJson.encodeToString(value)))
        assertEquals(request, decode(request))
        assertEquals("builder", decode(request.copy(targetId = "builder")).targetId)
        for (invalid in listOf(request.copy(targetId = "grilled_fish"), request.copy(quantity = 2),
            request.copy(totalPrice = 1), request.copy(fishSelection = emptyMap()))) {
            failure("INVALID_ECONOMY_COMMAND") { decode(invalid) }
        }
        val state = stocked().copy(inventory = mapOf("grilled_fish" to ECONOMY_MAX_ITEMS), food = EconomyFoodState("grilled_fish", null))
        failure("ECONOMY_CAPACITY") { apply(state, "cancel_meal", "hero") }
        failure("ECONOMY_CAPACITY") {
            EconomyRules.apply(state.copy(inventory = mapOf("grilled_fish" to ECONOMY_MAX_ITEMS - 1)), request, now, mapOf("grilled_fish" to 1))
        }
        assertEquals("grilled_fish", state.food.heroMeal)
        assertEquals(ECONOMY_MAX_ITEMS, state.inventory["grilled_fish"])
    }

    @Test fun `consumed hero food cannot return after starting or abandoning a boosted trip`() {
        val fed = apply(stocked(), "eat_food", "grilled_fish")
        val trip = apply(fed, "start_exploration", "forest")
        failure("ECONOMY_MEAL_UNAVAILABLE") { apply(trip, "cancel_meal", "hero") }
        failure("ECONOMY_MEAL_UNAVAILABLE") { apply(trip, "cancel_meal", "hero", Instant.parse(trip.jobs.single().finishesAt)) }
        val abandoned = apply(trip, "cancel_exploration", trip.jobs.single().id)
        failure("ECONOMY_MEAL_UNAVAILABLE") { apply(abandoned, "cancel_meal", "hero") }
        assertEquals(fed.inventory["grilled_fish"], abandoned.inventory["grilled_fish"])
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
        assertEquals(now.plusMillis(73_334), Instant.parse(updated.finishesAt))
        assertEquals(job.startedAt, updated.startedAt)
        assertEquals(job.cost, updated.cost)
        assertEquals(job.rewards, updated.rewards)
        assertEquals(state.wallet, fed.wallet)
        assertEquals(5000, updated.meal?.speedBps)
        assertNull(fed.food.builderMeal)
        failure("ECONOMY_ALREADY_FED") { apply(fed, "feed_builder", "grilled_fish") }
        failure("ECONOMY_MEAL_UNAVAILABLE") { apply(fed, "cancel_meal", "builder") }
        failure("ECONOMY_MEAL_UNAVAILABLE") { apply(fed, "cancel_meal", "builder", Instant.parse(updated.finishesAt)) }
        val legacy = fed.copy(food = EconomyFoodState(builderMeal = "grilled_fish"))
        val returned = apply(legacy, "cancel_meal", "builder")
        assertEquals(fed.jobs, returned.jobs, "returning a distinct pending portion cannot alter an applied job bonus")
        assertEquals((fed.inventory["grilled_fish"] ?: 0L) + 1, returned.inventory["grilled_fish"])
        failure("ECONOMY_JOB_READY") { apply(state, "feed_builder", "grilled_fish", Instant.parse(job.finishesAt)) }
        assertTrue(EconomyRules.constructionSpeedupPrice(updated, now) <= EconomyRules.constructionSpeedupPrice(job, now))
    }

    @Test fun `six hour workshop upgrade at 25 percent extra speed takes 4h48m and saves 1h12m`() {
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "workshop" }.levels.single { it.level == 2 }
        assertEquals(6 * 3600L, upgrade.seconds)
        val state = stocked().copy(buildings = stocked().buildings + ("workshop" to 1))
        val started = apply(apply(state, "feed_builder", "fish_soup"), "start_construction", "workshop")
        val job = started.jobs.single()
        assertEquals(now.plusSeconds(4 * 3600 + 48 * 60L), Instant.parse(job.finishesAt))
        assertEquals(72 * 60L, upgrade.seconds - java.time.Duration.between(now, Instant.parse(job.finishesAt)).seconds)
        assertEquals(EconomyJobMeal("fish_soup", "builder", 2500), job.meal)
        assertEquals(upgrade.cost, job.cost)
        assertEquals(state.wallet.coins - upgrade.cost.coins, started.wallet.coins)
        assertEquals((state.inventory["fish_soup"] ?: 0L) - 1, started.inventory["fish_soup"])
    }

    @Test fun `duration calculation is exact speed division with ceiling and no floating point drift`() {
        assertEquals(1000L, EconomyFood.mealDuration(1100, 1000))
        assertEquals(1001L, EconomyFood.mealDuration(1101, 1000))
        assertEquals(1L, EconomyFood.mealDuration(1, 2500))
        assertEquals(31536000L, EconomyFood.mealDuration(31536000, 0))
        assertEquals(500L, EconomyFood.mealDuration(1000, 10000))
        assertEquals(501L, EconomyFood.mealDuration(1001, 10000))
        assertEquals(1000L, EconomyFood.mealDuration(1900, 9000))
        assertFailsWith<IllegalArgumentException> { EconomyFood.mealDuration(1000, 10001) }
    }

    @Test fun `six meal tiers use recorded individual hero and builder speed bonuses`() {
        val expected = listOf("grilled_fish" to (1000 to 1000), "fish_soup" to (2500 to 2500),
            "berry_fish" to (4000 to 3500), "hearty_fish" to (6000 to 5000),
            "epic_fish" to (8000 to 7000), "legendary_fish" to (10000 to 9000))
        val route = EconomyRules.catalog.explorations.single { it.id == "forest" }
        val build = EconomyJob("existing-build", "construction", "garden", targetLevel = 2,
            startedAt = now.minusSeconds(10).toString(), finishesAt = now.plusMillis(19_001).toString())
        expected.forEach { (id, bonuses) ->
            val meal = EconomyRules.catalog.food!!.meals.single { it.itemId == id }
            assertEquals(bonuses.first, meal.heroSpeedBps)
            assertEquals(bonuses.second, meal.builderSpeedBps)
            val journey = apply(apply(stocked(), "eat_food", id), "start_exploration", route.id).jobs.single()
            assertEquals(now.plusSeconds(EconomyFood.mealDuration(route.seconds, bonuses.first)), Instant.parse(journey.finishesAt))
            assertEquals(bonuses.first, journey.meal?.speedBps)
            val construction = apply(stocked().copy(jobs = listOf(build)), "feed_builder", id).jobs.single()
            assertEquals(now.plusMillis(EconomyFood.mealDuration(19_001, bonuses.second)), Instant.parse(construction.finishesAt))
            assertEquals(bonuses.second, construction.meal?.speedBps)
        }
    }

    @Test fun `old paid jobs retain saved ten percent builder bonus rather than a new catalog tier`() {
        val original = EconomyJob("old-build", "construction", "garden", targetLevel = 2,
            startedAt = now.minusSeconds(100).toString(), finishesAt = now.plusSeconds(1000).toString(),
            cost = EconomyCost(117, mapOf("wood" to 9)), meal = EconomyJobMeal("hearty_fish", "builder", 1000))
        val state = stocked().copy(jobs = listOf(original))
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(state))
        assertEquals(original, restored.jobs.single())
        assertEquals(original, EconomyPublicJobs.project(restored.jobs.single()))
        failure("ECONOMY_ALREADY_FED") { apply(restored, "feed_builder", "legendary_fish") }
        assertEquals(original, restored.jobs.single())
    }

    @Test fun `old order JSON migrates only in derived state without preserving obsolete cooldowns`() {
        val old = economyJson.decodeFromString<EconomyResidentOrders>(
            """{"cycle":82934,"slots":[{"sequence":4,"readyAt":"2099-01-01T00:00:00Z"}],"completed":9,"earnedCoins":42}""")
        assertEquals(1, old.version)
        assertEquals(emptyList(), old.recentTemplateIds)
        assertEquals(-1L, old.replacementCycle)
        val state = EconomyRules.initial().copy(residentOrders = old)
        val before = economyJson.encodeToString(state)
        val board = EconomyFood.residentOrderBoard(state, now)
        assertEquals(3, board.offers.size)
        assertEquals(9L, board.completed)
        assertEquals(42L, board.earnedCoins)
        assertEquals(3, board.freeReplacementsRemaining)
        assertTrue(board.offers.all { !Instant.parse(it.availableAt).isAfter(now) })
        assertEquals(before, economyJson.encodeToString(state))
        val mutated = apply(state, "replace_resident_order", board.offers.first().id)
        assertEquals(2, mutated.residentOrders.version)
        assertEquals(1, mutated.residentOrders.freeReplacementsUsed)
    }

    @Serializable private data class OrderVectorStage(val ids: List<String>, val templates: List<String>, val history: List<String>,
        val label: String? = null, val quota: Int? = null)
    @Serializable private data class OrderVectors(val now: String, val config: EconomyResidentOrdersConfig,
        val stages: List<OrderVectorStage>, val refresh: OrderVectorStage)

    @Test fun `browser and Kotlin share fingerprint generation history and refresh vectors`() {
        val vectors = economyJson.decodeFromString<OrderVectors>(checkNotNull(javaClass.getResourceAsStream("/world/orders-v2-vectors.json"))
            .bufferedReader().use { it.readText() })
        val at = Instant.parse(vectors.now)
        val catalog = EconomyRules.catalog.copy(food = EconomyRules.catalog.food!!.copy(orders = vectors.config))
        var state = EconomyRules.initial()
        fun checkVector(expected: OrderVectorStage, time: Instant) {
            val board = EconomyFood.residentOrderBoard(state, time, catalog)
            val normalized = EconomyFood.normalizedOrders(state, time, catalog)
            assertEquals(expected.ids, board.offers.map { it.id }, expected.label)
            assertEquals(expected.templates, board.offers.map { it.templateId }, expected.label)
            assertEquals(expected.history, normalized.recentTemplateIds, expected.label)
            expected.quota?.let { assertEquals(it, board.freeReplacementsRemaining, expected.label) }
        }
        checkVector(vectors.stages.first(), at)
        listOf(0, 1, 2, 0, 0, 0, 1, 2).forEachIndexed { index, slot ->
            state = state.copy(residentOrders = EconomyFood.advanceResidentOrder(state, slot, at, catalog))
            checkVector(vectors.stages[index + 1], at)
        }
        checkVector(vectors.refresh, at.plusSeconds(43200))
    }

    @Test fun `exhausted recent history relaxes oldest locally without duplicating current offers`() {
        val templates = listOf(
            EconomyResidentOrderTemplate("plesk_a", "plesk", "A", items = mapOf("fish_common" to 1), coins = 10),
            EconomyResidentOrderTemplate("plesk_b", "plesk", "B", items = mapOf("fish_common" to 2), coins = 20),
            EconomyResidentOrderTemplate("builder_a", "builder", "A", items = mapOf("wood" to 1), coins = 10),
            EconomyResidentOrderTemplate("builder_b", "builder", "B", items = mapOf("wood" to 2), coins = 20))
        val catalog = EconomyRules.catalog.copy(food = EconomyRules.catalog.food!!.copy(orders = EconomyRules.catalog.food!!.orders.copy(templates = templates)))
        val initial = EconomyRules.initial()
        val board = EconomyFood.normalizedOrders(initial, now, catalog)
        val current = board.slots[0].templateId!!
        val state = initial.copy(residentOrders = board.copy(recentTemplateIds = templates.map { it.id }))
        val advanced = EconomyFood.advanceResidentOrder(state, 0, now, catalog)
        val offers = EconomyFood.residentOrderBoard(state.copy(residentOrders = advanced), now, catalog).offers
        assertEquals(3, offers.map { it.templateId }.distinct().size)
        val outgoingAlternatives = templates.filter { it.residentId == "plesk" && it.id != current && it.id !in board.slots.drop(1).map { it.templateId } }
        if (outgoingAlternatives.isNotEmpty()) assertNotEquals(current, offers.first().templateId)
        assertEquals(templates.map { it.id }.filter { it != current } + current, advanced.recentTemplateIds,
            "temporary history relaxation must not erase persisted retired IDs")
    }

    @Test fun `free and paid replacements with no different order preserve quota wallet and history`() {
        val only = EconomyResidentOrderTemplate("only_builder", "builder", "Материалы", items = mapOf("wood" to 2L), coins = 40)
        val food = checkNotNull(EconomyRules.catalog.food)
        val catalog = EconomyRules.catalog.copy(food = food.copy(orders = food.orders.copy(templates = listOf(only))))
        val initial = stocked().copy(wallet = EconomyWallet(1000, 100))
        val normalized = EconomyFood.normalizedOrders(initial, now, catalog)
        for (used in listOf(0, 3)) {
            val state = initial.copy(residentOrders = normalized.copy(freeReplacementsUsed = used))
            val board = EconomyFood.residentOrderBoard(state, now, catalog)
            val offer = board.offers.single()
            val before = economyJson.encodeToString(state)
            failure("ECONOMY_ORDER_NO_ALTERNATIVE") {
                EconomyFood.order(state, offer.id, true, now, board.replacementPricePearls, catalog)
            }
            assertEquals(before, economyJson.encodeToString(state), "failed replacement cannot spend a free use or pearls")
            val completed = EconomyFood.order(state, offer.id, false, now, catalog = catalog).first
            assertEquals(state.wallet.coins + offer.coins, completed.wallet.coins)
            assertEquals(state.wallet.pearls, completed.wallet.pearls)
            assertEquals(used, completed.residentOrders.freeReplacementsUsed)
            assertEquals(only.id, EconomyFood.residentOrderBoard(completed, now, catalog).offers.single().templateId)
        }
    }

    @Test fun `renamed identical requirement is not a paid replacement`() {
        val food = checkNotNull(EconomyRules.catalog.food)
        val original = EconomyResidentOrderTemplate("builder_a", "builder", "Материалы", items = mapOf("wood" to 2L), coins = 40)
        val duplicate = original.copy(id = "builder_b", name = "Другие материалы", coins = 50)
        // A malformed or reduced custom catalogue must fail safely even before catalog validation is rerun.
        val catalog = EconomyRules.catalog.copy(food = food.copy(orders = food.orders.copy(templates = listOf(original, duplicate))))
        val state = stocked().copy(wallet = EconomyWallet(1000, 100))
        val normalized = EconomyFood.normalizedOrders(state, now, catalog).copy(freeReplacementsUsed = 3)
        val paid = state.copy(residentOrders = normalized)
        val board = EconomyFood.residentOrderBoard(paid, now, catalog)
        val before = economyJson.encodeToString(paid)
        failure("ECONOMY_ORDER_NO_ALTERNATIVE") {
            EconomyFood.order(paid, board.offers.single().id, true, now, board.replacementPricePearls, catalog)
        }
        assertEquals(before, economyJson.encodeToString(paid))
    }

    @Test fun `board refresh and free replacement windows are read only and use twelve hour boundaries`() {
        val state = EconomyRules.initial()
        val before = economyJson.encodeToString(state)
        val board = EconomyFood.residentOrderBoard(state, now)
        assertEquals("2026-10-08T00:00:00Z", board.refreshAt)
        assertEquals(board.refreshAt, board.replacementsResetAt)
        assertEquals(3, board.freeReplacementsRemaining)
        assertEquals(0L, board.replacementPricePearls)
        assertTrue(board.offers.all { it.id.startsWith("order2_41467_") && it.id.length <= 80 })
        assertEquals("plesk", board.offers[0].residentId)
        assertEquals("builder", board.offers[1].residentId)
        assertEquals(3, board.offers.map { it.templateId }.distinct().size)
        val next = EconomyFood.residentOrderBoard(state, Instant.parse(board.refreshAt))
        assertTrue(next.offers.all { it.id.startsWith("order2_41468_") })
        assertEquals(before, economyJson.encodeToString(state))
    }

    @Test fun `board refresh cannot reset free quota before the independent replacement window`() {
        val catalog = EconomyRules.catalog.copy(food = EconomyRules.catalog.food!!.copy(orders = EconomyRules.catalog.food!!.orders.copy(refreshSeconds = 21600)))
        val initial = EconomyRules.initial()
        val normalized = EconomyFood.normalizedOrders(initial, now, catalog).copy(freeReplacementsUsed = 2)
        val state = initial.copy(residentOrders = normalized)
        val refreshed = EconomyFood.residentOrderBoard(state, now.plusSeconds(21600), catalog)
        assertEquals(1, refreshed.freeReplacementsRemaining)
        assertEquals("2026-10-08T00:00:00Z", refreshed.replacementsResetAt)
        assertEquals(3, EconomyFood.residentOrderBoard(state, now.plusSeconds(43200), catalog).freeReplacementsRemaining)
        assertEquals(2, state.residentOrders.freeReplacementsUsed, "reading new periods never changes persisted usage")
    }

    @Test fun `orders pay only coins and replace immediately while untouched cards remain stable`() {
        val state = stocked().copy(food = EconomyFoodState("grilled_fish", "fish_soup"))
        val board = EconomyFood.residentOrderBoard(state, now)
        val offer = board.offers.first()
        val completed = apply(state, "complete_resident_order", offer.id)
        assertEquals(state.wallet.coins + offer.coins, completed.wallet.coins)
        assertEquals(state.wallet.pearls, completed.wallet.pearls)
        assertEquals(state.food, completed.food)
        assertEquals(state.fishing, completed.fishing)
        assertEquals(state.progression, completed.progression)
        offer.items.forEach { (id, amount) -> assertEquals(state.inventory.getValue(id) - amount, completed.inventory[id] ?: 0) }
        assertEquals(1L, completed.residentOrders.completed)
        assertEquals(offer.coins, completed.residentOrders.earnedCoins)
        failure("ECONOMY_ORDER_CHANGED") { apply(completed, "complete_resident_order", offer.id) }
        val nextBoard = EconomyFood.residentOrderBoard(completed, now)
        assertEquals(board.offers.drop(1), nextBoard.offers.drop(1))
        val next = nextBoard.offers.single { it.slot == offer.slot }
        assertNotEquals(offer.templateId, next.templateId)
        assertTrue(!Instant.parse(next.availableAt).isAfter(now))
        assertEquals(3, nextBoard.freeReplacementsRemaining)
        val supplied = completed.copy(inventory = next.items)
        val ready = apply(supplied, "complete_resident_order", next.id)
        assertEquals(2L, ready.residentOrders.completed)
        assertEquals(supplied.wallet.coins + next.coins, ready.wallet.coins)
        assertTrue(ready.inventory.isEmpty())
    }

    @Test fun `free replacement budget is shared across slots then server pearl price requires confirmation`() {
        var state = stocked().copy(wallet = EconomyWallet(100_000, 100))
        val inventory = state.inventory
        repeat(3) { index ->
            val board = EconomyFood.residentOrderBoard(state, now)
            assertEquals(3 - index, board.freeReplacementsRemaining)
            assertEquals(0L, board.replacementPricePearls)
            state = apply(state, "replace_resident_order", board.offers[index].id)
            assertEquals(100L, state.wallet.pearls)
        }
        val board = EconomyFood.residentOrderBoard(state, now)
        assertEquals(0, board.freeReplacementsRemaining)
        assertEquals(10L, board.replacementPricePearls)
        val before = economyJson.encodeToString(state)
        failure("ECONOMY_ORDER_PRICE_CHANGED") { apply(state, "replace_resident_order", board.offers.first().id) }
        failure("ECONOMY_PEARLS") { apply(state.copy(wallet = EconomyWallet(100_000, 9)), "replace_resident_order", board.offers.first().id, totalPrice = 10) }
        assertEquals(before, economyJson.encodeToString(state))
        val paid = apply(state, "replace_resident_order", board.offers.first().id, totalPrice = 10)
        assertEquals(90L, paid.wallet.pearls)
        assertEquals(state.wallet.coins, paid.wallet.coins)
        assertEquals(inventory, paid.inventory)
        assertEquals(0L, paid.residentOrders.completed)
        assertEquals(3, paid.residentOrders.freeReplacementsUsed)
        failure("ECONOMY_ORDER_CHANGED") { apply(paid, "replace_resident_order", board.offers.first().id, totalPrice = 10) }
        val resetAt = Instant.parse(board.replacementsResetAt)
        val reset = EconomyFood.residentOrderBoard(paid, resetAt)
        assertEquals(3, reset.freeReplacementsRemaining)
        val freeAgain = apply(paid, "replace_resident_order", reset.offers.first().id, resetAt, totalPrice = 10)
        assertEquals(paid.wallet, freeAgain.wallet, "a stale higher quote never causes a charge after quota reset")
        assertEquals(1, freeAgain.residentOrders.freeReplacementsUsed)
    }

    @Test fun `current and retired orders are excluded and home upgrades do not replace untouched cards`() {
        val initial = EconomyRules.initial()
        var state = initial.copy(wallet = EconomyWallet(100_000, 1000),
            buildings = initial.buildings + mapOf("home" to 2, "woodlot" to 1, "workshop" to 1, "dryer" to 1, "quarry" to 2, "kiln" to 1))
        repeat(12) { index ->
            val before = EconomyFood.residentOrderBoard(state, now)
            val slot = index % 3
            val retired = before.offers[slot]
            val next = apply(state, "replace_resident_order", retired.id, totalPrice = before.replacementPricePearls)
            val after = EconomyFood.residentOrderBoard(next, now)
            assertEquals(3, after.offers.map { it.templateId }.distinct().size)
            assertNotEquals(retired.templateId, after.offers[slot].templateId)
            before.offers.filter { it.slot != slot }.forEach { old -> assertEquals(old, after.offers.single { it.slot == old.slot }) }
            assertTrue(next.residentOrders.recentTemplateIds.size <= 6)
            state = next
        }
        val lockedIn = EconomyFood.residentOrderBoard(state, now).offers
        val upgraded = state.copy(buildings = stocked().buildings)
        assertEquals(lockedIn, EconomyFood.residentOrderBoard(upgraded, now).offers)
    }

    @Test fun `first building claim locks in already displayed legacy board before unlocking templates`() {
        val home = EconomyJob("home-upgrade", "construction", "home", targetLevel = 3,
            startedAt = now.minusSeconds(200).toString(), finishesAt = now.minusSeconds(1).toString())
        val initial = EconomyRules.initial().copy(jobs = listOf(home))
        assertEquals(1, initial.residentOrders.version)
        val displayed = EconomyFood.residentOrderBoard(initial, now)
        val upgraded = apply(initial, "claim_job", home.id)
        assertEquals(3, upgraded.buildings["home"])
        assertEquals(2, upgraded.residentOrders.version)
        assertEquals(displayed.offers, EconomyFood.residentOrderBoard(upgraded, now).offers)
        assertEquals(3, upgraded.residentOrders.slots.size)
        assertEquals(0, upgraded.residentOrders.freeReplacementsUsed)
    }

    @Test fun `catalog changes alter fingerprint so old offers cannot silently debit different goods`() {
        val state = stocked()
        val catalog = EconomyRules.catalog
        val before = EconomyFood.residentOrderBoard(state, now, catalog)
        val chosen = before.offers.first()
        val changed = catalog.copy(food = catalog.food!!.copy(orders = catalog.food!!.orders.copy(
            templates = catalog.food!!.orders.templates.map { if (it.id == chosen.templateId) it.copy(coins = it.coins + 10) else it })))
        val newOffer = EconomyFood.residentOrderBoard(state, now, changed).offers.single { it.slot == chosen.slot }
        assertNotEquals(chosen.id, newOffer.id)
        failure("ECONOMY_ORDER_CHANGED") { apply(state, "complete_resident_order", newOffer.id) }
        assertEquals(chosen.items, newOffer.items)
    }

    @Test fun `expired offers resources wallet limits and invalid command shapes never debit`() {
        val state = stocked()
        val offer = EconomyFood.residentOrderBoard(state, now).offers.first()
        val before = economyJson.encodeToString(state)
        failure("ECONOMY_ORDER_CHANGED") { apply(state, "complete_resident_order", offer.id, now.plusSeconds(43200)) }
        failure("ECONOMY_RESOURCES") { apply(state.copy(inventory = emptyMap()), "complete_resident_order", offer.id) }
        failure("ECONOMY_CAPACITY") { apply(state.copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE)), "complete_resident_order", offer.id) }
        failure("ECONOMY_CAPACITY") { apply(state.copy(residentOrders = EconomyResidentOrders(completed = ECONOMY_MAX_REVISION)), "complete_resident_order", offer.id) }
        failure("ECONOMY_CAPACITY") { apply(state.copy(residentOrders = EconomyResidentOrders(earnedCoins = ECONOMY_MAX_REVISION)), "complete_resident_order", offer.id) }
        for (action in listOf("complete_resident_order", "replace_resident_order", "eat_food", "feed_builder")) {
            val target = if (action.endsWith("order")) offer.id else "grilled_fish"
            failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command(action, target).copy(quantity = 2), now) }
            if (action != "replace_resident_order") failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command(action, target).copy(totalPrice = 1), now) }
        }
        assertEquals(before, economyJson.encodeToString(state))
    }

    @Test fun `merging keeps target offers and combines used quota only within current window`() {
        var target = stocked()
        var source = stocked()
        repeat(2) {
            target = apply(target, "replace_resident_order", EconomyFood.residentOrderBoard(target, now).offers.first().id)
            source = apply(source, "replace_resident_order", EconomyFood.residentOrderBoard(source, now).offers[1].id)
        }
        target = target.copy(residentOrders = target.residentOrders.copy(completed = 2, earnedCoins = 200))
        source = source.copy(residentOrders = source.residentOrders.copy(completed = 4, earnedCoins = 400))
        val expected = EconomyFood.residentOrderBoard(target, now).offers
        val merged = EconomyFood.mergeOrders(target, source, now)
        assertEquals(expected, EconomyFood.residentOrderBoard(target.copy(residentOrders = merged), now).offers)
        assertEquals(6L, merged.completed)
        assertEquals(600L, merged.earnedCoins)
        assertEquals(3, merged.freeReplacementsUsed)
        assertTrue(merged.recentTemplateIds.size <= 6)
        assertEquals(10L, EconomyFood.residentOrderBoard(target.copy(residentOrders = merged), now).replacementPricePearls)
        val expiredSource = source.copy(residentOrders = source.residentOrders.copy(replacementCycle = source.residentOrders.replacementCycle - 1))
        assertEquals(2, EconomyFood.mergeOrders(target, expiredSource, now).freeReplacementsUsed)
        val saturated = source.copy(residentOrders = source.residentOrders.copy(completed = ECONOMY_MAX_REVISION, earnedCoins = ECONOMY_MAX_REVISION))
        val capped = EconomyFood.mergeOrders(target, saturated, now)
        assertEquals(ECONOMY_MAX_REVISION, capped.completed)
        assertEquals(ECONOMY_MAX_REVISION, capped.earnedCoins)
    }

    @Test fun `food and order earnings retain correct denomination`() {
        val legacy = EconomyRules.initial().copy(currencyScale = 1, pearlScale = 1,
            food = EconomyFoodState("grilled_fish", "fish_soup"), residentOrders = EconomyResidentOrders(completed = 3, earnedCoins = 100))
        val converted = EconomyMoney.redenominate(legacy)
        assertEquals(1000L, converted.residentOrders.earnedCoins)
        assertEquals(legacy.food, converted.food)
        assertEquals(3L, converted.residentOrders.completed)
    }

    @Test fun `saved unreachable order is replaced without spending quota or changing reachable accepted terms`() {
        val initial = EconomyRules.initial()
        val board = EconomyFood.normalizedOrders(initial, now).copy(completed = 7, earnedCoins = 1234, freeReplacementsUsed = 2)
        val locked = EconomyResidentOrderTemplate("old_compote", "plesk", "Старый компот", items = mapOf("berry_compote" to 2L), coins = 900)
        val state = initial.copy(residentOrders = board.copy(slots = board.slots.mapIndexed { index, slot ->
            if (index == 0) slot.copy(templateId = locked.id, terms = locked) else slot
        }))
        val before = economyJson.encodeToString(state)
        val normalized = EconomyFood.normalizedOrders(state, now)
        assertNotEquals(locked.id, normalized.slots[0].templateId)
        assertEquals(board.slots.drop(1), normalized.slots.drop(1))
        assertEquals(2, normalized.freeReplacementsUsed)
        assertEquals(7L, normalized.completed)
        assertEquals(1234L, normalized.earnedCoins)
        assertTrue(locked.id in normalized.recentTemplateIds)
        val reachable = EconomyFood.obtainableOrderItems(state)
        assertTrue(normalized.slots.all { slot -> slot.terms!!.items.keys.all { it in reachable } })
        assertEquals(before, economyJson.encodeToString(state))
        val unlocked = state.copy(buildings = state.buildings + mapOf("dryer" to 1, "garden" to 1))
        assertEquals(locked, EconomyFood.normalizedOrders(unlocked, now).slots[0].terms,
            "retired but reachable accepted terms must retain the exact promised quantities and payout")
    }

}
