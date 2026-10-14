package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomySecondStageTest {
    private val now = Instant.parse("2026-10-14T10:00:00Z")
    private val course get() = EconomyRules.catalog.stageOrders.single { it.homeLevel == 2 }
    private fun command(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) = EconomyRules.apply(state, command(action, target), at).first
    private fun player(home: Int = 2) = EconomyRules.initial().let { initial -> initial.copy(
        wallet = EconomyWallet(100_000), inventory = emptyMap(), buildings = initial.buildings +
            mapOf("home" to home, "garden" to 1, "woodlot" to 1, "workshop" to 1, "dryer" to 1, "quarry" to 2, "kiln" to 1),
        tutorialOrder = initial.tutorialOrder.copy(step = 4, completed = true)) }
    private fun fails(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `stage two is quoted only after the first course at home two and does not mint ingredients`() {
        val homeOne = EconomyRules.initial()
        assertNull(EconomyStageOrders.offer(homeOne))
        assertNull(EconomyStageOrders.offer(player().copy(tutorialOrder = homeOne.tutorialOrder)))
        val ready = player()
        val pinned = EconomyStageOrders.pin(ready)
        assertEquals(course.orders.first(), EconomyStageOrders.offer(pinned))
        assertEquals(ready.wallet, pinned.wallet); assertEquals(ready.inventory, pinned.inventory)
        assertEquals(0, pinned.stageOrders.stages.getValue("2").step)
        assertEquals(course.orders.first(), pinned.stageOrders.stages.getValue("2").terms)
        assertTrue(checkNotNull(EconomyStageOrders.offer(player(3))).id.startsWith("stage3_"))
        val legacy = player().copy(tutorialOrder = EconomyTutorialOrder())
        assertEquals(course.orders.first(), EconomyStageOrders.offer(legacy), "The legacy course can opt into stage orders")
    }

    @Test fun `all current orders consume produced goods and caught fish in sequence without repeat rewards`() {
        var state = player()
        var at = now
        val initialCoins = state.wallet.coins
        val selected = mapOf("wood" to "gather_wood", "fiber" to "gather_fiber", "rope" to "make_rope",
            "charcoal" to "make_charcoal", "bricks" to "fire_bricks", "grilled_fish" to "cook_grilled_fish")
        val fishing = checkNotNull(EconomyRules.catalog.fishing)
        val shore = EconomyRules.catalog.explorations.single { it.id == "shore" }
        val seed = (1..100).map { "stage-two-common-$it" }.first { candidate ->
            (0 until shore.rewards.getValue("fish").toInt()).all { index ->
                EconomyFishInventory.itemId(EconomyRules.selectFishingCatch(candidate, "reed_rod", null, "bare_hook", index)) == "fish_common"
            }
        }
        fun finish(action: String, target: String) {
            state = apply(state, action, target, at)
            val job = state.jobs.single()
            at = Instant.parse(job.finishesAt)
            if (job.collection != null) {
                state = apply(state, "start_collection", job.id, at)
                at = Instant.parse(state.jobs.single().collection!!.finishesAt)
            }
            state = apply(state, "claim_job", job.id, at)
        }
        fun obtain(itemId: String, amount: Long) {
            if ((state.inventory[itemId] ?: 0L) >= amount) return
            if (itemId == "fish_common") {
                while ((state.inventory[itemId] ?: 0L) < amount) {
                    state = state.copy(fishingCastSeed = seed)
                    finish("start_fishing", "shore")
                }
            } else if (itemId in setOf("stone", "clay")) {
                while ((state.inventory[itemId] ?: 0L) < amount) finish("start_exploration", "quarry_$itemId")
            } else {
                val recipeId = selected.getValue(itemId)
                val recipe = EconomyRules.catalog.recipes.single { it.id == recipeId }
                while ((state.inventory[itemId] ?: 0L) < amount) {
                    recipe.cost.items.forEach { (input, count) -> obtain(input, count) }
                    finish("start_production", recipeId)
                }
            }
        }
        for ((index, terms) in course.orders.withIndex()) {
            assertEquals(terms, EconomyStageOrders.offer(state))
            for (other in course.orders.filter { it.id != terms.id }) fails("ECONOMY_STAGE_ORDER_UNAVAILABLE") {
                apply(state, "complete_resident_order", other.id, at) }
            terms.items.forEach { (id, amount) -> obtain(id, amount) }
            val before = state
            state = apply(state, "complete_resident_order", terms.id, at)
            assertEquals(before.wallet.coins + terms.coins, state.wallet.coins)
            assertEquals(index + 1, state.stageOrders.stages.getValue("2").step)
            assertEquals(index == course.orders.lastIndex, state.stageOrders.stages.getValue("2").completed)
            fails("ECONOMY_STAGE_ORDER_UNAVAILABLE") { apply(state, "complete_resident_order", terms.id, at) }
        }
        assertEquals(initialCoins + course.orders.sumOf { it.coins }, state.wallet.coins)
        assertEquals(course.orders.size.toLong(), state.residentOrders.completed)
        assertEquals(course.orders.sumOf { it.coins }, state.residentOrders.earnedCoins)
        assertEquals(0L, EconomyRules.storage(state).overflow)
        assertTrue(state.inventory.keys.all { it == "fish_common" })
        assertTrue((state.inventory["fish_common"] ?: 0L) < shore.rewards.getValue("fish"))
        assertTrue(state.fishing.catches.keys.all { id -> fishing.fish.single { it.itemId == id }.rarity == "common" })
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(state))
        assertEquals(state.stageOrders, restored.stageOrders); assertNull(EconomyStageOrders.offer(restored))
    }

    @Test fun `pinned request survives catalog edits serialization and future dates with exact saved payout`() {
        val original = EconomyStageOrders.pin(player())
        val progress = original.stageOrders.stages.getValue("2")
        val savedTerms = progress.terms!!.copy(id = "stage2_retired_rope_order", coins = 123)
        val saved = original.copy(stageOrders = original.stageOrders.copy(stages = mapOf("2" to progress.copy(terms = savedTerms))),
            inventory = savedTerms.items)
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(saved))
        val changed = EconomyRules.catalog.copy(stageOrders = listOf(course.copy(orders = course.orders.map { it.copy(coins = 999) })))
        assertEquals(savedTerms, EconomyStageOrders.offer(restored, changed))
        assertEquals(restored, EconomyStageOrders.pin(restored, changed))
        val completed = apply(restored, "complete_resident_order", savedTerms.id, now.plusSeconds(31 * 86400))
        assertEquals(restored.wallet.coins + 123, completed.wallet.coins)
        assertEquals(course.orders[1], completed.stageOrders.stages.getValue("2").terms)
    }

    @Test fun `resource capacity and replacement errors do not spend or advance stage progress`() {
        val state = EconomyStageOrders.pin(player())
        val terms = course.orders.first()
        fails("ECONOMY_RESOURCES") { apply(state, "complete_resident_order", terms.id) }
        fails("ECONOMY_STAGE_ORDER_UNAVAILABLE") { apply(state, "replace_resident_order", terms.id) }
        val full = state.copy(inventory = terms.items, wallet = EconomyWallet(ECONOMY_MAX_BALANCE - terms.coins + 1))
        val before = economyJson.encodeToString(full)
        fails("ECONOMY_CAPACITY") { apply(full, "complete_resident_order", terms.id) }
        assertEquals(before, economyJson.encodeToString(full))
    }

    @Test fun `home three requires the new course but never reopens completed legacy five-order courses`() {
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "home" }.levels.single { it.level == 3 }
        val state = player().copy(wallet = EconomyWallet(upgrade.cost.coins), inventory = upgrade.cost.items,
            buildings = player().buildings + upgrade.requiredBuildings + ("home" to 2))
        fails("ECONOMY_STAGE_REQUIRED") { apply(state, "start_construction", "home") }
        val complete = EconomyStageOrderState(stages = mapOf("2" to EconomyStageOrderProgress(5, true, course.orders.last())))
        for (allowed in listOf(state.copy(stageOrders = complete), state.copy(tutorialOrder = EconomyTutorialOrder()))) {
            val started = apply(allowed, "start_construction", "home")
            assertEquals(3, started.jobs.single().targetLevel)
            assertEquals(upgrade.cost, started.jobs.single().cost)
        }
        assertFalse("2" in EconomyStageOrders.pin(player(3)).stageOrders.stages, "Existing advanced players get no forced stage-two course")
    }

    @Test fun `merging takes furthest progress independently and never reopens completed stages`() {
        val first = EconomyStageOrderState(stages = mapOf("2" to EconomyStageOrderProgress(1, false, course.orders[1])))
        val later = EconomyStageOrderState(stages = mapOf("2" to EconomyStageOrderProgress(3, false, course.orders[3])))
        val done = EconomyStageOrderState(stages = mapOf("2" to EconomyStageOrderProgress(5, true, course.orders.last())))
        for ((a, b) in listOf(first to later, later to first)) assertEquals(later, EconomyStageOrders.merge(a, b))
        for ((a, b) in listOf(first to done, done to later, done to first)) assertEquals(done, EconomyStageOrders.merge(a, b))
        val next = EconomyStageOrderState(stages = mapOf("3" to EconomyStageOrderProgress(2)))
        assertEquals(done.stages + next.stages, EconomyStageOrders.merge(done, next).stages)
        assertEquals(done, EconomyStageOrders.merge(done, done))
    }

    @Test fun `legacy serialized profiles default all new fields without changing balances or jobs`() {
        val initial = player()
        val raw = economyJson.encodeToJsonElement(initial).jsonObject
        val previous = JsonObject(raw - setOf("stageOrders", "minerRareDropState"))
        val restored = economyJson.decodeFromString<EconomyState>(previous.toString())
        assertEquals(initial.wallet, restored.wallet); assertEquals(initial.inventory, restored.inventory)
        assertEquals(EconomyStageOrderState(), restored.stageOrders); assertNull(restored.minerRareDropState)
    }
}
