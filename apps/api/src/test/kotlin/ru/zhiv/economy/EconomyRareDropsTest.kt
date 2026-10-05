package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyRareDropsTest {
    private val spec = checkNotNull(EconomyRules.catalog.rareDrops)
    private val now = Instant.parse("2026-10-05T20:00:00Z")
    private fun clock(seconds: Long, item: String = "living_resin") = EconomyRareDropClock(remainingSeconds = seconds, itemId = item)
    private fun command(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) = EconomyRules.apply(state, command(action, target), at).first
    private fun ready(home: Int = 3) = EconomyRules.initial().let { it.copy(buildings = it.buildings + ("home" to home)) }

    @Test fun `uniform clock bounds match TypeScript vectors and reject multi-drop jobs`() {
        val low = EconomyRareDrops.prepare(null, 1800, spec) { 0 }
        assertEquals(clock(172800, "ancient_core"), low.clock)
        val values = ArrayDeque(listOf(345600, 2))
        val high = EconomyRareDrops.prepare(null, 1800, spec) { values.removeFirst() }
        assertEquals(clock(518400), high.clock)
        assertEquals(96L, (spec.minSeconds + spec.maxSeconds) / 7200)
        assertFailsWith<IllegalArgumentException> { EconomyRareDrops.prepare(null, spec.minSeconds, spec) }
        assertFailsWith<IllegalArgumentException> { EconomyRareDrops.prepare(null, 1800, spec) { -1 } }
    }

    @Test fun `equal completed work gives the same drop and carries overshoot`() {
        fun complete(durations: List<Long>): Pair<EconomyRareDropClock, Long> {
            var current = clock(spec.minSeconds, "ancient_core"); var count = 0L
            durations.forEach { seconds ->
                val job = EconomyRareDrops.prepare(current, seconds, spec) { error("Existing clock cannot reroll") }
                count += job.rewards.values.sum()
                current = EconomyRareDrops.settle(current, job.delivery, spec) { 0 }
            }
            return current to count
        }
        assertEquals(complete(List(96) { 1800L }), complete(List(6) { 28800L }))
        assertEquals(1L, complete(List(6) { 28800L }).second)
        val job = EconomyRareDrops.prepare(clock(900), 1800, spec)
        assertEquals(clock(spec.minSeconds - 900, "ancient_core"), EconomyRareDrops.settle(job.clock, job.delivery, spec) { 0 })
    }

    @Test fun `only successful post-unlock exploration advances clock and cancel never rerolls`() {
        for (home in listOf(1, 2)) {
            val start = apply(ready(home), "start_exploration", "forest")
            val job = start.jobs.single()
            assertNull(job.rareDrop); assertNull(start.rareDropState)
            assertNull(apply(start, "claim_job", job.id, Instant.parse(job.finishesAt)).rareDropState)
        }
        val initial = ready().copy(rareDropState = clock(9 * 3600))
        val preview = apply(initial, "start_exploration", "forest_camp")
        assertNull(preview.jobs.single().rareDrop?.itemId)
        val cancelled = apply(preview, "cancel_exploration", preview.jobs.single().id)
        assertEquals(initial.rareDropState, cancelled.rareDropState)
        val short = apply(cancelled, "start_exploration", "forest")
        val claimed = apply(short, "claim_job", short.jobs.single().id, Instant.parse(short.jobs.single().finishesAt))
        assertEquals(clock(9 * 3600 - 1800), claimed.rareDropState)
        assertNull(apply(claimed, "start_exploration", "forest_camp").jobs.single().rareDrop?.itemId)
        val production = apply(initial.copy(buildings = initial.buildings + ("woodlot" to 1)), "start_production", "gather_wood")
        assertNull(production.jobs.single().rareDrop)
        assertEquals(initial.rareDropState, apply(production, "claim_job", production.jobs.single().id,
            Instant.parse(production.jobs.single().finishesAt)).rareDropState)
    }

    @Test fun `rare catch is fixed at start failure leaves state intact and never counts as a fish`() {
        val started = apply(ready().copy(rareDropState = clock(900, "ancient_core")), "start_fishing", "shore")
        val job = started.jobs.single()
        assertEquals("ancient_core", job.rareDrop?.itemId); assertEquals(1L, job.rewards["ancient_core"])
        val full = started.copy(inventory = mapOf("wood" to EconomyRules.storage(started).capacity))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(full, "claim_job", job.id, Instant.parse(job.finishesAt)) }.code)
        assertEquals(clock(900, "ancient_core"), full.rareDropState)
        val claimed = apply(started, "claim_job", job.id, Instant.parse(job.finishesAt).plusSeconds(7 * 86400))
        assertEquals(1L, claimed.inventory["ancient_core"])
        assertFalse(claimed.fishing.catches.containsKey("ancient_core"))
        assertTrue(checkNotNull(claimed.rareDropState).remainingSeconds in (spec.minSeconds - 900)..(spec.maxSeconds - 900))
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(claimed, "claim_job", job.id, Instant.parse(job.finishesAt)) }.code)
    }

    @Test fun `old JSON jobs finish without retroactive hours and client cannot supply rare entropy`() {
        val initial = ready().copy(rareDropState = clock(100))
        val job = EconomyJob(UUID.randomUUID().toString(), "exploration", "forest", startedAt = now.minusSeconds(1800).toString(),
            finishesAt = now.toString(), rewards = mapOf("wood" to 2), catalogVersion = 1)
        val json = economyJson.encodeToJsonElement(initial.copy(jobs = listOf(job))).jsonObject
        val restored = economyJson.decodeFromJsonElement<EconomyState>(JsonObject(json - "rareDropState"))
        assertNull(restored.rareDropState)
        assertNull(apply(restored, "claim_job", job.id).rareDropState)
        assertEquals(clock(100), apply(initial.copy(jobs = listOf(job)), "claim_job", job.id).rareDropState)
        val request = economyJson.encodeToJsonElement(command("start_exploration", "forest")).jsonObject
        for (field in listOf("rareDrop", "rareDropState", "rewards", "rareRandom")) {
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
                decodeEconomyCommand(JsonObject(request + (field to JsonPrimitive(0))))
            }.code)
        }
    }

    @Test fun `merge cannot choose closer countdown and specials cannot be coin bought or sold`() {
        val near = clock(500), far = clock(400000, "moon_crystal")
        assertEquals(far, EconomyRareDrops.merge(near, far)); assertEquals(far, EconomyRareDrops.merge(far, near))
        assertEquals(far, EconomyRareDrops.merge(null, far)); assertEquals(far, EconomyRareDrops.merge(far, null))
        assertNull(EconomyRareDrops.merge(null, null))
        val owned = ready().copy(inventory = spec.itemIds.associateWith { 1L })
        assertEquals(3L, EconomyRules.storage(owned).used)
        for (id in spec.itemIds) {
            assertEquals("ECONOMY_ITEM", assertFailsWith<AuthFailure> { apply(owned, "sell", id) }.code)
            assertEquals("ECONOMY_FISHING_SHOP_CHANGED", assertFailsWith<AuthFailure> { apply(owned, "buy_fishing_item", id) }.code)
        }
    }
}
