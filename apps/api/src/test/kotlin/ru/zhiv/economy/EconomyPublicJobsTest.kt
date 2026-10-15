package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyPublicJobsTest {
    private val now = Instant.parse("2026-10-06T00:00:00Z")
    private fun job() = EconomyJob(
        id = "00000000-0000-4000-8000-000000000001", kind = "exploration", targetId = "shore_camp",
        startedAt = "2026-10-06T00:00:00Z", finishesAt = "2026-10-06T08:00:00Z", catalogVersion = 3,
        rewards = mapOf("fish" to 18L, "fish_mooncarp" to 4L, "fish_shark" to 2L, "ancient_core" to 1L),
        cost = EconomyCost(items = mapOf("worm_bait" to 1L)),
        fishing = EconomyFishingCatch("river_rod", "worm_bait", "fish_mooncarp"),
        rareDrop = EconomyRareDropDelivery(seconds = 28_800, itemId = "ancient_core"),
    )

    @Test fun `unfinished catches hide species and completed catches reveal only the saved delivery`() {
        val saved = job()
        val original = saved.copy(rewards = saved.rewards.toMap())
        val projected = EconomyPublicJobs.project(saved, now)
        assertEquals(mapOf("fish" to 24L, "ancient_core" to 1L), projected.rewards)
        assertEquals(saved.rewards.values.sum(), projected.rewards.values.sum())
        assertEquals(saved.fishing?.copy(fishId = "fish"), projected.fishing)
        assertEquals(saved, projected.copy(rewards = saved.rewards, fishing = saved.fishing))
        assertEquals(original, saved)
        assertEquals(projected, EconomyPublicJobs.project(projected, now))
        val finish = Instant.parse(saved.finishesAt)
        val revealed = original.copy(fishing = original.fishing?.copy(catchRevealed = true))
        assertEquals(projected, EconomyPublicJobs.project(saved, finish.minusMillis(1)))
        assertEquals(revealed, EconomyPublicJobs.project(saved, finish))
        assertEquals(revealed, EconomyPublicJobs.project(saved, finish.plusSeconds(1)))
        assertEquals(original, saved)
    }

    @Test fun `ordinary production is unchanged and unfinished retired species are hidden`() {
        val production = job().copy(kind = "production", targetId = "campfire", fishing = null, rareDrop = null,
            rewards = mapOf("smoked_fish" to 1L))
        assertEquals(production, EconomyPublicJobs.project(production, now))
        val retired = job().copy(fishing = EconomyFishingCatch("river_rod", null, "retired_species"),
            rewards = job().rewards + ("retired_species" to 2L))
        assertEquals(mapOf("fish" to 26L, "ancient_core" to 1L), EconomyPublicJobs.project(retired, now).rewards)
        assertEquals(retired.copy(fishing = retired.fishing?.copy(catchRevealed = true)), EconomyPublicJobs.project(retired, Instant.parse(retired.finishesAt)))
    }

    @Test fun `invalid completion timestamps do not reveal a private catch`() {
        val saved = job().let { it.copy(fishing = it.fishing?.copy(catchRevealed = true)) }
        for (timestamp in listOf("invalid", "")) {
            val invalid = saved.copy(finishesAt = timestamp)
            assertEquals(mapOf("fish" to 24L, "ancient_core" to 1L), EconomyPublicJobs.project(invalid, now).rewards)
            assertEquals("fish", EconomyPublicJobs.project(invalid, now).fishing?.fishId)
            assertNull(EconomyPublicJobs.project(invalid, now).fishing?.catchRevealed)
            assertEquals(saved.rewards, invalid.rewards)
        }
    }

    @Test fun `a reveal marker distinguishes a genuine all river catch from an old masked snapshot`() {
        val saved = job().let { it.copy(rewards = mapOf("fish" to 3L), fishing = it.fishing?.copy(fishId = "fish")) }
        val hidden = EconomyPublicJobs.project(saved, now)
        val revealed = EconomyPublicJobs.project(saved, Instant.parse(saved.finishesAt))
        assertEquals(hidden.rewards, revealed.rewards)
        assertNull(hidden.fishing?.catchRevealed)
        assertEquals(true, revealed.fishing?.catchRevealed)
        assertNull(saved.fishing?.catchRevealed)
    }

    @Test fun `public reveal metadata preserves the old private catch JSON shape`() {
        val saved = job()
        fun fields(job: EconomyJob) = economyJson.parseToJsonElement(economyJson.encodeToString(job)).jsonObject.getValue("fishing").jsonObject
        val privateFields = fields(saved)
        assertEquals(setOf("rodId", "baitId", "fishId", "hookId"), privateFields.keys)
        assertNull(economyJson.decodeFromString<EconomyFishingCatch>(privateFields.toString()).catchRevealed)

        val revealed = EconomyPublicJobs.project(saved, Instant.parse(saved.finishesAt))
        assertEquals(true, fields(revealed).getValue("catchRevealed").jsonPrimitive.boolean)
        assertNull(economyJson.decodeFromString<EconomyJob>(economyJson.encodeToString(saved)).fishing?.catchRevealed)

        val stale = saved.copy(fishing = saved.fishing?.copy(catchRevealed = true))
        val concealed = EconomyPublicJobs.project(stale, now)
        assertFalse("catchRevealed" in fields(concealed))
        assertEquals(true, stale.fishing?.catchRevealed)
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
            assertEquals(EconomyFishInventory.items(saved.rewards), claimed.inventory)
            assertEquals(saved.rewards, claimed.fishing.catches)
            assertNull(claimed.fishingCastSeed)
        }
        assertEquals("ECONOMY_FISHING_ROD", assertFailsWith<AuthFailure> {
            EconomyRules.apply(initial.copy(fishing = initial.fishing.copy(equippedRodId = "unowned_rod")), command("start_exploration", "shore"), now)
        }.code)
    }
}
