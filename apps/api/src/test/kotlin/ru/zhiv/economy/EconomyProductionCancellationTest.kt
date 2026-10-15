package ru.zhiv.economy

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyProductionCancellationTest {
    private val now = Instant.parse("2026-10-15T00:00:00Z")
    private fun command(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, reserved: Map<String, Long> = emptyMap()) =
        EconomyRules.apply(state, command(action, target), at, reserved).first
    private fun initial() = EconomyRules.initial().let { it.copy(inventory = mapOf("wood" to 4L, "berries" to 5L, "fish_rare" to 1L),
        buildings = it.buildings + mapOf("home" to 3, "workshop" to 1, "woodlot" to 1, "dryer" to 3)) }

    @Test fun `cancellation returns paid fish and supplies without producing food progress or other slot changes`() {
        val initial = initial()
        val plank = apply(initial, "start_production", "make_planks")
        val started = apply(plank, "start_production", "cook_hearty_fish")
        val dinner = started.jobs.single { it.targetId == "dryer" }
        assertEquals(1L, dinner.cost.items["fish_rare"])
        val cancelled = apply(started, "cancel_production", dinner.id, now.plusMillis(1))
        assertEquals(initial.inventory + ("wood" to 3L), cancelled.inventory)
        assertEquals(plank.jobs, cancelled.jobs)
        assertEquals(started.wallet, cancelled.wallet)
        assertEquals(started.progression, cancelled.progression)
        assertEquals(started.food, cancelled.food)
        assertEquals(started.unlockedItems, cancelled.unlockedItems)
        assertEquals(started.completedExplorations, cancelled.completedExplorations)
        assertEquals(started.tutorialOrder, cancelled.tutorialOrder)
        assertNull(cancelled.inventory["hearty_fish"])
        assertEquals(2, apply(cancelled, "start_production", "cook_hearty_fish", now.plusMillis(2)).jobs.size)
        assertEquals(2, started.jobs.size, "input state is immutable")
    }

    @Test fun `retired recipe refunds exact saved coins and materials rather than current terms`() {
        val original = apply(initial(), "start_production", "make_planks")
        val saved = original.jobs.single().copy(recipeId = "retired_recipe", catalogVersion = 1,
            cost = EconomyCost(73L, mapOf("fish_rare" to 2L, "wood" to 3L, "berries" to 1L)))
        val started = original.copy(inventory = emptyMap(), wallet = original.wallet.copy(coins = 20), jobs = listOf(saved))
        val cancelled = apply(started, "cancel_production", saved.id)
        assertEquals(saved.cost.items, cancelled.inventory)
        assertEquals(93L, cancelled.wallet.coins)
        assertEquals(started.wallet.pearls, cancelled.wallet.pearls)
        assertEquals(started.progression, cancelled.progression)
        assertTrue(cancelled.jobs.isEmpty())
    }

    @Test fun `ready boundary collection and unsupported job kinds cannot bypass normal delivery`() {
        val started = apply(initial(), "start_production", "make_planks")
        val saved = started.jobs.single()
        for (at in listOf(Instant.parse(saved.finishesAt), Instant.parse(saved.finishesAt).plusMillis(1)))
            assertEquals("ECONOMY_CANCEL_READY", assertFailsWith<AuthFailure> { apply(started, "cancel_production", saved.id, at) }.code)
        val variants = listOf(
            saved.copy(kind = "construction", targetLevel = 2) to "ECONOMY_CANCEL_KIND",
            saved.copy(kind = "exploration", targetId = "mine_stone", actorId = "miner") to "ECONOMY_CANCEL_KIND",
            saved.copy(targetId = "quarry") to "ECONOMY_CANCEL_KIND",
            saved.copy(targetId = "retired_station") to "ECONOMY_CANCEL_KIND",
            saved.copy(collection = EconomyCollection("berry_harvest", 8, now.toString(), now.plusSeconds(8).toString())) to "ECONOMY_CANCEL_READY",
        )
        for ((job, code) in variants) assertEquals(code, assertFailsWith<AuthFailure> {
            apply(started.copy(jobs = listOf(job)), "cancel_production", saved.id)
        }.code)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(started, "cancel_production", UUID.randomUUID().toString()) }.code)
        assertEquals(1, started.jobs.size)
    }

    @Test fun `aggregate refund space includes escrow and failed capacity leaves work available to retry`() {
        val started = apply(initial(), "start_production", "make_planks").copy(inventory = mapOf("wood" to 48L))
        val job = started.jobs.single()
        val reserved = mapOf("wood" to 2L)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(started, "cancel_production", job.id, reserved = reserved) }.code)
        assertEquals(1, started.jobs.size)
        assertEquals(mapOf("wood" to 48L), started.inventory)
        val freed = started.copy(inventory = mapOf("wood" to 47L))
        val cancelled = apply(freed, "cancel_production", job.id, reserved = reserved)
        assertEquals(mapOf("wood" to 48L), cancelled.inventory)
        assertEquals(50L, EconomyRules.storage(cancelled, reserved).let { it.used + it.reserved })
        assertTrue(cancelled.jobs.isEmpty())
        assertEquals(freed.progression, cancelled.progression)
    }

    @Test fun `coin and combined item caps guard refund while free production can cancel in an overflowing warehouse`() {
        val started = apply(initial(), "start_production", "make_planks")
        val job = started.jobs.single().copy(cost = EconomyCost(5L, mapOf("wood" to 1L)))
        val walletFull = started.copy(wallet = started.wallet.copy(coins = ECONOMY_MAX_BALANCE - 4), jobs = listOf(job))
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> { apply(walletFull, "cancel_production", job.id) }.code)
        val itemFull = started.copy(inventory = mapOf("wood" to ECONOMY_MAX_ITEMS), jobs = listOf(job.copy(cost = job.cost.copy(coins = 0))))
        for (reserved in listOf(emptyMap(), mapOf("wood" to 1L))) assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> {
            apply(itemFull, "cancel_production", job.id, reserved = reserved)
        }.code)
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> {
            apply(itemFull.copy(inventory = mapOf("wood" to ECONOMY_MAX_ITEMS - 1)), "cancel_production", job.id, reserved = mapOf("wood" to 1L))
        }.code)
        val free = apply(initial(), "start_production", "grow_berries").copy(inventory = mapOf("wood" to 300L))
        val cancelled = apply(free, "cancel_production", free.jobs.single().id)
        assertEquals(free.inventory, cancelled.inventory)
        assertEquals(free.wallet, cancelled.wallet)
        assertTrue(cancelled.jobs.isEmpty())
    }

    @Test fun `cancel production accepts only ordinary command fields quantity one and no client refund terms`() {
        val started = apply(initial(), "start_production", "make_planks")
        val cancel = command("cancel_production", started.jobs.single().id)
        for (invalid in listOf(cancel.copy(quantity = 2), cancel.copy(totalPrice = 1))) assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
            EconomyRules.apply(started, invalid, now)
        }.code)
        val json = economyJson.encodeToJsonElement(cancel).jsonObject
        assertEquals(cancel, decodeEconomyCommand(json))
        for (field in listOf("cost", "refund", "rewards")) assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
            decodeEconomyCommand(JsonObject(json + (field to JsonPrimitive(100))))
        }.code)
        assertFalse(EconomyRules.commandUsesActor(cancel))
    }
}
