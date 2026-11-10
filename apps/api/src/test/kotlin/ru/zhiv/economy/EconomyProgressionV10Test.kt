package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyProgressionV10Test {
    private val now = Instant.parse("2026-10-14T15:30:00Z")
    private fun command(action: String, target: String, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, totalPrice = price)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, command(action, target), at).first

    @Test fun `every house adds a berry with a real garden gate and server timed single item harvest`() {
        val berries = listOf("berries", "blueberries", "currants", "blackberries", "cranberries")
        for ((index, item) in berries.withIndex()) {
            val recipe = EconomyRules.catalog.recipes.single { it.id == "grow_$item" }
            val home = index + 1
            assertEquals(home, recipe.requiredHomeLevel)
            assertEquals(home, recipe.buildingLevel)
            assertEquals(mapOf(item to 1L), recipe.rewards)
            assertEquals(1, recipe.maxBatch)
            assertEquals(EconomyCollectionSpec("berry_harvest", 8), recipe.collection)
            val initial = EconomyRules.initial()
            val state = initial.copy(inventory = emptyMap(), buildings = initial.buildings +
                mapOf("home" to home, "garden" to home))
            if (home > 1) {
                assertEquals("ECONOMY_HOME_REQUIRED", assertFailsWith<AuthFailure> {
                    apply(state.copy(buildings = state.buildings + ("home" to home - 1)), "start_production", recipe.id)
                }.code)
                assertFalse(item in EconomyItemUnlocks.project(state.copy(buildings = state.buildings + ("garden" to home - 1))))
            }
            val grown = apply(state, "start_production", recipe.id)
            val job = grown.jobs.single()
            val ripeAt = Instant.parse(job.finishesAt)
            assertEquals(EconomyRules.catalog.version, job.catalogVersion)
            assertEquals("ECONOMY_COLLECTION_REQUIRED", assertFailsWith<AuthFailure> {
                apply(grown, "claim_job", job.id, ripeAt)
            }.code)
            val collecting = apply(grown, "start_collection", job.id, ripeAt)
            assertEquals("ECONOMY_COLLECTION_NOT_READY", assertFailsWith<AuthFailure> {
                apply(collecting, "claim_job", job.id, ripeAt.plusSeconds(8).minusNanos(1))
            }.code)
            val claimed = apply(collecting, "claim_job", job.id, ripeAt.plusSeconds(8))
            assertEquals(mapOf(item to 1L), claimed.inventory)
            assertTrue(claimed.jobs.isEmpty())
            assertTrue(item in claimed.unlockedItems)
        }
    }

    @Test fun `restoring a bridge opens peers without an arbitrary exploration counter and paid slots give no shortcut`() {
        val initial = EconomyRules.initial()
        val state = initial.copy(buildings = initial.buildings + ("home" to 2), completedExplorations = 100,
            marketSlots = 10, wallet = EconomyWallet(0, 2000))
        assertFalse(EconomyMarketRules.unlocked(state))
        assertFalse(EconomyMarketRules.unlocked(state.copy(buildings = state.buildings - "bridge")))
        assertEquals("ECONOMY_MARKET_LOCKED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, command("buy_market_slot", "market:11", 500), now)
        }.code)
        val bridge = state.copy(buildings = state.buildings + ("bridge" to 1), completedExplorations = 0)
        assertTrue(EconomyMarketRules.unlocked(bridge))
        assertFalse(EconomyBarterRules.unlocked(bridge))
        assertTrue(EconomyBarterRules.unlocked(bridge.copy(buildings = bridge.buildings + ("home" to 3))))
        assertFalse(EconomyBarterRules.unlocked(state.copy(buildings = state.buildings + ("home" to 5))))
        assertFalse(EconomyMarketRules.unlocked(bridge.copy(buildings = bridge.buildings + ("home" to 1))))
    }

    @Test fun `previously pinned twenty four hour deliveries keep deadlines while new courses remove calendar waits`() {
        for (home in listOf(3, 4)) {
            val initial = EconomyRules.initial()
            val course = EconomyRules.catalog.stageOrders.single { it.homeLevel == home }
            assertEquals(0L, course.intervalSeconds)
            val first = course.orders.first()
            val state = initial.copy(buildings = initial.buildings + ("home" to home), inventory = first.items,
                stageOrders = EconomyStageOrderState(stages = mapOf(home.toString() to EconomyStageOrderProgress(
                    terms = first, availableAt = now.toString(), intervalSeconds = 86400,
                    completionRewards = course.completionRewards))))
            val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(state))
            val delivered = apply(restored, "complete_resident_order", first.id)
            val progress = EconomyStageOrders.progress(delivered)
            assertEquals(86400L, progress.intervalSeconds)
            assertEquals(now.plusSeconds(86400).toString(), progress.availableAt)
            assertEquals("ECONOMY_STAGE_WAIT", assertFailsWith<AuthFailure> {
                apply(delivered.copy(inventory = course.orders[1].items), "complete_resident_order",
                    course.orders[1].id, now.plusSeconds(82800))
            }.code)
        }
    }
}
