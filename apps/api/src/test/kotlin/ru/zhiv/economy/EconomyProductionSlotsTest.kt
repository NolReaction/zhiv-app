package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyProductionSlotsTest {
    private val now = Instant.parse("2026-10-06T00:00:00Z")
    private fun fixture(home: Int = 4, pearls: Long = 50_000) = EconomyRules.initial().copy(
        wallet = EconomyWallet(100_000, pearls), inventory = mapOf("wood" to 50L, "fiber" to 40L, "stone" to 20L),
        buildings = mapOf("home" to home, "garden" to 1, "woodlot" to 1, "workshop" to 1, "kiln" to 1, "dryer" to 1, "warehouse" to 5, "quarry" to 1))
    private fun command(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, command(action, target).copy(totalPrice =
            if (action == "buy_production_slot") EconomyRules.productionSlotOffer(state, target)?.pricePearls ?: 0L else 0L), at).first
    private fun failure(code: String, block: () -> Unit) { assertEquals(code, assertFailsWith<AuthFailure>(block = block).code) }

    @Test fun `old persisted profiles have one slot and serialization preserves paid capacity`() {
        val old = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(fixture())).jsonObject - "productionSlots")
        val restored = economyJson.decodeFromJsonElement<EconomyState>(old)
        assertTrue(restored.productionSlots.isEmpty())
        assertEquals(1, EconomyRules.productionSlotCount(restored, "workshop"))
        assertEquals(setOf("dryer", "garden", "kiln", "woodlot", "workshop"), EconomyRules.catalog.buildings
            .filter { EconomyRules.productionStationSupported(it.id) }.map { it.id }.toSet())
        val paid = apply(restored, "buy_production_slot", "workshop")
        assertEquals(paid, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(paid)))
        assertEquals(3, EconomyRules.productionSlotCount(paid.copy(productionSlots = mapOf("workshop" to 999)), "workshop"))
    }

    @Test fun `second slot opens at house one but third requires completed house three`() {
        val second = apply(fixture(home = 1), "buy_production_slot", "workshop")
        assertEquals(mapOf("workshop" to 2), second.productionSlots)
        assertEquals(EconomyWallet(100_000, 49_800), second.wallet)
        assertEquals(fixture().inventory, second.inventory)
        for (home in 1..2) {
            val locked = second.copy(buildings = second.buildings + ("home" to home))
            failure("ECONOMY_HOME_REQUIRED") { apply(locked, "buy_production_slot", "workshop") }
            assertEquals(EconomyWallet(100_000, 49_800), locked.wallet)
            assertEquals(2, locked.productionSlots["workshop"])
        }
        val third = apply(second.copy(buildings = second.buildings + ("home" to 3)), "buy_production_slot", "workshop")
        assertEquals(3, third.buildings["home"])
        assertEquals(3, third.productionSlots["workshop"])
        assertEquals(49_300L, third.wallet.pearls)
        assertEquals(1, EconomyRules.productionSlotCount(third, "kiln"))
        failure("ECONOMY_PRODUCTION_SLOTS_MAX") { apply(third, "buy_production_slot", "workshop") }
        assertNull(EconomyRules.productionSlotOffer(third, "workshop"))
        failure("ECONOMY_PEARLS") { apply(fixture(pearls = 199), "buy_production_slot", "workshop") }
        failure("ECONOMY_BUILDING_REQUIRED") { apply(fixture().copy(buildings = mapOf("home" to 4)), "buy_production_slot", "workshop") }
        for (station in listOf("home", "quarry", "warehouse", "unknown")) {
            failure("ECONOMY_PRODUCTION_STATION") { apply(fixture(), "buy_production_slot", station) }
            assertNull(EconomyRules.productionSlotOffer(fixture(), station))
        }
        for (forged in listOf(command("buy_production_slot", "workshop").copy(quantity = 2),
            // Public IDs exclude ambiguous L; malformed owners must fail before slot rules.
            command("buy_production_slot", "workshop").copy(ownerPublicId = "ABCD-EFGH-JKLM"))) {
            failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(fixture(), forged, now) }
        }
    }

    @Test fun `slot purchases require the exact confirmed price for the current tier`() {
        val state = fixture()
        for (price in listOf(0L, 1L, 199L, 201L, 500L)) {
            failure("ECONOMY_PRODUCTION_SLOT_PRICE_CHANGED") {
                EconomyRules.apply(state, command("buy_production_slot", "workshop").copy(totalPrice = price), now)
            }
            assertEquals(50_000L, state.wallet.pearls)
            assertTrue(state.productionSlots.isEmpty())
        }
        val second = apply(state, "buy_production_slot", "workshop")
        failure("ECONOMY_PRODUCTION_SLOT_PRICE_CHANGED") {
            EconomyRules.apply(second, command("buy_production_slot", "workshop").copy(totalPrice = 200), now)
        }
        assertEquals(49_800L, second.wallet.pearls)
        assertEquals(2, second.productionSlots["workshop"])
        assertEquals(49_300L, apply(second, "buy_production_slot", "workshop").wallet.pearls)
    }

    @Test fun `existing third slots stay usable below their new purchase gate`() {
        var state = fixture(home = 1).copy(productionSlots = mapOf("workshop" to 3))
        repeat(3) { state = apply(state, "start_production", "make_planks") }
        assertEquals(3, state.productionSlots["workshop"])
        assertEquals(3, state.jobs.size)
        assertEquals(50_000L, state.wallet.pearls)
        assertNull(EconomyRules.productionSlotOffer(state, "workshop"))
    }

    @Test fun `concurrent recipes retain their slots until claimed and their recipe economics stay intact`() {
        var state = apply(apply(fixture(), "buy_production_slot", "workshop"), "buy_production_slot", "workshop")
        for (recipeId in listOf("make_planks", "make_rope", "make_planks")) {
            state = apply(state, "start_production", recipeId)
            val job = state.jobs.last(); val recipe = EconomyRules.catalog.recipes.single { it.id == recipeId }
            assertEquals(recipe.cost, job.cost); assertEquals(recipe.rewards, job.rewards)
            assertEquals(now.plusSeconds(recipe.seconds).toString(), job.finishesAt)
        }
        assertEquals(3, state.jobs.size)
        assertEquals(3, state.jobs.map { it.id }.distinct().size)
        val ready = state.jobs.maxOf { Instant.parse(it.finishesAt) }
        failure("ECONOMY_BUILDING_BUSY") { apply(state, "start_production", "make_rope", ready) }
        failure("ECONOMY_STORAGE_FULL") { apply(state.copy(inventory = mapOf("wood" to EconomyRules.storage(state).capacity)), "claim_job", state.jobs[0].id, ready) }
        state = apply(state, "claim_job", state.jobs[0].id, ready)
        assertEquals(3, apply(state, "start_production", "make_rope", ready).jobs.size)
    }

    @Test fun `construction still blocks every production slot and slot purchases`() {
        var state = apply(fixture(), "buy_production_slot", "workshop")
        state = state.copy(buildings = state.buildings + mapOf("woodlot" to 2, "kiln" to 2))
        state = apply(state, "start_production", "make_planks")
        failure("ECONOMY_BUILDING_BUSY") { apply(state, "start_construction", "workshop") }
        state = state.copy(jobs = listOf(state.jobs.single().copy(kind = "construction", recipeId = null, targetLevel = 2, rewards = emptyMap())))
        failure("ECONOMY_BUILDING_BUSY") { apply(state, "start_production", "make_rope") }
        failure("ECONOMY_BUILDING_BUSY") { apply(state, "buy_production_slot", "workshop") }
    }

    @Test fun `multiple crops share one collector and do not create extra mining actors`() {
        var state = apply(fixture(), "buy_production_slot", "garden")
        repeat(2) { state = apply(state, "start_production", "grow_berries") }
        val ripe = state.jobs.maxOf { Instant.parse(it.finishesAt) }
        state = apply(state, "start_collection", state.jobs[0].id, ripe)
        failure("ECONOMY_COLLECTOR_BUSY") { apply(state, "start_collection", state.jobs[1].id, ripe) }
        assertEquals("miner", apply(state, "start_exploration", "quarry_stone", ripe).jobs.last().actorId)
        val done = Instant.parse(state.jobs[0].collection!!.finishesAt)
        state = apply(state, "claim_job", state.jobs[0].id, done)
        assertNotNull(apply(state, "start_collection", state.jobs.single().id, done).jobs.single().collection?.startedAt)
    }
}
