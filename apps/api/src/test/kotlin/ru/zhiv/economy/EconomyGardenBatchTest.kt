package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyGardenBatchTest {
    private val now = Instant.parse("2026-10-15T00:00:00Z")
    private fun command(action: String, target: String) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun job(recipe: String, item: String, quantity: Long = 1, seconds: Long = 8) = EconomyJob(
        UUID.randomUUID().toString(), "production", "garden", recipeId = recipe,
        startedAt = now.minusSeconds(300).toString(), finishesAt = now.toString(),
        rewards = mapOf(item to quantity), collection = EconomyCollection("berry_harvest", seconds, null, null), catalogVersion = 10)
    private fun garden() = EconomyRules.initial().copy(inventory = emptyMap(),
        buildings = EconomyRules.initial().buildings + mapOf("home" to 5, "garden" to 5),
        jobs = listOf(job("grow_berries", "berries"), job("grow_strawberries", "strawberries"), job("grow_blueberries", "blueberries")))
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, escrow: Map<String, Long> = emptyMap()) =
        EconomyRules.apply(state, command(action, target), at, escrow).first

    @Test fun `one timed basket captures all ripe berries and preserves paid work terms and per recipe progress`() {
        val state = garden()
        val later = job("grow_cranberries", "cranberries").copy(finishesAt = now.plusSeconds(4).toString())
        val fiber = state.jobs.first().copy(id = UUID.randomUUID().toString(), recipeId = "garden_fiber", rewards = mapOf("fiber" to 1L), collection = null)
        val legacy = state.jobs.first().copy(id = UUID.randomUUID().toString(), recipeId = "retired", rewards = mapOf("berries" to 7L), collection = null)
        val original = state.copy(jobs = state.jobs + listOf(later, fiber, legacy))
        val request = command("start_garden_collection", state.jobs[1].id)
        val started = EconomyRules.apply(original, request, now).first
        assertEquals(original.inventory, started.inventory); assertEquals(original.wallet, started.wallet)
        val batch = started.jobs.filter { it.collection?.batchId == request.requestId }
        assertEquals(state.jobs.map { it.id }, batch.map { it.id })
        batch.forEach { current ->
            val before = original.jobs.single { it.id == current.id }
            assertEquals(before.copy(collection = current.collection), current)
            assertEquals(now.toString(), current.collection?.startedAt)
            assertEquals(now.plusSeconds(8).toString(), current.collection?.finishesAt)
        }
        assertEquals("ECONOMY_COLLECTION_BATCH_REQUIRED", assertFailsWith<AuthFailure> {
            apply(started, "claim_job", batch.first().id, now.plusSeconds(8)) }.code)
        assertEquals("ECONOMY_COLLECTION_NOT_READY", assertFailsWith<AuthFailure> {
            apply(started, "claim_garden_collection", request.requestId, now.plusSeconds(8).minusNanos(1)) }.code)
        val delivered = apply(started, "claim_garden_collection", request.requestId, now.plusSeconds(8))
        assertEquals(mapOf("berries" to 1L, "strawberries" to 1L, "blueberries" to 1L), delivered.inventory)
        assertEquals(listOf(later, fiber, legacy), delivered.jobs)
        state.jobs.forEach { assertEquals(1L, delivered.progression.recipes[checkNotNull(it.recipeId)]) }
        assertTrue(delivered.unlockedItems.containsAll(delivered.inventory.keys))
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            apply(delivered, "claim_garden_collection", request.requestId, now.plusSeconds(9)) }.code)
    }

    @Test fun `saved durations and old collection fields survive JSON round trips without changing legacy signatures`() {
        val original = garden()
        val state = original.copy(jobs = listOf(original.jobs[0].copy(collection = EconomyCollection("berry_harvest", 17, null, null)),
            original.jobs[1].copy(collection = null, rewards = mapOf("strawberries" to 13L)), original.jobs[2]))
        val old = checkNotNull(state.jobs[0].collection)
        val json = economyJson.encodeToString(old)
        assertEquals(setOf("kind", "seconds", "startedAt", "finishesAt"), economyJson.parseToJsonElement(json).jsonObject.keys)
        assertFalse(json.contains("batchId"))
        assertEquals(old, economyJson.decodeFromString<EconomyCollection>(json))
        val request = command("start_garden_collection", state.jobs[1].id)
        val started = EconomyRules.apply(state, request, now).first
        started.jobs.forEach { assertEquals(now.plusSeconds(17).toString(), it.collection?.finishesAt) }
        assertEquals(17L, started.jobs[0].collection?.seconds); assertEquals(8L, started.jobs[1].collection?.seconds)
        val persisted = economyJson.encodeToString(started)
        val resumed = economyJson.decodeFromString<EconomyState>(persisted)
        assertEquals(started, resumed)
        assertEquals("ECONOMY_COLLECTION_NOT_READY", assertFailsWith<AuthFailure> {
            apply(resumed, "claim_garden_collection", request.requestId, now.plusSeconds(8)) }.code)
        val delivered = apply(resumed, "claim_garden_collection", request.requestId, now.plusSeconds(86400))
        assertEquals(13L, delivered.inventory["strawberries"]); assertTrue(delivered.jobs.isEmpty())
        assertFailsWith<IllegalArgumentException> { old.copy(batchId = request.requestId) }
        assertFailsWith<IllegalArgumentException> { old.copy(startedAt = now.toString(), finishesAt = now.plusSeconds(17).toString(), batchId = "bogus") }
        val encoded = economyJson.parseToJsonElement(economyJson.encodeToString(original.jobs.first())).jsonObject
        assertNull(economyJson.decodeFromJsonElement<EconomyJob>(JsonObject(encoded - "collection")).collection)
    }

    @Test fun `combined storage and escrow preflight rejects the whole basket before marking any job`() {
        val state = garden().copy(inventory = mapOf("wood" to 46L))
        val request = command("start_garden_collection", state.jobs.first().id)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, request, now, mapOf("stone" to 2L)) }.code)
        assertTrue(state.jobs.all { it.collection?.startedAt == null })
        assertEquals(mapOf("wood" to 46L), state.inventory)
        val started = EconomyRules.apply(state.copy(inventory = mapOf("wood" to 45L)), request, now, mapOf("stone" to 2L)).first
        assertEquals(3, started.jobs.count { it.collection?.batchId == request.requestId })
    }

    @Test fun `failed basket delivery preserves every member for a later all or nothing retry`() {
        val state = garden().copy(inventory = mapOf("wood" to 47L))
        val request = command("start_garden_collection", state.jobs.first().id)
        val started = EconomyRules.apply(state, request, now).first
        val filled = started.copy(inventory = mapOf("wood" to 49L))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            apply(filled, "claim_garden_collection", request.requestId, now.plusSeconds(8)) }.code)
        assertEquals(3, filled.jobs.size); assertEquals(state.progression, filled.progression)
        assertEquals(mapOf("wood" to 49L), filled.inventory)
        val delivered = apply(filled.copy(inventory = state.inventory), "claim_garden_collection", request.requestId, now.plusSeconds(9))
        assertEquals(50L, delivered.inventory.values.sum()); assertTrue(delivered.jobs.isEmpty())
        assertEquals(3L, delivered.progression.recipes.values.sum())
    }

    @Test fun `legacy singleton keeps its old claim and neither basket nor expedition can steal its collector`() {
        val state = garden()
        val started = apply(state, "start_collection", state.jobs.first().id)
        assertNull(started.jobs.first().collection?.batchId)
        assertEquals("ECONOMY_COLLECTOR_BUSY", assertFailsWith<AuthFailure> {
            apply(started, "start_garden_collection", state.jobs[1].id, now.plusSeconds(8)) }.code)
        val single = apply(started, "claim_job", state.jobs.first().id, now.plusSeconds(8))
        assertEquals(1L, single.inventory["berries"])
        val request = command("start_garden_collection", single.jobs.first().id)
        val basket = EconomyRules.apply(single, request, now.plusSeconds(8)).first
        assertEquals(2, basket.jobs.count { it.collection?.batchId == request.requestId })
        assertEquals("ECONOMY_COLLECTOR_BUSY", assertFailsWith<AuthFailure> {
            apply(basket, "start_exploration", "forest", now.plusSeconds(16)) }.code)
    }

    @Test fun `basket commands validate quantity price and unexpected payload without trusting client animation`() {
        val state = garden()
        for (action in listOf("start_garden_collection", "claim_garden_collection")) {
            val request = command(action, state.jobs.first().id)
            for (invalid in listOf(request.copy(quantity = 2), request.copy(totalPrice = 1)))
                assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { EconomyRules.apply(state, invalid, now) }.code)
            val fields = economyJson.parseToJsonElement(economyJson.encodeToString(request)).jsonObject
            for (field in listOf("batchId", "rewards", "animationComplete"))
                assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
                    decodeEconomyCommand(JsonObject(fields + (field to kotlinx.serialization.json.JsonPrimitive(true)))) }.code)
        }
        assertTrue(EconomyRules.commandUsesActor(command("start_garden_collection", state.jobs.first().id)))
        assertFalse(EconomyRules.commandUsesActor(command("claim_garden_collection", UUID.randomUUID().toString())))
    }
}
