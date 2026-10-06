package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyWarehouseTest {
    private val now = Instant.parse("2026-10-06T23:00:00Z")
    private val warehouse = EconomyRules.catalog.buildings.single { it.id == "warehouse" }
    private val capacities = listOf(200L, 500L, 1000L, 1800L, 3000L, 4000L, 5200L, 6600L, 8200L, 10000L)
    private val relicIds = listOf("ancient_core", "moon_crystal", "living_resin")
    private val relicCosts = listOf(listOf(2L, 1L, 1L), listOf(3L, 1L, 1L), listOf(4L, 1L, 1L),
        listOf(5L, 2L, 2L), listOf(6L, 2L, 2L), listOf(8L, 2L, 2L), listOf(10L, 3L, 3L))
    private fun initial(level: Int) = EconomyRules.initial().let { it.copy(buildings = it.buildings + ("warehouse" to level)) }
    private fun command(action: String, target: String, totalPrice: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, totalPrice = totalPrice)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, totalPrice: Long = 0) =
        EconomyRules.apply(state, command(action, target, totalPrice), at).first

    @Test fun `ten storage tiers keep existing capacities and add escalating relic sets after level three`() {
        assertEquals((1..10).toList(), warehouse.levels.map { it.level })
        assertEquals(capacities, warehouse.levels.map { it.warehouseCapacity })
        val third = warehouse.levels[2]
        assertEquals(EconomyCost(16000, mapOf("planks" to 50L, "bricks" to 45L, "iron_ingot" to 12L, "cloth" to 10L)), third.cost)
        assertEquals(3, third.requiredHomeLevel); assertEquals(mapOf("workshop" to 2), third.requiredBuildings)
        warehouse.levels.take(3).forEach { target -> assertTrue(relicIds.none { it in target.cost.items }) }
        warehouse.levels.drop(3).forEachIndexed { index, target ->
            assertEquals(EconomyCost(items = relicIds.zip(relicCosts[index]).toMap()), target.cost)
            assertEquals(1, target.requiredHomeLevel); assertTrue(target.requiredBuildings.isEmpty())
            assertEquals((index + 2) * 86400L, target.seconds)
        }
    }

    @Test fun `small settlement expands from warehouse three to ten with no other building or currency changes`() {
        var state = initial(3).copy(wallet = EconomyWallet(321, 500),
            inventory = mapOf("wood" to 2L, "ancient_core" to 38L, "moon_crystal" to 12L, "living_resin" to 12L))
        val buildings = state.buildings
        var at = now
        for (target in warehouse.levels.drop(3)) {
            val before = state
            state = apply(state, "start_construction", "warehouse", at)
            val job = state.jobs.single()
            assertEquals(target.level, job.targetLevel); assertEquals(target.cost, job.cost)
            relicIds.forEach { id -> assertEquals(before.inventory.getValue(id) - target.cost.items.getValue(id), state.inventory[id] ?: 0L) }
            assertEquals(target.level - 1, state.buildings["warehouse"])
            assertEquals(capacities[target.level - 2], EconomyRules.storage(state).capacity)
            assertEquals("ECONOMY_CONSTRUCTION_BUSY", assertFailsWith<AuthFailure> {
                apply(state, "start_construction", "warehouse", at)
            }.code)
            val end = Instant.parse(job.finishesAt)
            assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { apply(state, "claim_job", job.id, end.minusMillis(1)) }.code)
            at = end
            state = apply(state, "claim_job", job.id, at)
            assertEquals(target.level, state.buildings["warehouse"])
            assertEquals(capacities[target.level - 1], EconomyRules.storage(state).capacity)
            assertEquals(EconomyWallet(321, 500), state.wallet); assertTrue(state.jobs.isEmpty())
            assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(state, "claim_job", job.id, at) }.code)
        }
        assertEquals(mapOf("wood" to 2L), state.inventory)
        assertEquals(buildings + ("warehouse" to 10), state.buildings)
        val before = economyJson.encodeToString(state)
        assertEquals("ECONOMY_MAX_LEVEL", assertFailsWith<AuthFailure> { apply(state, "start_construction", "warehouse", at) }.code)
        assertEquals(before, economyJson.encodeToString(state))
    }

    @Test fun `any missing relic denies every advanced upgrade without consuming balances jobs or rare progress`() {
        for (target in warehouse.levels.drop(3)) for (id in relicIds) {
            val state = initial(target.level - 1).copy(inventory = target.cost.items + (id to target.cost.items.getValue(id) - 1),
                rareDropState = EconomyRareDropClock(1, 1800, "living_resin"))
            val before = economyJson.encodeToString(state)
            assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { apply(state, "start_construction", "warehouse") }.code)
            assertEquals(before, economyJson.encodeToString(state))
        }
    }

    @Test fun `saved paid fourth and fifth storage jobs survive JSON and finish without a new charge`() {
        val originalCosts = listOf(
            EconomyCost(70000, mapOf("beams" to 60L, "cut_stone" to 70L, "glass" to 25L, "tools" to 15L, "ancient_core" to 1L)),
            EconomyCost(220000, mapOf("beams" to 100L, "cut_stone" to 140L, "reinforced_parts" to 35L,
                "glass" to 60L, "cloth" to 45L, "moon_crystal" to 1L)),
        )
        for (level in listOf(4, 5)) {
            val job = EconomyJob(UUID.randomUUID().toString(), "construction", "warehouse", targetLevel = level,
                startedAt = now.toString(), finishesAt = now.plusSeconds((level - 2) * 86400L).toString(),
                cost = originalCosts[level - 4], catalogVersion = 3)
            val saved = initial(level - 1).copy(wallet = EconomyWallet(321, 500), inventory = mapOf("wood" to 5L), jobs = listOf(job))
            val state = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(saved))
            assertEquals(originalCosts[level - 4], state.jobs.single().cost)
            assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { apply(state, "claim_job", job.id) }.code)
            assertEquals(saved, state)
            val claimed = apply(state, "claim_job", job.id, Instant.parse(job.finishesAt))
            assertEquals(level, claimed.buildings["warehouse"]); assertEquals(capacities[level - 1], EconomyRules.storage(claimed).capacity)
            assertEquals(state.wallet, claimed.wallet); assertEquals(state.inventory, claimed.inventory); assertTrue(claimed.jobs.isEmpty())
            assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(claimed, "claim_job", job.id, Instant.parse(job.finishesAt)) }.code)
        }
    }

    @Test fun `all storage tiers keep relics and escrow in occupied capacity and preserve shrinking overflow`() {
        for (target in warehouse.levels) {
            val capacity = checkNotNull(target.warehouseCapacity)
            val state = initial(target.level).copy(inventory = mapOf("wood" to capacity - 2, "ancient_core" to 1L))
            val reserved = mapOf("moon_crystal" to 1L)
            assertEquals(EconomyStorage(capacity, capacity - 1, 1, 0, 0), EconomyRules.storage(state, reserved))
            assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
                EconomyRules.assertStorageTransition(state, state.copy(inventory = state.inventory + ("living_resin" to 1L)), reserved)
            }.code)
            val overfull = state.copy(inventory = state.inventory + ("wood" to capacity + 3))
            assertEquals(5L, EconomyRules.storage(overfull, reserved).overflow)
            EconomyRules.assertStorageTransition(overfull, overfull.copy(inventory = overfull.inventory + ("wood" to capacity + 2)), reserved)
            assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
                EconomyRules.assertStorageTransition(overfull, overfull.copy(inventory = overfull.inventory + ("living_resin" to 1L)), reserved)
            }.code)
        }
    }

    @Test fun `speedup can finish warehouse ten but never recharges its paid relic cost`() {
        val target = warehouse.levels.last()
        val state = initial(9).copy(wallet = EconomyWallet(321, 500000), inventory = target.cost.items)
        val started = apply(state, "start_construction", "warehouse")
        val job = started.jobs.single()
        assertTrue(started.inventory.isEmpty())
        val price = EconomyRules.constructionSpeedupPrice(job, now)
        val finished = apply(started, "speedup_construction", job.id, totalPrice = price)
        assertEquals(10, finished.buildings["warehouse"]); assertEquals(10000L, EconomyRules.storage(finished).capacity)
        assertTrue(finished.jobs.isEmpty()); assertTrue(finished.inventory.isEmpty())
        assertEquals(state.wallet.coins, finished.wallet.coins); assertEquals(state.wallet.pearls - price, finished.wallet.pearls)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            apply(finished, "speedup_construction", job.id, totalPrice = price)
        }.code)
    }

    @Test fun `quantity cannot skip storage levels and maximum state survives serialization`() {
        val state = initial(3).copy(inventory = warehouse.levels[3].cost.items)
        val before = economyJson.encodeToString(state)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, command("start_construction", "warehouse").copy(quantity = 10), now)
        }.code)
        assertEquals(before, economyJson.encodeToString(state))
        val maximum = initial(10)
        assertEquals(maximum, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(maximum)))
        assertEquals(10000L, EconomyRules.storage(maximum).capacity)
    }
}
