package ru.zhiv.economy

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyBookProgressionTest {
    private val now = Instant.parse("2026-10-05T15:00:00Z")
    private fun command(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun job(target: String, seconds: Long, kind: String = "exploration", recipe: String? = null) =
        EconomyJob(UUID.randomUUID().toString(), kind, target, recipe, startedAt = now.toString(), finishesAt = now.plusSeconds(seconds).toString())

    @Test fun `old saved economy defaults empty book and verified counters`() {
        val json = economyJson.encodeToJsonElement(EconomyRules.initial()).jsonObject
        val old = economyJson.decodeFromJsonElement<EconomyState>(JsonObject(json - "progression"))
        assertEquals(EconomyProgression(), old.progression)
        assertFalse(EconomyRules.catalog.items.any { it.id in setOf("quartz_cluster", "striped_agate", "pyrite_spark", "fern_fossil") })
    }

    @Test fun `long and short forest routes use equal completed work without per-click farming`() {
        var short = EconomyProgression()
        repeat(16) { short = EconomyCollectionProgress.advance(short, job("forest", 1800)) }
        val long = EconomyCollectionProgress.advance(EconomyProgression(), job("forest_camp", 28800))
        assertEquals(short.collections, long.collections)
        assertEquals(4, short.collections.finds.size)
        assertEquals(mapOf("forest" to 16L), short.routes)
        assertEquals(mapOf("forest_camp" to 1L), long.routes)
    }

    @Test fun `inherited ownership skips duplicate finds but cannot invent work`() {
        val imported = EconomyCollectionProgress.inherit(EconomyProgression(), listOf("acorn", "feather", "river_pearl", "unknown", "acorn"))
        assertEquals(listOf("acorn", "feather"), imported.collections.finds)
        assertEquals(0L, imported.collections.travelSeconds)
        assertTrue(imported.routes.isEmpty())
        val next = EconomyCollectionProgress.advance(imported, job("forest", 7200))
        assertEquals(listOf("acorn", "feather", "fern_leaf"), next.collections.finds)
    }

    @Test fun `quarry orders and cave routes contribute saved job durations to a separate clock`() {
        val first = EconomyCollectionProgress.advance(EconomyProgression(), job("quarry", 7200, "production", "extract_stone"))
        val next = EconomyCollectionProgress.advance(first, job("cave", 7200))
        assertEquals(mapOf("extract_stone" to 1L), next.recipes)
        assertEquals(mapOf("cave" to 1L), next.routes)
        assertEquals(0L, next.collections.travelSeconds)
        assertEquals(14400L, next.collections.quarrySeconds)
        assertEquals(listOf("quartz_cluster"), next.collections.finds)
        assertEquals(next, EconomyCollectionProgress.advance(next, job("home", 86400, "construction")))
    }

    @Test fun `start cancel and unclaimed completion never award book progress`() {
        val initial = EconomyRules.initial()
        val started = EconomyRules.apply(initial, command("start_exploration", "forest_camp"), now).first
        assertEquals(initial.progression, started.progression)
        val cancelled = EconomyRules.apply(started, command("cancel_exploration", started.jobs.single().id), now.plusSeconds(28800)).first
        assertEquals(initial.progression, cancelled.progression)
    }

    @Test fun `claim records the saved duration once even when the player waits a week`() {
        val started = EconomyRules.apply(EconomyRules.initial(), command("start_exploration", "forest_camp"), now).first
        val claim = command("claim_job", started.jobs.single().id)
        val next = EconomyRules.apply(started, claim, now.plusSeconds(7L * 86400)).first
        assertEquals(28800L, next.progression.collections.travelSeconds)
        assertEquals(4, next.progression.collections.finds.size)
        assertEquals(mapOf("forest_camp" to 1L), next.progression.routes)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { EconomyRules.apply(next, claim, now.plusSeconds(7L * 86400)) }.code)
    }

    @Test fun `failed warehouse delivery leaves the immutable old progress unchanged`() {
        val started = EconomyRules.apply(EconomyRules.initial(), command("start_exploration", "forest_camp"), now).first
            .copy(inventory = mapOf("wood" to 200L))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.apply(started, command("claim_job", started.jobs.single().id), now.plusSeconds(28800))
        }.code)
        assertEquals(EconomyProgression(), started.progression)
        val collected = EconomyRules.apply(started.copy(inventory = emptyMap()), command("claim_job", started.jobs.single().id), now.plusSeconds(28800)).first
        assertEquals(4, collected.progression.collections.finds.size)
    }

    @Test fun `merge unions finds and combines partial work exactly once`() {
        val first = EconomyCollectionProgress.advance(EconomyProgression(), job("forest", 3600))
        val second = EconomyCollectionProgress.advance(EconomyProgression(), job("forest", 3600))
        val merged = EconomyCollectionProgress.merge(first, second)
        assertEquals(7200L, merged.collections.travelSeconds)
        assertEquals(listOf("acorn"), merged.collections.finds)
        assertEquals(merged, EconomyCollectionProgress.merge(merged, EconomyProgression()))
        val later = EconomyCollectionProgress.advance(merged, job("forest", 7200))
        assertEquals(listOf("acorn", "feather"), later.collections.finds)
        val quarry = EconomyCollectionProgress.advance(EconomyProgression(), job("cave", 14400))
        val all = EconomyCollectionProgress.merge(later, quarry)
        assertEquals(listOf("acorn", "feather", "quartz_cluster"), all.collections.finds)
    }
}
