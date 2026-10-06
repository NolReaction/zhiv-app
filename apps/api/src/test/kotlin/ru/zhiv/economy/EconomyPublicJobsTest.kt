package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyPublicJobsTest {
    private fun job() = EconomyJob(
        id = "00000000-0000-4000-8000-000000000001", kind = "exploration", targetId = "shore_camp",
        startedAt = "2026-10-06T00:00:00Z", finishesAt = "2026-10-06T08:00:00Z", catalogVersion = 3,
        rewards = mapOf("fish" to 18L, "fish_mooncarp" to 4L, "fish_shark" to 2L, "ancient_core" to 1L),
        cost = EconomyCost(items = mapOf("worm_bait" to 1L)),
        fishing = EconomyFishingCatch("river_rod", "worm_bait", "fish_mooncarp"),
        rareDrop = EconomyRareDropDelivery(seconds = 28_800, itemId = "ancient_core"),
    )

    @Test fun `every unclaimed catch hides species without changing the saved delivery or space required`() {
        val saved = job()
        val original = saved.copy(rewards = saved.rewards.toMap())
        val projected = EconomyPublicJobs.project(saved)
        assertEquals(mapOf("fish" to 24L, "ancient_core" to 1L), projected.rewards)
        assertEquals(saved.rewards.values.sum(), projected.rewards.values.sum())
        assertEquals(saved.fishing?.copy(fishId = "fish"), projected.fishing)
        assertEquals(saved, projected.copy(rewards = saved.rewards, fishing = saved.fishing))
        assertEquals(original, saved)
        assertEquals(projected, EconomyPublicJobs.project(projected))
        val ready = saved.copy(finishesAt = "2020-01-01T00:00:00Z")
        assertEquals(projected.rewards, EconomyPublicJobs.project(ready).rewards)
    }

    @Test fun `ordinary production is unchanged and a retired saved species is still hidden`() {
        val production = job().copy(kind = "production", targetId = "campfire", fishing = null, rareDrop = null,
            rewards = mapOf("smoked_fish" to 1L))
        assertEquals(production, EconomyPublicJobs.project(production))
        val retired = job().copy(fishing = EconomyFishingCatch("river_rod", null, "retired_species"),
            rewards = job().rewards + ("retired_species" to 2L))
        assertEquals(mapOf("fish" to 26L, "ancient_core" to 1L), EconomyPublicJobs.project(retired).rewards)
    }

    @Test fun `general exploration on fishing routes uses private draws and charges the equipped bait`() {
        val now = Instant.parse("2026-10-06T00:00:00Z")
        fun command(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
        val initial = EconomyRules.initial().copy(inventory = mapOf("worm_bait" to 1L),
            fishing = EconomyFishing(equippedBaitId = "worm_bait"))
        for (route in listOf("shore", "shore_camp")) {
            val request = command("start_exploration", route)
            val started = EconomyRules.apply(initial, request, now).first
            val saved = started.jobs.single()
            assertEquals(EconomyRules.catalog.explorations.single { it.id == route }.rewards.values.sum(), saved.rewards.values.sum())
            assertEquals("worm_bait", saved.fishing?.baitId)
            assertEquals(mapOf("worm_bait" to 1L), saved.cost.items)
            assertFalse(started.inventory.containsKey("worm_bait"))
            assertNotEquals(request.requestId, saved.id)
            assertNotNull(started.fishingCastSeed)
            assertNotEquals(request.requestId, started.fishingCastSeed)
            assertNotEquals(saved.id, started.fishingCastSeed)
            val cancelled = EconomyRules.apply(started, command("cancel_exploration", saved.id), now).first
            assertEquals(started.fishingCastSeed, cancelled.fishingCastSeed)
            assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> {
                EconomyRules.apply(cancelled, command("start_exploration", route), now)
            }.code)
            val refilled = cancelled.copy(inventory = mapOf("worm_bait" to 1L))
            val retried = EconomyRules.apply(refilled, command("start_fishing", route), now).first
            assertEquals(saved.rewards, retried.jobs.single().rewards)
            val claimed = EconomyRules.apply(retried, command("claim_job", retried.jobs.single().id), Instant.parse(saved.finishesAt)).first
            assertEquals(saved.rewards, claimed.inventory)
            assertEquals(saved.rewards, claimed.fishing.catches)
            assertNull(claimed.fishingCastSeed)
        }
        assertEquals("ECONOMY_FISHING_ROD", assertFailsWith<AuthFailure> {
            EconomyRules.apply(initial.copy(fishing = initial.fishing.copy(equippedRodId = "unowned_rod")), command("start_exploration", "shore"), now)
        }.code)
    }
}
