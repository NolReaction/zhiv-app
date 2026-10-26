package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyThirdStageTest {
    private val now = Instant.parse("2026-10-14T12:00:00Z")
    private val course get() = EconomyRules.catalog.stageOrders.single { it.homeLevel == 3 }
    private fun command(action: String, target: String, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, totalPrice = price)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, command(action, target), at).first
    private fun player(home: Int = 3) = EconomyRules.initial().let { state -> state.copy(wallet = EconomyWallet(100_000, 50_000),
        inventory = emptyMap(), buildings = state.buildings + mapOf("home" to home, "woodlot" to 2, "workshop" to 2,
            "quarry" to 2, "kiln" to 2, "dryer" to 1), tutorialOrder = EconomyTutorialOrder()) }
    private fun fails(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `eight third stage requests need resources without calendar gaps and deliver one final saved resin reward`() {
        assertEquals(8, course.orders.size); assertEquals(0L, course.intervalSeconds)
        assertEquals(mapOf("living_resin" to 1L), course.completionRewards)
        var state = player()
        var at = now
        val coins = state.wallet.coins
        for ((index, terms) in course.orders.withIndex()) {
            assertEquals(terms, EconomyStageOrders.offer(state))
            state = state.copy(inventory = terms.items)
            if (index > 0) {
                val progress = EconomyStageOrders.progress(state)
                assertEquals(at.toString(), progress.availableAt)
                val original = economyJson.encodeToString(state)
                fails("ECONOMY_STAGE_WAIT") { apply(state, "complete_resident_order", terms.id, at.minusNanos(1)) }
                assertEquals(original, economyJson.encodeToString(state), "No goods, coins or progress are spent while waiting")
            }
            state = apply(state, "complete_resident_order", terms.id, at)
            assertEquals(index + 1, EconomyStageOrders.progress(state).step)
            assertEquals(if (index == 7) 1L else 0L, state.inventory["living_resin"] ?: 0L)
            if (index < 7) at = at.plusSeconds(course.intervalSeconds)
        }
        assertEquals(now.plusSeconds(7 * course.intervalSeconds), at)
        assertTrue(EconomyStageOrders.progress(state).completed)
        assertNull(EconomyStageOrders.offer(state))
        assertEquals(coins + course.orders.sumOf { it.coins }, state.wallet.coins)
        assertEquals(mapOf("living_resin" to 1L), state.inventory)
        assertTrue("living_resin" in state.unlockedItems)
        fails("ECONOMY_STAGE_ORDER_UNAVAILABLE") { apply(state, "complete_resident_order", course.orders.last().id, at) }
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(state))
        assertEquals(state.stageOrders, restored.stageOrders)
    }

    @Test fun `cadence and completion rewards remain frozen across catalog changes and late deliveries`() {
        val pinned = EconomyStageOrders.pin(player(), now = now)
        val changed = EconomyRules.catalog.copy(stageOrders = EconomyRules.catalog.stageOrders.map {
            if (it.homeLevel == 3) it.copy(intervalSeconds = 1, completionRewards = mapOf("living_resin" to 99L)) else it })
        assertEquals(pinned, EconomyStageOrders.pin(pinned, changed, now.plusSeconds(100)))
        val first = course.orders.first()
        val late = now.plusSeconds(3 * 86400L)
        val completed = apply(pinned.copy(inventory = first.items), "complete_resident_order", first.id, late)
        val progress = EconomyStageOrders.progress(completed)
        assertEquals(late.plusSeconds(course.intervalSeconds).toString(), progress.availableAt)
        assertEquals(course.intervalSeconds, progress.intervalSeconds)
        assertEquals(mapOf("living_resin" to 1L), progress.completionRewards)
        fails("INVALID_ECONOMY_COMMAND") {
            EconomyRules.apply(completed, command("complete_resident_order", course.orders[1].id, 100), late) }
    }

    @Test fun `final reward and storage failure are atomic with goods payout and course completion`() {
        val last = course.orders.last()
        val pinned = EconomyStageOrders.pin(player(), now = now)
        val progress = EconomyStageOrders.progress(pinned).copy(step = 7, terms = last,
            completionRewards = mapOf("living_resin" to last.items.values.sum() + 1))
        val state = pinned.copy(inventory = last.items + ("wood" to (50L - (last.items - "wood").values.sum())),
            stageOrders = pinned.stageOrders.copy(stages = mapOf("3" to progress)))
        assertEquals(50L, EconomyRules.storage(state).used)
        val original = economyJson.encodeToString(state)
        fails("ECONOMY_STORAGE_FULL") { apply(state, "complete_resident_order", last.id) }
        assertEquals(original, economyJson.encodeToString(state))
    }

    @Test fun `home four course applies to legacy accounts while completed second courses and paid houses stay valid`() {
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "home" }.levels.single { it.level == 4 }
        val state = player().copy(wallet = EconomyWallet(upgrade.cost.coins), inventory = upgrade.cost.items,
            buildings = player().buildings + upgrade.requiredBuildings)
        fails("ECONOMY_STAGE_REQUIRED") { apply(state, "start_construction", "home") }
        val done = state.copy(stageOrders = EconomyStageOrderState(stages = mapOf("3" to EconomyStageOrderProgress(8, true))))
        assertEquals(4, apply(done, "start_construction", "home").jobs.single().targetLevel)
        val previous = player(2).copy(tutorialOrder = EconomyTutorialOrder(version = 2, step = 4, completed = true),
            stageOrders = EconomyStageOrderState(stages = mapOf("2" to EconomyStageOrderProgress(5, true))))
        assertNull(EconomyStageOrders.offer(previous)); assertFalse(EconomyStageOrders.required(previous, 3))
        assertNull(EconomyStageOrders.offer(player(5)))
        val paid = EconomyJob(UUID.randomUUID().toString(), "construction", "home", targetLevel = 4,
            startedAt = now.minusSeconds(100).toString(), finishesAt = now.toString(), catalogVersion = 7)
        assertEquals(4, apply(state.copy(jobs = listOf(paid)), "claim_job", paid.id).buildings["home"])
    }

    @Test fun `merging equal course steps cannot shorten the persisted deadline`() {
        val early = EconomyStageOrderProgress(2, terms = course.orders[2], availableAt = now.plusSeconds(100).toString(),
            intervalSeconds = 86400, completionRewards = mapOf("living_resin" to 1L))
        val late = early.copy(availableAt = now.plusSeconds(500).toString())
        for ((a, b) in listOf(early to late, late to early)) {
            val merged = EconomyStageOrders.merge(EconomyStageOrderState(stages = mapOf("3" to a)),
                EconomyStageOrderState(stages = mapOf("3" to b)))
            assertEquals(late.availableAt, merged.stages.getValue("3").availableAt)
        }
    }

    @Test fun `soup waits for a claimed grilled recipe then uses one first level fire slot and sells for one hundred seventy`() {
        val state = player().copy(inventory = mapOf("fish_common" to 3L, "berries" to 1L, "charcoal" to 1L))
        fails("ECONOMY_RECIPE_REQUIRED") { apply(state, "start_production", "cook_fish_soup") }
        val cooking = apply(state, "start_production", "cook_grilled_fish")
        val grilled = cooking.jobs.single()
        fails("ECONOMY_RECIPE_REQUIRED") { apply(cooking, "start_production", "cook_fish_soup", Instant.parse(grilled.finishesAt)) }
        val claimed = apply(cooking, "claim_job", grilled.id, Instant.parse(grilled.finishesAt))
        val soup = apply(claimed, "start_production", "cook_fish_soup", Instant.parse(grilled.finishesAt))
        val job = soup.jobs.single()
        assertEquals(mapOf("fish_common" to 2L, "berries" to 1L, "charcoal" to 1L), job.cost.items)
        assertEquals(mapOf("fish_soup" to 1L), job.rewards)
        assertEquals(480L, Instant.parse(job.finishesAt).epochSecond - Instant.parse(job.startedAt).epochSecond)
        assertEquals(1, soup.buildings["dryer"]); assertEquals(1, soup.buildings["warehouse"])
        val served = apply(soup, "claim_job", job.id, Instant.parse(job.finishesAt))
        assertTrue("fish_soup" in served.unlockedItems)
        val sold = apply(served, "sell", "fish_soup", Instant.parse(job.finishesAt))
        assertEquals(served.wallet.coins + 170, sold.wallet.coins)
        val bonus = EconomyRules.catalog.food!!.meals.single { it.itemId == "fish_soup" }
        assertEquals(2500, bonus.heroSpeedBps); assertEquals(2500, bonus.builderSpeedBps)
    }
}
