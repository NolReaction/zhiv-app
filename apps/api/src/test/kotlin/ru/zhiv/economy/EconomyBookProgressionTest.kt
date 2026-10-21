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
    private fun currentJob(target: String, seconds: Long, kind: String = "exploration", recipe: String? = null) =
        job(target, seconds, kind, recipe).copy(catalogVersion = 12)

    @Test fun `old saved economy defaults empty book and verified counters`() {
        val json = economyJson.encodeToJsonElement(EconomyRules.initial()).jsonObject
        val old = economyJson.decodeFromJsonElement<EconomyState>(JsonObject(json - "progression"))
        assertEquals(EconomyProgression(), old.progression)
        assertFalse(EconomyRules.catalog.items.any { it.id in setOf("quartz_cluster", "striped_agate", "pyrite_spark", "fern_fossil") })
    }

    @Test fun `legacy paid travel keeps original finds on short and long routes`() {
        var short = EconomyProgression()
        repeat(16) { short = EconomyCollectionProgress.advance(short, job("forest", 1800)) }
        val long = EconomyCollectionProgress.advance(EconomyProgression(), job("forest_camp", 28800))
        assertEquals(short.collections, long.collections)
        assertEquals(4, short.collections.finds.size)
        assertEquals(mapOf("forest" to 16L), short.routes)
        assertEquals(mapOf("forest_camp" to 1L), long.routes)
    }

    @Test fun `new long work opens one page without banking excess duration for later claims or merges`() {
        for ((target, seconds) in listOf("forest_camp" to 28800L, "abandoned_quarry" to 57600L, "quarry" to 57600L)) {
            val travel = target == "forest_camp"
            val interval = if (travel) 7200L else 14400L
            val firstFind = if (travel) "acorn" else "quartz_cluster"
            val paid = if (target == "quarry") currentJob(target, seconds, "production", "extract_stone") else currentJob(target, seconds)
            val completed = EconomyCollectionProgress.advance(EconomyProgression(), paid)
            assertEquals(listOf(firstFind), completed.collections.finds)
            assertEquals(interval, if (travel) completed.collections.travelSeconds else completed.collections.quarrySeconds)
            val oneSecond = EconomyCollectionProgress.advance(completed, paid.copy(finishesAt = now.plusSeconds(1).toString()))
            assertEquals(listOf(firstFind), oneSecond.collections.finds)
            assertEquals(interval + 1, if (travel) oneSecond.collections.travelSeconds else oneSecond.collections.quarrySeconds)
            assertEquals(completed, EconomyCollectionProgress.merge(completed, EconomyProgression()))
        }
    }

    @Test fun `new short jobs accumulate actual work rather than one page per click`() {
        var short = EconomyProgression()
        repeat(3) { short = EconomyCollectionProgress.advance(short, currentJob("forest", 1800)) }
        assertEquals(5400L, short.collections.travelSeconds)
        assertTrue(short.collections.finds.isEmpty())
        short = EconomyCollectionProgress.advance(short, currentJob("forest", 1800))
        assertEquals(7200L, short.collections.travelSeconds)
        assertEquals(listOf("acorn"), short.collections.finds)
        repeat(12) { short = EconomyCollectionProgress.advance(short, currentJob("forest", 1800)) }
        assertEquals(4, short.collections.finds.size)
        assertEquals(1, EconomyCollectionProgress.advance(EconomyProgression(), currentJob("forest_camp", 28800)).collections.finds.size)
    }

    @Test fun `new cap retains historical pages and partial work without deferred thresholds`() {
        val previous = EconomyCollectionProgress.advance(EconomyProgression(), job("forest_camp", 32400))
        assertEquals(4, previous.collections.finds.size)
        val next = EconomyCollectionProgress.advance(previous, currentJob("forest_camp", 28800))
        assertEquals(39600L, next.collections.travelSeconds)
        assertEquals(5, next.collections.finds.size)
        val finished = EconomyCollectionProgress.advance(next, currentJob("forest", 3600))
        assertEquals(43200L, finished.collections.travelSeconds)
        assertEquals(6, finished.collections.finds.size)
        val full = EconomyCollectionProgress.advance(finished, currentJob("forest_camp", 28800))
        assertEquals(6, full.collections.finds.size)
        assertEquals(50400L, full.collections.travelSeconds)
    }

    @Test fun `version eleven paid work keeps four promised pages after catalogue changes`() {
        val paid = job("forest_camp", 28800).copy(catalogVersion = 11)
        val completed = EconomyCollectionProgress.advance(EconomyProgression(), paid)
        assertEquals(28800L, completed.collections.travelSeconds)
        assertEquals(4, completed.collections.finds.size)
        assertEquals(11, paid.catalogVersion)
    }

    @Test fun `inherited ownership skips duplicate finds but cannot invent work`() {
        val imported = EconomyCollectionProgress.inherit(EconomyProgression(), listOf("acorn", "feather", "river_pearl", "unknown", "acorn"))
        assertEquals(listOf("acorn", "feather"), imported.collections.finds)
        assertEquals(0L, imported.collections.travelSeconds)
        assertTrue(imported.routes.isEmpty())
        val next = EconomyCollectionProgress.advance(imported, job("forest", 7200))
        assertEquals(listOf("acorn", "feather", "fern_leaf"), next.collections.finds)
    }

    @Test fun `legacy far bank expeditions retain saved travel duration and forest finds without quarry time`() {
        for (id in listOf("far_bank_path", "far_bank_grove", "ancient_ruins")) {
            val route = EconomyRules.catalog.explorations.single { it.id == id }
            val completed = EconomyCollectionProgress.advance(EconomyProgression(), job(id, route.seconds))
            val forest = EconomyCollectionProgress.advance(EconomyProgression(), job("forest", route.seconds))
            assertEquals(mapOf(id to 1L), completed.routes)
            assertEquals(route.seconds, completed.collections.travelSeconds)
            assertEquals(0L, completed.collections.quarrySeconds)
            assertEquals(forest.collections, completed.collections)
            assertTrue(completed.collections.finds.isNotEmpty())
        }
    }

    @Test fun `legacy quarry orders and cave routes retain saved job durations and separate clocks`() {
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
        assertEquals(12, started.jobs.single().catalogVersion)
        assertEquals(7200L, next.progression.collections.travelSeconds)
        assertEquals(1, next.progression.collections.finds.size)
        assertEquals(mapOf("forest_camp" to 1L), next.progression.routes)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { EconomyRules.apply(next, claim, now.plusSeconds(7L * 86400)) }.code)
    }

    @Test fun `failed warehouse delivery leaves the immutable old progress unchanged`() {
        val started = EconomyRules.apply(EconomyRules.initial(), command("start_exploration", "forest_camp"), now).first
            .copy(inventory = mapOf("wood" to 300L))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.apply(started, command("claim_job", started.jobs.single().id), now.plusSeconds(28800))
        }.code)
        assertEquals(EconomyProgression(), started.progression)
        val collected = EconomyRules.apply(started.copy(inventory = emptyMap()), command("claim_job", started.jobs.single().id), now.plusSeconds(28800)).first
        assertEquals(1, collected.progression.collections.finds.size)
    }

    @Test fun `already paid old work keeps original rewards and cannot be claimed twice`() {
        val started = EconomyRules.apply(EconomyRules.initial(), command("start_exploration", "forest_camp"), now).first
        val restored = started.copy(jobs = started.jobs.map { it.copy(catalogVersion = 11) })
        val claim = command("claim_job", restored.jobs.single().id)
        val claimAt = now.plusSeconds(7L * 86400)
        val completed = EconomyRules.apply(restored, claim, claimAt).first
        assertEquals(28800L, completed.progression.collections.travelSeconds)
        assertEquals(4, completed.progression.collections.finds.size)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { EconomyRules.apply(completed, claim, claimAt) }.code)
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
