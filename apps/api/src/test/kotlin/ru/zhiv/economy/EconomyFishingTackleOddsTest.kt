package ru.zhiv.economy

import org.junit.jupiter.api.Test
import kotlin.test.*

class EconomyFishingTackleOddsTest {
    @Test fun `shared UUID vectors exercise legendary tackle gate and match TypeScript`() {
        val seeds = listOf("00000000-0000-4000-8000-000000000001", "a2f6bce4-1d99-4c0f-a910-656320724833", "ffffffff-ffff-4fff-bfff-ffffffffffff",
            "00000000-0000-4000-8000-00000000000f", "00000000-0000-4000-8000-00000000014a", "00000000-0000-4000-8000-000000000376")
        assertEquals(listOf("fish", "fish", "fish_silverfin", "fish_shark", "fish_shark", "fish_shark"),
            seeds.map { EconomyRules.selectFishingCatch(it, "starfall_rod", "firefly_bait", "leviathan_hook") })
        assertEquals(listOf("fish", "fish", "fish_silverfin", "fish_mirror_koi", "fish_mirror_koi", "fish_mirror_koi"),
            seeds.map { EconomyRules.selectFishingCatch(it, "starfall_rod", "firefly_bait", "tide_hook") })
    }

    @Test fun `every legendary fish requires legendary rod and legendary hook before normalization`() {
        val catalog = checkNotNull(EconomyRules.catalog.fishing)
        for (rod in catalog.rods) for (hook in catalog.hooks) for (bait in listOf<String?>(null) + catalog.baits.map { it.itemId }) {
            val weights = EconomyRules.fishingWeights(rod.id, bait, hook.id)
            for ((fish, weight) in weights.filter { it.first.rarity == "legendary" }) {
                val eligible = rod.rarity == "legendary" && hook.rarity == "legendary" && (fish.requiredHookId == null || fish.requiredHookId == hook.id)
                assertEquals(eligible, weight > 0, "${rod.id}/${hook.id}/$bait/${fish.itemId}")
            }
            assertTrue(weights.sumOf { it.second } > 0)
        }
        for (index in 0..5000) {
            val seed = "00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}"
            assertNotEquals("fish_shark", EconomyRules.selectFishingCatch(seed, "reed_rod", "firefly_bait", "leviathan_hook"))
        }
        val weights = EconomyRules.fishingWeights("starfall_rod", "firefly_bait", "leviathan_hook")
        assertEquals(18, weights.single { it.first.itemId == "fish_shark" }.second)
        assertEquals(4572, weights.sumOf { it.second })
    }

    @Test fun `every lower hook excludes the shark even with the strongest rod and bait`() {
        val catalog = checkNotNull(EconomyRules.catalog.fishing)
        val bestHook = catalog.hooks.maxBy { it.rareBonus }
        assertEquals("leviathan_hook", bestHook.id)
        assertEquals(bestHook.id, catalog.fish.single { it.itemId == "fish_shark" }.requiredHookId)
        for (index in 0..5000) {
            val seed = "00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}"
            for (hook in catalog.hooks.filter { it.id != bestHook.id })
                assertNotEquals("fish_shark", EconomyRules.selectFishingCatch(seed, "starfall_rod", "firefly_bait", hook.id))
        }
    }

    private fun chance(rod: String, hook: String, bait: String?, rarity: String): Double {
        val weights = EconomyRules.fishingWeights(rod, bait, hook)
        return weights.filter { it.first.rarity == rarity }.sumOf { it.second }.toDouble() / weights.sumOf { it.second }
    }

    @Test fun `every rod and hook has its own strongest rarity target`() {
        val catalog = checkNotNull(EconomyRules.catalog.fishing)
        val roles = mapOf("reed_rod" to "common", "river_rod" to "uncommon", "willow_rod" to "rare", "tide_rod" to "epic", "starfall_rod" to "legendary",
            "bare_hook" to "common", "barbed_hook" to "uncommon", "silver_hook" to "rare", "tide_hook" to "epic", "leviathan_hook" to "legendary")
        val baits = listOf<String?>(null) + catalog.baits.map { it.itemId }
        for (hook in catalog.hooks) for (bait in baits) for (rod in catalog.rods.filter { roles.containsKey(it.id) }) {
            val rarity = checkNotNull(roles[rod.id])
            if (rarity == "legendary" && hook.rarity != "legendary") continue
            for (other in catalog.rods.filter { it.id != rod.id })
                assertTrue(chance(rod.id, hook.id, bait, rarity) > chance(other.id, hook.id, bait, rarity), rod.id)
        }
        for (rod in catalog.rods) for (bait in baits) for (hook in catalog.hooks.filter { roles.containsKey(it.id) }) {
            val rarity = checkNotNull(roles[hook.id])
            if (rarity == "legendary" && rod.rarity != "legendary") continue
            for (other in catalog.hooks.filter { it.id != hook.id })
                assertTrue(chance(rod.id, hook.id, bait, rarity) > chance(rod.id, other.id, bait, rarity), hook.id)
        }
    }

    @Test fun `camp draw sequence matches TypeScript and is not six correlated adjacent hashes`() {
        assertEquals(listOf("fish", "fish_reedperch", "fish_reedperch", "fish", "fish_bream", "fish_bream"),
            (0 until 6).map { EconomyRules.selectFishingCatch("00000000-0000-4000-8000-000000000001", "river_rod", "worm_bait", "barbed_hook", it) })
        assertEquals(6, checkNotNull(EconomyRules.catalog.fishing).collectionDrawsByRoute["shore_camp"])
    }
}
