package ru.zhiv.economy

import org.junit.jupiter.api.Test
import kotlin.test.*

class EconomyFishingTackleOddsTest {
    private val spec = checkNotNull(EconomyRules.catalog.fishing)
    private val rarities = listOf("common", "uncommon", "rare", "epic", "legendary")
    private fun chance(rod: String, hook: String, bait: String?, rarity: String): Double {
        val weights = EconomyRules.fishingClassWeights(rod, bait, hook)
        return weights.single { it.first.rarity == rarity }.second.toDouble() / weights.sumOf { it.second }
    }

    @Test fun `unmodified rods expose the exact five class probabilities`() {
        val expected = mapOf(
            "reed_rod" to listOf(8500, 1200, 300, 0, 0),
            "brook_rod" to listOf(3500, 5500, 900, 100, 0),
            "river_rod" to listOf(2500, 6500, 900, 100, 0),
            "willow_rod" to listOf(1500, 2000, 6000, 500, 0),
            "tide_rod" to listOf(1000, 1000, 1500, 6500, 0),
            "starfall_rod" to listOf(500, 1000, 1000, 1500, 6000),
            "traveller_rod" to listOf(1000, 4000, 4000, 1000, 0),
            "marsh_rod" to listOf(5000, 500, 500, 4000, 0),
            "dusk_rod" to listOf(500, 1000, 2000, 3500, 3000),
            "float_rod" to listOf(3500, 5500, 900, 100, 0),
            "predator_rod" to listOf(1500, 2000, 6000, 500, 0),
            "mirror_rod" to listOf(1000, 1000, 1500, 6500, 0),
            "abyss_rod" to listOf(500, 1000, 2000, 3500, 3000),
        )
        assertEquals(expected.keys, spec.rods.map { it.id }.toSet())
        for (rod in spec.rods) {
            assertEquals(expected.getValue(rod.id), rarities.map { checkNotNull(rod.classOddsBps)[it] })
            assertEquals(expected.getValue(rod.id), EconomyRules.fishingClassWeights(rod.id, null).map { it.second })
        }
    }

    @Test fun `travel tackle boosts its two intended classes without changing other raw weights`() {
        assertEquals(listOf(1000, 6760, 6760, 1000, 0),
            EconomyRules.fishingClassWeights("traveller_rod", "spice_bait", "braided_hook").map { it.second })
        assertEquals(listOf(500, 1000, 2000, 5687, 4875),
            EconomyRules.fishingClassWeights("dusk_rod", "dusk_bait", "dusk_hook").map { it.second })
    }

    @Test fun `rod probability model rejects missing extra negative oversized and unnormalised classes`() {
        val rod = spec.rods.first()
        val odds = checkNotNull(rod.classOddsBps)
        for (invalid in listOf(odds - "epic", odds + ("mythic" to 0), odds + ("epic" to -1),
            odds + ("common" to 10001), odds + ("common" to 8499)))
            assertFailsWith<IllegalArgumentException> { rod.copy(classOddsBps = invalid) }
        assertEquals(odds, rod.copy(classOddsBps = odds).classOddsBps)
        assertNull(rod.copy(classOddsBps = null).classOddsBps, "Legacy standalone rod records remain readable")
    }

    @Test fun `zero rod probabilities stay zero and legendary rod works with every hook`() {
        for (rod in spec.rods) for (hook in spec.hooks) for (bait in listOf<String?>(null) + spec.baits.map { it.itemId }) {
            val weights = EconomyRules.fishingClassWeights(rod.id, bait, hook.id)
            for ((tier, weight) in weights) {
                val eligible = checkNotNull(rod.classOddsBps).getValue(tier.rarity) > 0 &&
                    (tier.rarity != "legendary" || rod.rarity == "legendary")
                assertEquals(eligible, weight > 0, "${rod.id}/${hook.id}/$bait/${tier.rarity}")
            }
            assertTrue(weights.sumOf { it.second } > 0)
        }
        for (hook in spec.hooks) assertTrue(chance("starfall_rod", hook.id, null, "legendary") > 0)
        assertEquals(0.0, chance("reed_rod", "tide_hook", "firefly_bait", "epic"))
        assertEquals(0.0, chance("tide_rod", "leviathan_hook", "star_bait", "legendary"))
    }

    @Test fun `matching hook and bait make the target class dominant without reducing its rivals raw weights`() {
        val kits = listOf(
            listOf("river_rod", "barbed_hook", "worm_bait", "uncommon"),
            listOf("willow_rod", "silver_hook", "glow_bait", "rare"),
            listOf("tide_rod", "tide_hook", "firefly_bait", "epic"),
            listOf("starfall_rod", "leviathan_hook", "star_bait", "legendary"),
        )
        for ((rod, hook, bait, rarity) in kits) {
            val base = EconomyRules.fishingClassWeights(rod, null).associate { it.first.rarity to it.second }
            val boosted = EconomyRules.fishingClassWeights(rod, bait, hook).associate { it.first.rarity to it.second }
            for (other in rarities.filter { it != rarity }) assertEquals(base[other], boosted[other])
            assertEquals(base.getValue(rarity) * 225 / 100, boosted.getValue(rarity))
            assertTrue(chance(rod, hook, bait, rarity) > 0.75, rod)
        }
        assertEquals(listOf(500, 1000, 1000, 1500, 13500),
            EconomyRules.fishingClassWeights("starfall_rod", "star_bait", "leviathan_hook").map { it.second })
        assertEquals(13500.0 / 17500, chance("starfall_rod", "leviathan_hook", "star_bait", "legendary"))
    }

    @Test fun `legacy species stay uniform and explicit preferences stay within their own class`() {
        val legacy = spec.copy(rods = spec.rods.map { it.copy(speciesWeights = null) }, hooks = spec.hooks.map { it.copy(speciesWeights = null) })
        for (hook in spec.hooks) for (bait in listOf<String?>(null) + spec.baits.map { it.itemId }) {
            val weights = EconomyRules.fishingSpeciesWeights("tide_rod", "epic", hook.id, legacy)
            assertEquals(2, weights.size)
            assertTrue(weights.all { it.second > 0 })
            assertEquals(weights[0].second, weights[1].second)
        }
        val focused = EconomyRules.fishingSpeciesWeights("predator_rod", "rare", "weedless_hook")
        assertEquals(.75, focused.single { it.first.itemId == "fish_pike" }.second.toDouble() / focused.sumOf { it.second })
        assertTrue(focused.all { it.second > 0 })
        assertEquals(EconomyRules.fishingClassWeights("willow_rod", "glow_bait", "silver_hook"),
            EconomyRules.fishingClassWeights("predator_rod", "glow_bait", "weedless_hook"))
        val changed = spec.copy(fish = spec.fish.map { it.copy(weight = 9999, affinity = 10, requiredHookId = "nonexistent_legacy_hook") },
            classes = spec.classes.map { it.copy(weight = 1) }, rods = spec.rods.map { it.copy(rareBonus = 100) })
        assertEquals(EconomyRules.fishingClassWeights("tide_rod", "firefly_bait", "bare_hook"),
            EconomyRules.fishingClassWeights("tide_rod", "firefly_bait", "bare_hook", changed).mapIndexed { i, (_, weight) -> spec.classes[i] to weight })
    }

    @Test fun `legacy rod fallback is isolated from direct odds`() {
        val legacy = spec.copy(rods = spec.rods.map { it.copy(classOddsBps = null, rarityWeights = null) })
        assertEquals(spec.classes.map { if (it.rarity == "legendary") 0 else it.weight },
            EconomyRules.fishingClassWeights("reed_rod", null, spec = legacy).map { it.second })
        val fractional = spec.copy(rods = spec.rods.map { rod -> if (rod.id == "reed_rod")
            rod.copy(classOddsBps = checkNotNull(rod.classOddsBps) + mapOf("common" to 8401, "uncommon" to 1299)) else rod },
            hooks = spec.hooks.map { hook -> if (hook.id == "round_hook")
                hook.copy(rarityWeights = rarities.associateWith { if (it == "uncommon") 101 else 100 }) else hook })
        assertEquals(1311, EconomyRules.fishingClassWeights("reed_rod", null, "round_hook", fractional)
            .single { it.first.rarity == "uncommon" }.second)
    }

    @Test fun `shared UUID vectors match TypeScript class and species draws`() {
        val seeds = listOf("00000000-0000-4000-8000-000000000001", "a2f6bce4-1d99-4c0f-a910-656320724833", "ffffffff-ffff-4fff-bfff-ffffffffffff",
            "00000000-0000-4000-8000-00000000000f", "00000000-0000-4000-8000-00000000014a", "00000000-0000-4000-8000-000000000376")
        assertEquals(listOf("fish_shark", "fish_shark", "fish_shark", "fish_shark", "fish_shark", "fish_shark"), seeds.map { EconomyRules.selectFishingCatch(it, "starfall_rod", "star_bait", "leviathan_hook") })
        assertEquals(listOf("fish_mirror_koi", "fish_shark", "fish_sturgeon", "fish_shark", "fish_mirror_koi", "fish_shark"), seeds.map { EconomyRules.selectFishingCatch(it, "starfall_rod", "firefly_bait", "tide_hook") })
    }

    @Test fun `camp draw sequence matches TypeScript with eight independent class and species domains`() {
        assertEquals(listOf("fish_bream", "fish_bream", "fish_bream", "fish_bream", "fish_bream", "fish_bream", "fish_dace", "fish_bream"),
            (0 until 8).map { EconomyRules.selectFishingCatch("00000000-0000-4000-8000-000000000001", "river_rod", "worm_bait", "barbed_hook", it) })
        assertEquals(8, spec.collectionDrawsByRoute["shore_camp"])
    }

    @Test fun `species changes preserve every previous loadout economic class and stock`() {
        val legacy = spec.copy(rods = spec.rods.map { it.copy(speciesWeights = null) }, hooks = spec.hooks.map { it.copy(speciesWeights = null) })
        val oldRods = setOf("reed_rod", "brook_rod", "river_rod", "willow_rod", "tide_rod", "starfall_rod", "traveller_rod", "marsh_rod", "dusk_rod")
        val oldHooks = setOf("bare_hook", "round_hook", "barbed_hook", "silver_hook", "tide_hook", "leviathan_hook", "braided_hook", "dusk_hook")
        val rarity = spec.fish.associate { it.itemId to it.rarity }
        for (rod in spec.rods.filter { it.id in oldRods }) for (hook in spec.hooks.filter { it.id in oldHooks })
            for (bait in listOf<String?>(null) + spec.baits.map { it.itemId }) {
                val previous = (0 until 8).map { EconomyRules.selectFishingCatch("unchanged-class-0", rod.id, bait, hook.id, it, legacy) }
                val current = (0 until 8).map { EconomyRules.selectFishingCatch("unchanged-class-0", rod.id, bait, hook.id, it) }
                assertEquals(previous.map { rarity.getValue(it) }, current.map { rarity.getValue(it) })
                assertEquals(previous.groupingBy { "fish_${rarity.getValue(it)}" }.eachCount(), current.groupingBy { "fish_${rarity.getValue(it)}" }.eachCount())
            }
    }

    @Test fun `species ticket schema is bounded and optional for old catalog records`() {
        val rod = spec.rods.first()
        for (value in listOf(0, -1, 1001)) assertFailsWith<IllegalArgumentException> { rod.copy(speciesWeights = mapOf("fish" to value)) }
        assertNull(rod.copy(speciesWeights = null).speciesWeights)
        assertFailsWith<IllegalArgumentException> { rod.copy(speciesWeights = (0..100).associate { "fish_$it" to 100 }) }
    }

    @Test fun `new weighted species vectors match TypeScript without rerolling class`() {
        val seed = "00000000-0000-4000-8000-000000000001"
        assertEquals(listOf("fish_pike", "fish_pike", "fish_pike", "fish_pike", "fish_eel", "fish_pike", "fish_pike", "fish_pike"),
            (0 until 8).map { EconomyRules.selectFishingCatch(seed, "predator_rod", "glow_bait", "weedless_hook", it) })
        assertEquals(List(8) { "fish_mirror_koi" },
            (0 until 8).map { EconomyRules.selectFishingCatch(seed, "mirror_rod", "firefly_bait", "moth_hook", it) })
        assertEquals(listOf("fish_sturgeon", "fish_shark", "fish_sturgeon", "fish_sturgeon", "fish_shark", "fish_shark", "fish_sturgeon", "fish_shark"),
            (0 until 8).map { EconomyRules.selectFishingCatch(seed, "abyss_rod", "dusk_bait", "deep_hook", it) })
    }

    @Test fun `all new gear is available in both merchant catalogs at its existing class profile price`() {
        val leaf = checkNotNull(EconomyRules.catalog.leaftailShop)
        val newRods = setOf("float_rod", "predator_rod", "mirror_rod", "abyss_rod")
        val newHooks = setOf("spoon_hook", "weedless_hook", "moth_hook", "deep_hook")
        for ((kind, id, price) in spec.rods.filter { it.id in newRods }.map { Triple("rod", it.id, it.price) } +
            spec.hooks.filter { it.id in newHooks }.map { Triple("hook", it.id, it.price) }) {
            val offer = leaf.travelOffers.single { it.itemId == id }
            assertEquals(kind, offer.kind); assertEquals(price, offer.priceCoins)
            val rarity = if (kind == "rod") spec.rods.single { it.id == id }.rarity else spec.hooks.single { it.id == id }.rarity
            val state = EconomyRules.initial(homeLevel = 5).let { state -> state.copy(fishing = state.fishing.copy(
                ownedRods = spec.rods.filter { kind != "rod" || it.id != id }.map { it.id },
                ownedHooks = spec.hooks.filter { kind != "hook" || it.id != id }.map { it.id })) }
            val odds = spec.shop.gearRarityBpsByHome.last()
            val ticket = rarities.takeWhile { it != rarity }.sumOf { odds.getValue(it) }
            val shop = EconomyFishingShops.create(state, java.time.Instant.EPOCH, { max -> if (max == 10000) ticket else 0 })
            assertEquals(id, shop.offers.single { it.kind == kind }.itemId)
        }
    }
}
