package ru.zhiv.economy

import org.junit.jupiter.api.Test
import kotlin.test.*

class EconomyFishingTackleOddsTest {
    @Test fun `shared UUID vectors exercise legendary hook gate and match TypeScript`() {
        val seeds = listOf("00000000-0000-4000-8000-000000000001", "a2f6bce4-1d99-4c0f-a910-656320724833", "ffffffff-ffff-4fff-bfff-ffffffffffff",
            "00000000-0000-4000-8000-00000000000f", "00000000-0000-4000-8000-00000000014a", "00000000-0000-4000-8000-000000000376")
        assertEquals(listOf("fish", "fish", "fish_silverfin", "fish_shark", "fish_shark", "fish_shark"),
            seeds.map { EconomyRules.selectFishingCatch(it, "starfall_rod", "firefly_bait", "leviathan_hook") })
        assertEquals(listOf("fish", "fish", "fish_silverfin", "fish_mirror_koi", "fish_mirror_koi", "fish_mirror_koi"),
            seeds.map { EconomyRules.selectFishingCatch(it, "starfall_rod", "firefly_bait", "tide_hook") })
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
        val roles = listOf("common", "uncommon", "rare", "epic", "legendary")
        val baits = listOf<String?>(null) + catalog.baits.map { it.itemId }
        for (hook in catalog.hooks) for (bait in baits) for ((index, rod) in catalog.rods.withIndex()) {
            if (roles[index] == "legendary" && hook.id != "leviathan_hook") continue
            for (other in catalog.rods.filter { it.id != rod.id })
                assertTrue(chance(rod.id, hook.id, bait, roles[index]) > chance(other.id, hook.id, bait, roles[index]), rod.id)
        }
        for (rod in catalog.rods) for (bait in baits) for ((index, hook) in catalog.hooks.withIndex()) {
            for (other in catalog.hooks.filter { it.id != hook.id })
                assertTrue(chance(rod.id, hook.id, bait, roles[index]) > chance(rod.id, other.id, bait, roles[index]), hook.id)
        }
    }

    @Test fun `camp draw sequence matches TypeScript and is not six correlated adjacent hashes`() {
        assertEquals(listOf("fish", "fish_reedperch", "fish_reedperch", "fish", "fish_bream", "fish_bream"),
            (0 until 6).map { EconomyRules.selectFishingCatch("00000000-0000-4000-8000-000000000001", "river_rod", "worm_bait", "barbed_hook", it) })
        assertEquals(6, checkNotNull(EconomyRules.catalog.fishing).collectionDrawsByRoute["shore_camp"])
    }
}
