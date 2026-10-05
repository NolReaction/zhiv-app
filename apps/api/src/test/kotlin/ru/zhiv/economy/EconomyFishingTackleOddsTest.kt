package ru.zhiv.economy

import org.junit.jupiter.api.Test
import kotlin.test.*

class EconomyFishingTackleOddsTest {
    @Test fun `shared UUID vectors exercise legendary hook gate and match TypeScript`() {
        val seeds = listOf("00000000-0000-4000-8000-000000000001", "a2f6bce4-1d99-4c0f-a910-656320724833", "ffffffff-ffff-4fff-bfff-ffffffffffff",
            "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-000000000284", "00000000-0000-4000-8000-000000000296")
        assertEquals(listOf("fish_reedperch", "fish_silverfin", "fish", "fish_shark", "fish_shark", "fish_shark"),
            seeds.map { EconomyRules.selectFishingCatch(it, "starfall_rod", "firefly_bait", "leviathan_hook") })
        assertEquals(listOf("fish_reedperch", "fish_silverfin", "fish", "fish_mirror_koi", "fish_mirror_koi", "fish_mirror_koi"),
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

    @Test fun `all component upgrades preserve or improve the saved species rank`() {
        val catalog = checkNotNull(EconomyRules.catalog.fishing)
        val baits = listOf<String?>(null) + catalog.baits.map { it.itemId }
        for (index in 0..500) {
            val seed = "00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}"
            fun rank(rod: String, hook: String, bait: String?): Int = catalog.fish.indexOfFirst {
                it.itemId == EconomyRules.selectFishingCatch(seed, rod, bait, hook)
            }
            fun ordered(ranks: List<Int>) = assertTrue(ranks.zipWithNext().all { (a, b) -> a <= b })
            for (hook in catalog.hooks) for (bait in baits) ordered(catalog.rods.map { rank(it.id, hook.id, bait) })
            for (rod in catalog.rods) for (bait in baits) ordered(catalog.hooks.map { rank(rod.id, it.id, bait) })
            for (rod in catalog.rods) for (hook in catalog.hooks) ordered(baits.map { rank(rod.id, hook.id, it) })
        }
    }
}
