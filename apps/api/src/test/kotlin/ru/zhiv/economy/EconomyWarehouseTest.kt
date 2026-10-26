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
    private val capacities = (1L..10L).map { it * 50L }
    private val relicIds = listOf("ancient_core", "moon_crystal", "living_resin")
    private val relicCosts = listOf(listOf(1L, 0L, 0L), listOf(0L, 1L, 0L), listOf(0L, 0L, 1L),
        listOf(1L, 1L, 0L), listOf(1L, 0L, 1L), listOf(1L, 1L, 0L), listOf(2L, 0L, 1L))
    private fun initial(level: Int) = EconomyRules.initial().let { it.copy(buildings = it.buildings + mapOf("home" to 2, "warehouse" to level)) }
    private fun developed(level: Int) = initial(level).copy(buildings = EconomyRules.catalog.buildings.associate {
        it.id to it.levels.last().level } + ("warehouse" to level))
    private fun command(action: String, target: String, totalPrice: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, totalPrice = totalPrice)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, totalPrice: Long = 0) =
        EconomyRules.apply(state, command(action, target, totalPrice), at).first

    @Test fun `ten storage tiers add fifty places with modest crafted and relic expansion goals`() {
        assertEquals((1..10).toList(), warehouse.levels.map { it.level })
        assertEquals(capacities, warehouse.levels.map { it.warehouseCapacity })
        val third = warehouse.levels[2]
        assertEquals(EconomyCost(1500, mapOf("planks" to 6L, "bricks" to 6L, "iron_ingot" to 2L, "cloth" to 2L)), third.cost)
        warehouse.levels.forEach { target ->
            assertEquals(if (target.level <= 3) target.level else if (target.level <= 6) 4 else 5, target.requiredHomeLevel)
            if (target.level <= 3) assertTrue(target.requiredBuildings.isEmpty())
        }
        warehouse.levels.take(3).forEach { target -> assertTrue(relicIds.none { it in target.cost.items }) }
        warehouse.levels.drop(3).forEachIndexed { index, target ->
            assertTrue(target.cost.coins > warehouse.levels[index + 2].cost.coins)
            assertEquals(relicCosts[index], relicIds.map { target.cost.items[it] ?: 0L })
            assertEquals(3, target.cost.items.keys.count { it !in relicIds })
            assertTrue(target.requiredBuildings.isNotEmpty())
            assertEquals(listOf(2L, 4L, 4L, 4L, 4L, 4L, 4L)[index] * 3600L, target.seconds)
        }
    }

    @Test fun `ordinary warehouse upgrades follow house tiers without requiring a built workshop`() {
        val targets = warehouse.levels.filter { it.level in 2..3 }
        val supplies = buildMap<String, Long> {
            targets.forEach { target -> target.cost.items.forEach { (id, amount) -> put(id, (get(id) ?: 0L) + amount) } }
            put("wood", 2L)
        }
        val base = initial(1)
        var state = base.copy(buildings = base.buildings + ("home" to 3),
            wallet = EconomyWallet(targets.sumOf { it.cost.coins }, 77), inventory = supplies)
        val originalBuildings = state.buildings
        assertEquals(3, state.buildings["home"]); assertEquals(0, state.buildings["workshop"])
        assertEquals((supplies.values.sum() - capacities.first()).coerceAtLeast(0), EconomyRules.storage(state).overflow)
        var at = now
        for (target in targets) {
            val before = state
            val belowGate = before.copy(buildings = before.buildings + ("home" to target.requiredHomeLevel - 1))
            assertEquals("ECONOMY_HOME_REQUIRED", assertFailsWith<AuthFailure> {
                apply(belowGate, "start_construction", "warehouse", at)
            }.code)
            state = apply(state, "start_construction", "warehouse", at)
            val job = state.jobs.single()
            assertEquals(target.level, job.targetLevel); assertEquals(target.cost, job.cost)
            assertEquals(before.wallet.coins - target.cost.coins, state.wallet.coins)
            assertEquals(77L, state.wallet.pearls)
            for ((id, amount) in target.cost.items) assertEquals(before.inventory.getValue(id) - amount, state.inventory[id] ?: 0L)
            assertEquals(originalBuildings + ("warehouse" to (target.level - 1)), state.buildings)
            assertEquals(capacities[target.level - 2], EconomyRules.storage(state).capacity)
            val paid = state
            val end = Instant.parse(job.finishesAt)
            assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { apply(state, "claim_job", job.id, end.minusMillis(1)) }.code)
            at = end
            state = apply(state, "claim_job", job.id, at)
            assertEquals(originalBuildings + ("warehouse" to target.level), state.buildings)
            assertEquals(capacities[target.level - 1], EconomyRules.storage(state).capacity)
            assertEquals(paid.inventory, state.inventory); assertEquals(paid.wallet, state.wallet)
            assertTrue(state.jobs.isEmpty())
        }
        assertEquals(EconomyWallet(0, 77), state.wallet)
        assertEquals(mapOf("wood" to 2L), state.inventory)
    }

    @Test fun `developed settlement pays each crafted and relic basket once through warehouse ten`() {
        val supplies = mutableMapOf("wood" to 2L)
        warehouse.levels.drop(3).forEach { target -> target.cost.items.forEach { (id, count) -> supplies[id] = (supplies[id] ?: 0L) + count } }
        var state = developed(3).copy(wallet = EconomyWallet(321 + warehouse.levels.drop(3).sumOf { it.cost.coins }, 500), inventory = supplies)
        val buildings = state.buildings
        var at = now
        for (target in warehouse.levels.drop(3)) {
            val before = state
            state = apply(state, "start_construction", "warehouse", at)
            val job = state.jobs.single()
            assertEquals(target.level, job.targetLevel); assertEquals(target.cost, job.cost)
            assertEquals(before.wallet.coins - target.cost.coins, state.wallet.coins)
            target.cost.items.forEach { (id, amount) -> assertEquals(before.inventory.getValue(id) - amount, state.inventory[id] ?: 0L) }
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
            assertEquals(EconomyWallet(before.wallet.coins - target.cost.coins, 500), state.wallet); assertTrue(state.jobs.isEmpty())
            assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(state, "claim_job", job.id, at) }.code)
        }
        assertEquals(mapOf("wood" to 2L), state.inventory)
        assertEquals(EconomyWallet(321, 500), state.wallet)
        assertEquals(buildings + ("warehouse" to 10), state.buildings)
        val before = economyJson.encodeToString(state)
        assertEquals("ECONOMY_MAX_LEVEL", assertFailsWith<AuthFailure> { apply(state, "start_construction", "warehouse", at) }.code)
        assertEquals(before, economyJson.encodeToString(state))
    }

    @Test fun `any missing crafted input or relic denies every advanced upgrade without consuming balances jobs or rare progress`() {
        for (target in warehouse.levels.drop(3)) for (id in target.cost.items.keys) {
            val state = developed(target.level - 1).copy(wallet = EconomyWallet(target.cost.coins), inventory = target.cost.items + (id to target.cost.items.getValue(id) - 1),
                rareDropState = EconomyRareDropClock(1, 1800, "living_resin"))
            val before = economyJson.encodeToString(state)
            assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { apply(state, "start_construction", "warehouse") }.code)
            assertEquals(before, economyJson.encodeToString(state))
        }
    }

    @Test fun `house and source gates reject new storage orders atomically even with all materials`() {
        for (target in warehouse.levels.drop(3)) {
            val gates = listOf(Triple("home", target.requiredHomeLevel, "ECONOMY_HOME_REQUIRED")) +
                target.requiredBuildings.map { (id, level) -> Triple(id, level, "ECONOMY_BUILDING_REQUIRED") }
            for ((id, level, code) in gates) {
                val ready = developed(target.level - 1)
                val state = ready.copy(wallet = EconomyWallet(target.cost.coins), inventory = target.cost.items, buildings = ready.buildings + (id to level - 1))
                val before = economyJson.encodeToString(state)
                assertEquals(code, assertFailsWith<AuthFailure> { apply(state, "start_construction", "warehouse") }.code)
                assertEquals(before, economyJson.encodeToString(state))
            }
        }
    }

    @Test fun `saved paid storage jobs including old v14 maximum survive JSON and finish without a new charge`() {
        val originalCosts = mapOf(
            4 to EconomyCost(70000, mapOf("beams" to 60L, "cut_stone" to 70L, "glass" to 25L, "tools" to 15L, "ancient_core" to 1L)),
            5 to EconomyCost(220000, mapOf("beams" to 100L, "cut_stone" to 140L, "reinforced_parts" to 35L,
                "glass" to 60L, "cloth" to 45L, "moon_crystal" to 1L)),
            10 to EconomyCost(0, mapOf("ancient_core" to 10L, "moon_crystal" to 3L, "living_resin" to 3L)),
        )
        for ((level, cost) in originalCosts) {
            val job = EconomyJob(UUID.randomUUID().toString(), "construction", "warehouse", targetLevel = level,
                startedAt = now.toString(), finishesAt = now.plusSeconds((level - 2) * 86400L).toString(),
                cost = cost, catalogVersion = if (level == 10) 14 else 3)
            val saved = initial(level - 1).copy(wallet = EconomyWallet(321, 500), inventory = mapOf("wood" to 5L), jobs = listOf(job))
            val state = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(saved))
            assertEquals(cost, state.jobs.single().cost)
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
        val state = developed(9).copy(wallet = EconomyWallet(target.cost.coins + 321, 500000), inventory = target.cost.items)
        val started = apply(state, "start_construction", "warehouse")
        val job = started.jobs.single()
        assertTrue(started.inventory.isEmpty())
        val price = EconomyRules.constructionSpeedupPrice(job, now)
        val finished = apply(started, "speedup_construction", job.id, totalPrice = price)
        assertEquals(10, finished.buildings["warehouse"]); assertEquals(500L, EconomyRules.storage(finished).capacity)
        assertTrue(finished.jobs.isEmpty()); assertTrue(finished.inventory.isEmpty())
        assertEquals(321L, started.wallet.coins); assertEquals(started.wallet.coins, finished.wallet.coins)
        assertEquals(state.wallet.pearls - price, finished.wallet.pearls)
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
        assertEquals(500L, EconomyRules.storage(maximum).capacity)
    }
}
