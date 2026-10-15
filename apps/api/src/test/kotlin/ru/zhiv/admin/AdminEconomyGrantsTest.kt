package ru.zhiv.admin

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class AdminEconomyGrantsTest {
    private val now = Instant.parse("2026-10-12T12:00:00Z")
    private val empty = EconomyRules.initial(includeStartingPack = false)
    private val secondHouseBuildings = linkedMapOf("home" to 2, "woodlot" to 1, "dryer" to 1, "workshop" to 1)
    private fun request() = AdminEconomyGrantRequest(UUID.randomUUID().toString(), "0123-4567-89AB", "Компенсация за сбой игры")
    private fun apply(state: EconomyState = empty, request: AdminEconomyGrantRequest, reserved: Map<String, Long> = emptyMap()) =
        AdminEconomyGrants.apply(state, request, now, reserved)

    @Test fun `one package adds visible currency materials upgrades slots and gear without equipping them`() {
        val next = apply(request = request().copy(coins = 150, pearls = 7, items = mapOf("wood" to 9L),
            buildings = linkedMapOf("garden" to 2) + secondHouseBuildings,
            productionSlots = mapOf("garden" to 2), rods = listOf("willow_rod"), hooks = listOf("silver_hook")))
        assertEquals(EconomyWallet(150, 14), next.wallet)
        assertEquals(9L, next.inventory["wood"])
        assertEquals(2, next.buildings["home"])
        assertEquals(2, next.productionSlots["garden"])
        assertContains(next.fishing.ownedRods, "willow_rod")
        assertContains(next.fishing.ownedHooks, "silver_hook")
        assertEquals(empty.fishing.equippedRodId, next.fishing.equippedRodId)
        assertEquals(empty.fishing.equippedHookId, next.fishing.equippedHookId)
        assertEquals(empty.progression, next.progression)
    }

    @Test fun `storage counts live escrow and permits an atomic warehouse expansion`() {
        val full = empty.copy(inventory = mapOf("wood" to 40L), buildings = empty.buildings + secondHouseBuildings)
        val grant = request().copy(items = mapOf("stone" to 5L))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            apply(full, grant, mapOf("wood" to 10L))
        }.code)
        val expanded = apply(full, grant.copy(buildings = mapOf("warehouse" to 2)), mapOf("wood" to 10L))
        assertEquals(5L, expanded.inventory["stone"])
        assertEquals(45L, EconomyRules.storage(expanded, mapOf("wood" to 10L)).available)
        // Existing imported overflow does not prohibit a currency-only repair.
        assertEquals(1L, apply(full.copy(inventory = mapOf("wood" to 500L)), request().copy(coins = 1)).wallet.coins)
    }

    @Test fun `specific fish grants retain species without opening catches knowledge or replacing progression`() {
        val before = empty.copy(inventory = mapOf("fish_epic" to 1L),
            fishing = empty.fishing.copy(stock = mapOf("fish_mirror_koi" to 1L)), marketSlots = 8,
            stageOrders = EconomyStageOrderState(stages = mapOf("2" to EconomyStageOrderProgress(step = 1))),
            unlockedItems = listOf("wood"))
        val next = apply(before, request().copy(items = mapOf("fish_sturgeon" to 2L, "fish_epic" to 3L)))
        assertEquals(6L, next.inventory["fish_epic"])
        assertFalse("fish_sturgeon" in next.inventory)
        assertEquals(mapOf("fish_mirror_koi" to 1L, "fish_sturgeon" to 2L), next.fishing.stock)
        assertEquals(before.fishing.catches, next.fishing.catches)
        assertEquals(before.progression, next.progression)
        assertEquals(before.unlockedItems, next.unlockedItems)
        assertEquals(before.marketSlots, next.marketSlots)
        assertEquals(before.stageOrders, next.stageOrders)
    }

    @Test fun `target construction and production block an upgrade and unrelated jobs remain identical`() {
        val production = EconomyJob(UUID.randomUUID().toString(), "production", "garden", "berries",
            startedAt = now.minusSeconds(60).toString(), finishesAt = now.plusSeconds(60).toString(), rewards = mapOf("berries" to 5L))
        val grant = request().copy(buildings = mapOf("garden" to 2) + secondHouseBuildings)
        for (job in listOf(production, production.copy(kind = "construction", targetLevel = 2, rewards = emptyMap()))) {
            assertEquals("ADMIN_UPGRADE_BUSY", assertFailsWith<AuthFailure> { apply(empty.copy(jobs = listOf(job)), grant) }.code)
        }
        val busy = empty.copy(jobs = listOf(production), buildings = empty.buildings + secondHouseBuildings)
        val next = apply(busy, request().copy(coins = 10, buildings = mapOf("warehouse" to 2)))
        assertEquals(busy.jobs, next.jobs)
    }

    @Test fun `requirements downgrades invalid targets and wallet overflow reject before mutation`() {
        for (grant in listOf(request().copy(buildings = mapOf("home" to 2)),
            request().copy(productionSlots = mapOf("workshop" to 3)), request().copy(rods = listOf("starfall_rod"))))
            assertEquals("ADMIN_UPGRADE_REQUIREMENTS", assertFailsWith<AuthFailure> { apply(request = grant) }.code)
        assertEquals("ADMIN_UPGRADE_DOWNGRADE", assertFailsWith<AuthFailure> {
            apply(empty.copy(buildings = empty.buildings + ("warehouse" to 3)), request().copy(buildings = mapOf("warehouse" to 2)))
        }.code)
        for (grant in listOf(request(), request().copy(coins = -1), request().copy(pearls = Long.MAX_VALUE),
            request().copy(items = mapOf("invented" to 1L)), request().copy(items = mapOf("wood" to 0L)),
            request().copy(buildings = mapOf("warehouse" to 11)), request().copy(productionSlots = mapOf("quarry" to 2)),
            request().copy(rods = listOf("river_rod", "river_rod"))))
            assertEquals("INVALID_ADMIN_GRANT", assertFailsWith<AuthFailure> { apply(request = grant) }.code)
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> {
            apply(empty.copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS)), request().copy(pearls = 1))
        }.code)
    }

    @Test fun `existing unlocks are no-op and granting buildings preserves already offered resident orders`() {
        assertEquals(empty, apply(request = request().copy(buildings = mapOf("home" to 1), rods = listOf("reed_rod"))))
        val next = apply(request = request().copy(buildings = secondHouseBuildings))
        assertEquals(EconomyFood.normalizedOrders(empty, now), next.residentOrders)
        assertEquals(empty.completedExplorations, next.completedExplorations)
        assertEquals(empty.fishing.catches, next.fishing.catches)
    }
}
