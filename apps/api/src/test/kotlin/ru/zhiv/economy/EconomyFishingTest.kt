package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyFishingTest {
    private val now = Instant.parse("2026-10-04T20:00:00Z")
    private fun command(action: String, target: String, quantity: Long = 1, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity, price)
    private fun apply(state: EconomyState, action: String, target: String, quantity: Long = 1, price: Long = 0, at: Instant = now) =
        EconomyRules.apply(state, command(action, if (action == "buy_fishing_item") offerId(state, target) else target, quantity, price), at).first
    private fun offerId(state: EconomyState, itemId: String) = state.fishingShop?.offers?.find { it.itemId == itemId }?.id ?: itemId
    private fun funded(): EconomyState {
        val state = EconomyRules.initial().copy(wallet = EconomyWallet(100_000))
        return state.copy(fishingShop = EconomyFishingShops.create(state, now, { 0 }))
    }

    @Test fun `old persisted json gets starter tackle without importing inventory as catches`() {
        val initial = EconomyRules.initial().copy(inventory = mapOf("fish" to 50L))
        val json = economyJson.encodeToJsonElement(initial).jsonObject
        val restored = economyJson.decodeFromJsonElement<EconomyState>(JsonObject(json - setOf("fishing", "fishingCastSeed")))
        assertEquals(EconomyFishing(), restored.fishing)
        assertNull(restored.fishingCastSeed)
        assertEquals(50L, restored.inventory["fish"])
    }

    @Test fun `shared catalog has no immediate arbitrage and UUID draw vectors match TypeScript`() {
        val spec = checkNotNull(EconomyRules.catalog.fishing)
        spec.fish.forEach { fish -> assertTrue(fish.buyPrice > EconomyRules.catalog.items.single { it.id == fish.itemId }.baseSellPrice) }
        spec.baits.forEach { bait -> assertTrue(bait.price > EconomyRules.catalog.items.single { it.id == bait.itemId }.baseSellPrice) }
        assertEquals(listOf("fish", "fish", "fish_silverfin"),
            listOf("00000000-0000-4000-8000-000000000001", "a2f6bce4-1d99-4c0f-a910-656320724833", "ffffffff-ffff-4fff-bfff-ffffffffffff")
                .map { EconomyRules.selectFishingCatch(it, "willow_rod", "worm_bait") })
    }

    @Test fun `same private draw and tackle is stable`() {
        val seed = "00000000-0000-4000-8000-000000000038"
        for (rod in checkNotNull(EconomyRules.catalog.fishing).rods)
            for (bait in listOf(null, "crumb_bait", "worm_bait"))
                assertEquals(EconomyRules.selectFishingCatch(seed, rod.id, bait), EconomyRules.selectFishingCatch(seed, rod.id, bait))
    }

    @Test fun `shop charges server quote rods stay unique and purchased fish never counts as caught`() {
        val initial = funded()
        val rod = apply(initial, "buy_fishing_item", "river_rod", price = 18050)
        assertEquals(82000L, rod.wallet.coins)
        assertEquals(listOf("reed_rod", "river_rod"), rod.fishing.ownedRods)
        assertEquals(initial.inventory, rod.inventory)
        assertEquals("ECONOMY_FISHING_OWNED", assertFailsWith<AuthFailure> { apply(rod, "buy_fishing_item", "river_rod", price = 18000) }.code)
        assertEquals("ECONOMY_FISHING_SHOP_CHANGED", assertFailsWith<AuthFailure> {
            apply(rod, "buy_fishing_item", "fish_mooncarp", quantity = 2, price = 1280)
        }.code)
        val bought = rod.copy(inventory = mapOf("fish_mooncarp" to 2L))
        assertEquals(2L, bought.inventory["fish_mooncarp"])
        assertTrue(bought.fishing.catches.isEmpty())
        val sold = apply(bought, "sell_fish", "fish_mooncarp", quantity = 2)
        assertEquals(82640L, sold.wallet.coins)
        assertTrue(sold.fishing.catches.isEmpty())
        assertEquals("ECONOMY_FISHING_ITEM", assertFailsWith<AuthFailure> { apply(sold, "sell_fish", "wood") }.code)
    }

    @Test fun `bad quotes unknown goods unsupported quantities inventory and escrow limits are rejected`() {
        val initial = funded()
        assertEquals("ECONOMY_FISHING_PRICE_CHANGED", assertFailsWith<AuthFailure> { apply(initial, "buy_fishing_item", "river_rod", price = 17990) }.code)
        assertEquals("ECONOMY_FISHING_SHOP_CHANGED", assertFailsWith<AuthFailure> { apply(initial, "buy_fishing_item", "wood", price = 1000) }.code)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { apply(initial, "buy_fishing_item", "river_rod", quantity = 2, price = 36000) }.code)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { apply(initial, "buy_fishing_item", "crumb_bait", quantity = 11, price = 330) }.code)
        val full = initial.copy(inventory = mapOf("wood" to 190L))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.apply(full, command("buy_fishing_item", offerId(full, "crumb_bait"), price = 30), now, mapOf("stone" to 10L))
        }.code)
        val rod = EconomyRules.apply(full, command("buy_fishing_item", offerId(full, "river_rod"), price = 18000), now, mapOf("stone" to 10L)).first
        assertEquals(full.inventory, rod.inventory)
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { apply(funded().copy(wallet = EconomyWallet()), "buy_fishing_item", "river_rod", price = 18000) }.code)
        for (invalid in listOf(command("equip_fishing_rod", "reed_rod", quantity = 2), command("sell_fish", "fish", price = 1)))
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { EconomyRules.apply(initial, invalid, now) }.code)
    }

    @Test fun `fishing locks equipment and one replacement species while claims alone advance collection`() {
        var state = funded()
        assertEquals("ECONOMY_FISHING_ROD", assertFailsWith<AuthFailure> { apply(state, "equip_fishing_rod", "willow_rod") }.code)
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { apply(state, "equip_fishing_bait", "worm_bait") }.code)
        state = apply(state, "buy_fishing_item", "river_rod", price = 18000)
        state = apply(state, "equip_fishing_rod", "river_rod")
        state = apply(state, "buy_fishing_item", "worm_bait", quantity = 2, price = 140)
        state = apply(state, "equip_fishing_bait", "worm_bait")
        assertEquals("ECONOMY_FISHING_ROUTE", assertFailsWith<AuthFailure> { apply(state, "start_fishing", "forest") }.code)
        val start = command("start_fishing", "shore")
        val active = EconomyRules.apply(state, start, now).first
        val job = active.jobs.single()
        assertNotEquals(start.requestId, job.id, "the client does not pick a reward by choosing requestId")
        assertNotEquals(active.fishingCastSeed, job.id, "public job IDs do not reveal the hidden draw seed")
        assertEquals(1L, active.inventory["worm_bait"])
        assertEquals(4L, job.rewards.values.sum())
        assertEquals("river_rod", job.fishing?.rodId)
        assertEquals("worm_bait", job.fishing?.baitId)
        assertTrue(active.fishing.catches.isEmpty())
        val changed = apply(apply(active, "equip_fishing_rod", "reed_rod"), "equip_fishing_bait", "none")
        assertEquals(job, changed.jobs.single())
        val claimed = apply(changed, "claim_job", job.id, at = Instant.parse(job.finishesAt))
        assertEquals(job.rewards, claimed.fishing.catches)
        assertNull(claimed.fishingCastSeed)
        assertEquals(claimed.fishing.catches, apply(claimed, "sell_fish", "fish", quantity = job.rewards.getValue("fish")).fishing.catches)
        val next = apply(claimed, "start_fishing", "shore")
        assertNotEquals(active.fishingCastSeed, next.fishingCastSeed)
    }

    @Test fun `cancel retains draw across new server UUIDs forfeits bait and cannot farm rare rerolls`() {
        val equipped = funded().copy(inventory = mapOf("crumb_bait" to 1L), fishing = EconomyFishing(equippedBaitId = "crumb_bait"))
        val started = apply(equipped, "start_fishing", "shore")
        val first = started.jobs.single()
        val cancelled = apply(started, "cancel_exploration", first.id)
        assertEquals(started.fishingCastSeed, cancelled.fishingCastSeed)
        assertTrue(cancelled.fishing.catches.isEmpty())
        assertTrue(cancelled.inventory.isEmpty())
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { apply(cancelled, "start_fishing", "shore") }.code)
        val replenished = apply(cancelled, "buy_fishing_item", "crumb_bait", price = 30)
        val retry = apply(replenished, "start_fishing", "shore")
        assertNotEquals(first.id, retry.jobs.single().id)
        assertEquals(first.fishing?.fishId, retry.jobs.single().fishing?.fishId)
        val abandoned = apply(retry, "cancel_exploration", retry.jobs.single().id, at = Instant.parse(first.finishesAt))
        assertEquals(0L, abandoned.completedExplorations)
        assertTrue(abandoned.fishing.catches.isEmpty())
        val noBait = apply(abandoned, "equip_fishing_bait", "none")
        val free = apply(noBait, "start_fishing", "shore")
        val another = apply(apply(free, "cancel_exploration", free.jobs.single().id), "start_fishing", "shore")
        assertEquals(free.jobs.single().fishing?.fishId, another.jobs.single().fishing?.fishId)
    }

    @Test fun `old shore jobs count actual delivered fish and catch metadata cannot be forged in commands`() {
        // Compatibility concerns already-persisted jobs, not newly issued
        // shore commands: those now all validate gear and use fishing draws.
        val job = EconomyJob(UUID.randomUUID().toString(), "exploration", "shore", startedAt = now.toString(),
            finishesAt = now.plusSeconds(2700).toString(), rewards = mapOf("fish" to 4L),
            cost = EconomyCost(0, emptyMap()), catalogVersion = 3)
        val started = EconomyRules.initial().copy(jobs = listOf(job))
        assertNull(job.fishing)
        val claimed = apply(started, "claim_job", job.id, at = Instant.parse(job.finishesAt))
        assertEquals(mapOf("fish" to 4L), claimed.fishing.catches)
        val request = economyJson.encodeToJsonElement(command("start_fishing", "shore")).jsonObject
        for (field in listOf("fishing", "fishingCastSeed", "rewards", "catches"))
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
                decodeEconomyCommand(JsonObject(request + (field to JsonPrimitive("fish_mooncarp"))))
            }.code)
        assertEquals(claimed, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(claimed)))
    }

    @Test fun `hooks remain durable unique purchases and saved fishing never adopts later loadout changes`() {
        val homeTwo = funded().copy(buildings = funded().buildings + ("home" to 2))
        val initial = homeTwo.copy(fishingShop = EconomyFishingShops.create(homeTwo, now, { it - 1 }))
        assertEquals("ECONOMY_FISHING_HOOK", assertFailsWith<AuthFailure> { apply(initial, "equip_fishing_hook", "silver_hook") }.code)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { apply(initial, "buy_fishing_item", "silver_hook", 2, 84000) }.code)
        val purchased = apply(initial, "buy_fishing_item", "silver_hook", price = 42000)
        assertEquals(58000L, purchased.wallet.coins); assertEquals(initial.inventory, purchased.inventory)
        assertEquals(listOf("bare_hook", "silver_hook"), purchased.fishing.ownedHooks)
        assertEquals("ECONOMY_FISHING_OWNED", assertFailsWith<AuthFailure> { apply(purchased, "buy_fishing_item", "silver_hook", price = 42000) }.code)
        val equipped = apply(purchased, "equip_fishing_hook", "silver_hook")
        val active = apply(equipped, "start_fishing", "shore"); val job = active.jobs.single()
        assertEquals("silver_hook", job.fishing?.hookId)
        assertEquals(4L, job.rewards.values.sum())
        assertEquals(2700L, java.time.Duration.between(Instant.parse(job.startedAt), Instant.parse(job.finishesAt)).seconds)
        val changed = apply(active, "equip_fishing_hook", "bare_hook")
        assertEquals(job, changed.jobs.single())
        val retry = apply(apply(apply(changed, "cancel_exploration", job.id), "equip_fishing_hook", "silver_hook"), "start_fishing", "shore")
        assertEquals(job.fishing?.fishId, retry.jobs.single().fishing?.fishId)
        val legacy = economyJson.encodeToJsonElement(equipped.fishing).jsonObject
        val restored = economyJson.decodeFromJsonElement<EconomyFishing>(JsonObject(legacy - setOf("ownedHooks", "equippedHookId")))
        assertEquals(listOf("bare_hook"), restored.ownedHooks); assertEquals("bare_hook", restored.equippedHookId)
    }

    @Test fun `twelve fish span five rarities and only Leviathan admits the shark`() {
        val spec = checkNotNull(EconomyRules.catalog.fishing)
        assertEquals(12, spec.fish.size)
        assertEquals(setOf("common", "uncommon", "rare", "epic", "legendary"), spec.fish.map { it.rarity }.toSet())
        assertEquals("fish_shark", spec.fish.single { it.rarity == "legendary" }.itemId)
        assertEquals(10000, spec.fish.sumOf { it.weight })
        for (hook in spec.hooks) assertEquals(hook.id == "leviathan_hook",
            EconomyRules.fishingWeights("starfall_rod", "firefly_bait", hook.id).single { it.first.itemId == "fish_shark" }.second > 0)
    }

    @Test fun `overnight catch has six saved draws and only successful claim advances collection`() {
        val seed = "00000000-0000-4000-8000-000000000001"
        val initial = funded().copy(inventory = mapOf("worm_bait" to 2L), fishingCastSeed = seed,
            fishing = EconomyFishing(ownedRods = listOf("reed_rod", "river_rod"), equippedRodId = "river_rod", equippedBaitId = "worm_bait",
                ownedHooks = listOf("bare_hook", "barbed_hook"), equippedHookId = "barbed_hook"))
        val active = apply(initial, "start_fishing", "shore_camp")
        val job = active.jobs.single()
        assertEquals(mapOf("fish" to 20L, "fish_reedperch" to 2L, "fish_bream" to 2L), job.rewards)
        assertEquals(1L, active.inventory["worm_bait"])
        val changed = apply(active, "equip_fishing_rod", "reed_rod")
        assertEquals(job, changed.jobs.single())
        val cancelled = apply(changed, "cancel_exploration", job.id)
        assertTrue(cancelled.fishing.catches.isEmpty())
        val retry = apply(apply(cancelled, "equip_fishing_rod", "river_rod"), "start_fishing", "shore_camp")
        assertEquals(job.rewards, retry.jobs.single().rewards)
        val done = apply(retry, "claim_job", retry.jobs.single().id, at = Instant.parse(retry.jobs.single().finishesAt))
        assertEquals(job.rewards, done.fishing.catches)
        assertEquals(1L, done.completedExplorations)
        assertNull(done.fishingCastSeed)
    }
}
