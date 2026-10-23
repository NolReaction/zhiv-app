package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyTradeRelationsTest {
    private val now = Instant.parse("2026-10-23T12:00:00Z")
    private val catalog = EconomyRules.catalog
    private fun command(action: String, target: String, price: Long = 0, quantity: Long = 1) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity, price)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, price: Long = 0, quantity: Long = 1) =
        EconomyRules.apply(state, command(action, target, price, quantity), at).first
    private fun stocked() = EconomyRules.initial().copy(wallet = EconomyWallet(10_000_000, 100_000),
        buildings = catalog.buildings.associate { it.id to it.levels.last().level },
        inventory = catalog.items.filter { item -> catalog.fishing!!.fish.none { it.itemId == item.id } }.associate { it.id to 1000L },
        fishing = EconomyFishing(ownedRods = catalog.fishing!!.rods.map { it.id }, ownedHooks = catalog.fishing.hooks.map { it.id }),
        progression = EconomyProgression(recipes = catalog.recipes.associate { it.id to 100L }))
    private fun failure(code: String, block: () -> Unit) { assertEquals(code, assertFailsWith<AuthFailure>(block = block).code) }
    private fun maximum(state: EconomyState = stocked()) = state.copy(tradeRelations = EconomyTradeRelationsState(
        reputation = tradeResidentIds.associateWith { 4200L }))

    @Test fun `old saves default friendship without retroactive experience and roundtrip new promises`() {
        val old = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(stocked())).jsonObject - "tradeRelations")
        val restored = economyJson.decodeFromString<EconomyState>(old.toString())
        assertEquals(EconomyTradeRelationsState(), restored.tradeRelations)
        val legacyCounters = restored.copy(residentOrders = restored.residentOrders.copy(completed = 100_000, earnedCoins = 1_000_000))
        assertEquals(0, EconomyTradeRelations.bonusBps(legacyCounters, "builder"))
        val candidate = EconomyTradeRelations.weeklyBoard(restored, now).offers.first()
        val accepted = apply(restored, "accept_weekly_order", candidate.id)
        assertEquals(accepted, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(accepted)))
        assertEquals(3, accepted.tradeRelations.weekly!!.stages.size)
    }

    @Test fun `every introduced resident gets a personal ordinary card while closed sources stay absent`() {
        val all = EconomyFood.residentOrderBoard(stocked(), now).offers
        assertEquals(tradeResidentIds.toSet(), all.map { it.residentId }.toSet())
        assertEquals(5, all.size)
        val starter = EconomyFood.residentOrderBoard(EconomyRules.initial(), now).offers
        assertEquals(setOf("builder", "plesk"), starter.map { it.residentId }.toSet())
        assertTrue(starter.all { it.reputationXp != null && it.effortSeconds != null })
        assertTrue(EconomyTradeRelations.weeklyBoard(EconomyRules.initial(), now).offers.isEmpty(), "A weekly cannot require unavailable workstations")
    }

    @Test fun `version two cards retain exact IDs and money while missing neighbors are appended`() {
        val source = stocked()
        val legacyCatalog = catalog.copy(tradeRelations = null, food = catalog.food!!.copy(orders = catalog.food.orders.copy(slots = 3,
            templates = catalog.food.orders.templates.filter { it.residentId in setOf("builder", "plesk") }.map {
                it.copy(reputationXp = null, effortSeconds = null, manufacturingSeconds = null, fishingUncertain = null)
            })))
        val old = EconomyFood.normalizedOrders(source, now, legacyCatalog)
        val pinned = source.copy(residentOrders = old)
        val before = EconomyFood.residentOrderBoard(pinned, now, legacyCatalog).offers
        val migrated = EconomyFood.residentOrderBoard(pinned, now)
        before.forEach { promise ->
            val kept = migrated.offers.single { it.id == promise.id }
            assertEquals(promise.items, kept.items); assertEquals(promise.coins, kept.coins)
            assertNull(kept.reputationXp)
        }
        assertEquals(tradeResidentIds.toSet(), migrated.offers.map { it.residentId }.toSet())
        assertTrue(migrated.offers.size <= 7)
        val completed = apply(pinned, "complete_resident_order", before.first().id)
        assertEquals(0L, completed.tradeRelations.reputation[before.first().residentId] ?: 0L)
        val fresh = EconomyFood.normalizedOrders(completed, now.plusSeconds(catalog.food.orders.refreshSeconds))
        assertEquals(5, fresh.slots.size)
        assertEquals(3, fresh.version)
    }

    @Test fun `retiring a duplicate migrated card is free after quota exhaustion with an empty pearl wallet`() {
        val source = stocked().copy(wallet = EconomyWallet(10_000_000, 0))
        val legacyCatalog = catalog.copy(tradeRelations = null, food = catalog.food!!.copy(orders = catalog.food.orders.copy(slots = 3,
            templates = catalog.food.orders.templates.filter { it.residentId in setOf("builder", "plesk") })))
        val old = EconomyFood.normalizedOrders(source, now, legacyCatalog)
        val pinned = source.copy(residentOrders = old.copy(freeReplacementsUsed = catalog.food.orders.freeReplacements))
        val board = EconomyFood.residentOrderBoard(pinned, now)
        val duplicate = board.offers.groupBy { it.residentId }.values.first { it.size > 1 }.last()
        val replaced = apply(pinned, "replace_resident_order", duplicate.id)
        assertEquals(0L, replaced.wallet.pearls)
        assertEquals(catalog.food.orders.freeReplacements, replaced.residentOrders.freeReplacementsUsed)
        assertTrue(replaced.residentOrders.slots[duplicate.slot].retired)
        assertNull(replaced.residentOrders.slots[duplicate.slot].terms)
        assertEquals(5, EconomyFood.residentOrderBoard(replaced, now).offers.size)
        assertEquals(pinned.wallet.coins, replaced.wallet.coins)
        assertEquals(pinned.tradeRelations, replaced.tradeRelations)
    }

    @Test fun `ordinary reputation is capped by resident and UTC day and failed commands grant nothing`() {
        var state = stocked()
        repeat(50) {
            val offer = EconomyFood.residentOrderBoard(state, now).offers.single { it.residentId == "builder" }
            state = apply(state, "complete_resident_order", offer.id)
        }
        assertEquals(60L, state.tradeRelations.reputation["builder"])
        assertEquals(60L, state.tradeRelations.dailyOrderXp["builder"])
        val before = economyJson.encodeToString(state)
        val offer = EconomyFood.residentOrderBoard(state, now).offers.single { it.residentId == "builder" }
        failure("ECONOMY_RESOURCES") { apply(state.copy(inventory = emptyMap()), "complete_resident_order", offer.id) }
        assertEquals(before, economyJson.encodeToString(state))
        val nextDay = now.plusSeconds(86400)
        val next = EconomyFood.residentOrderBoard(state, nextDay).offers.single { it.residentId == "builder" }
        val completed = apply(state, "complete_resident_order", next.id, nextDay)
        assertEquals(60L + next.reputationXp!!, completed.tradeRelations.reputation["builder"])
        assertEquals(next.reputationXp.toLong(), completed.tradeRelations.dailyOrderXp["builder"])
        assertEquals(0L, completed.tradeRelations.reputation["plesk"] ?: 0L)
    }

    @Test fun `one selected weekly freezes three stages pays each once and retains seven day fence`() {
        var state = stocked()
        val selected = EconomyTradeRelations.weeklyBoard(state, now).offers.single { it.residentId == "lopukh" }
        val beforeCoins = state.wallet.coins
        state = apply(state, "accept_weekly_order", selected.id)
        assertEquals(now.plusSeconds(604800), Instant.parse(state.tradeRelations.weeklyAvailableAt))
        assertEquals(beforeCoins, state.wallet.coins)
        failure("ECONOMY_WEEKLY_UNAVAILABLE") { apply(state, "accept_weekly_order", selected.id) }
        val promised = state.tradeRelations.weekly!!.stages
        val changedCatalog = catalog.copy(tradeRelations = catalog.tradeRelations!!.copy(weekly = catalog.tradeRelations.weekly.copy(
            templates = catalog.tradeRelations.weekly.templates.map { it.copy(stages = it.stages.map { stage -> stage.copy(coins = 1) }) })))
        assertEquals(promised.first().coins, EconomyTradeRelations.weeklyBoard(state, now, changedCatalog).active!!.coins)
        val disabled = EconomyTradeRelations.weeklyBoard(state, now, catalog.copy(tradeRelations = null))
        assertEquals(EconomyTradeRelations.weeklyBoard(state, now).active, disabled.active)
        assertFalse(disabled.canChoose, "Disabling new reputation content cannot erase a saved delivery promise")
        repeat(3) { index ->
            val active = EconomyTradeRelations.weeklyBoard(state, now).active!!
            assertEquals(promised[index].items, active.items)
            val previous = state
            state = apply(state, "complete_resident_order", active.id)
            assertEquals(previous.wallet.coins + promised[index].coins, state.wallet.coins)
            assertEquals(promised.take(index + 1).sumOf { it.reputationXp!!.toLong() }, state.tradeRelations.reputation["lopukh"])
            failure("ECONOMY_WEEKLY_CHANGED") { apply(state, "complete_resident_order", active.id) }
        }
        assertNull(state.tradeRelations.weekly)
        assertEquals(1L, state.tradeRelations.completedWeekly)
        assertEquals(beforeCoins + selected.coins, state.wallet.coins)
        assertTrue(state.tradeRelations.dailyOrderXp.isEmpty(), "Weekly XP has its own seven day cadence")
        assertFalse(EconomyTradeRelations.weeklyBoard(state, now.plusSeconds(604799)).canChoose)
        assertTrue(EconomyTradeRelations.weeklyBoard(state, now.plusSeconds(604800)).canChoose)
    }

    @Test fun `expired weekly keeps paid stages and cannot pay an old stage after its deadline`() {
        val selected = EconomyTradeRelations.weeklyBoard(stocked(), now).offers.first()
        val accepted = apply(stocked(), "accept_weekly_order", selected.id)
        val first = EconomyTradeRelations.weeklyBoard(accepted, now).active!!
        val paid = apply(accepted, "complete_resident_order", first.id)
        val next = EconomyTradeRelations.weeklyBoard(paid, now).active!!
        val expiredAt = now.plusSeconds(604800)
        failure("ECONOMY_WEEKLY_EXPIRED") { apply(paid, "complete_resident_order", next.id, expiredAt) }
        val board = EconomyTradeRelations.weeklyBoard(paid, expiredAt)
        assertNull(board.active); assertTrue(board.canChoose)
        assertEquals(accepted.wallet.coins + first.coins, paid.wallet.coins)
        assertEquals(first.reputationXp!!.toLong(), paid.tradeRelations.reputation[selected.residentId])
    }

    @Test fun `new work uses one role bonus and additive food while saved timers and feeding retain frozen bonus`() {
        val state = maximum(stocked().copy(buildings = stocked().buildings + ("warehouse" to 1)))
        val upgrade = catalog.buildings.single { it.id == "warehouse" }.levels.single { it.level == 2 }
        val builder = apply(apply(state, "feed_builder", "fish_soup"), "start_construction", "warehouse")
        assertEquals(1000, builder.jobs.single().tradeSpeedBps)
        assertEquals(now.plusSeconds(EconomyFood.workDuration(upgrade.seconds, 2500, 1000)), Instant.parse(builder.jobs.single().finishesAt))
        val running = apply(state, "start_construction", "warehouse")
        val feedAt = now.plusSeconds(60)
        val noCurrentFriendship = running.copy(tradeRelations = EconomyTradeRelationsState())
        val remaining = java.time.Duration.between(feedAt, Instant.parse(running.jobs.single().finishesAt)).toMillis()
        val fed = apply(noCurrentFriendship, "feed_builder", "fish_soup", feedAt)
        assertEquals(feedAt.plusMillis(EconomyFood.fedConstructionDuration(remaining, 2500, 1000)), Instant.parse(fed.jobs.single().finishesAt))
        val wood = apply(maximum(), "start_production", "gather_wood")
        val woodSeconds = catalog.recipes.single { it.id == "gather_wood" }.seconds
        assertEquals(now.plusSeconds(EconomyFood.workDuration(woodSeconds, 0, 1000)), Instant.parse(wood.jobs.single().finishesAt))
        val mining = apply(maximum(), "start_exploration", "quarry_stone")
        assertEquals(now.plusSeconds(EconomyFood.workDuration(180, 0, 1000)), Instant.parse(mining.jobs.single().finishesAt))
        assertEquals(1000, EconomyPublicJobs.project(mining.jobs.single(), now).tradeSpeedBps)
        assertEquals(0, apply(maximum(), "start_production", "grow_berries").jobs.single().tradeSpeedBps)
    }

    @Test fun `merchant discounts use the pre purchase rank and never discount fish or ordinary supplies`() {
        val base = maximum(stocked().copy(inventory = emptyMap()))
        val shop = EconomyFishingShop(UUID.randomUUID().toString(), now.toString(), now.plusSeconds(3600).toString(), 100,
            listOf(EconomyFishingOffer("bait", "bait", "crumb_bait", 20, 5), EconomyFishingOffer("fish", "fish", "fish_common", 120, 6)))
        val state = base.copy(fishingShop = shop)
        val bought = apply(state, "buy_fishing_item", "bait", price = 40, quantity = 2)
        assertEquals(36L, state.wallet.coins - bought.wallet.coins)
        assertEquals(20L, bought.fishingShop!!.offers.first().unitPrice, "Saved base shelf price cannot be discounted twice")
        val fish = apply(state, "buy_fishing_item", "fish", price = 120)
        assertEquals(120L, state.wallet.coins - fish.wallet.coins)
        val threshold = state.copy(tradeRelations = EconomyTradeRelationsState(reputation = mapOf("plesk" to 149)))
        val crossed = apply(threshold, "buy_fishing_item", "bait", price = 20)
        assertEquals(20L, threshold.wallet.coins - crossed.wallet.coins)
        assertEquals(150L, crossed.tradeRelations.reputation["plesk"])
        failure("ECONOMY_FISHING_PRICE_CHANGED") { apply(threshold, "buy_fishing_item", "bait", price = 19) }
        assertEquals(149L, threshold.tradeRelations.reputation["plesk"])
        val spec = catalog.leaftailShop!!
        val stock = EconomyLeaftailShops.offers(catalog, EconomyLeaftailShops.cycle(now, spec), "ABCD-EFGH-JKMP", 5)
        val supply = stock.first { it.kind == "item" && it.currency == "coins" }
        val leaf = apply(base, "buy_leaftail_item", EconomyLeaftailShops.targetId(spec, EconomyLeaftailShops.cycle(now, spec), supply.id), price = supply.unitPrice)
        assertEquals(supply.unitPrice, base.wallet.coins - leaf.wallet.coins)
    }

    @Test fun `purchase daily caps and merges cannot reopen capped days or multiply reputation`() {
        var state = stocked()
        repeat(5) { state = EconomyTradeRelations.awardPurchase(state, "plesk", 20, now) }
        assertEquals(2L, state.tradeRelations.reputation["plesk"])
        assertEquals(2L, state.tradeRelations.dailyPurchaseXp["plesk"])
        assertEquals(state, EconomyTradeRelations.awardPurchase(state, "plesk", 0, now))
        val future = Math.floorDiv(now.epochSecond, 86400L) + 1
        val a = state.tradeRelations.copy(dailyCycle = future, reputation = mapOf("plesk" to 150), dailyOrderXp = mapOf("plesk" to 60))
        val b = state.tradeRelations.copy(reputation = mapOf("plesk" to 600))
        val merged = EconomyTradeRelations.merge(a, b, now)
        assertEquals(600L, merged.reputation["plesk"])
        assertEquals(future, merged.dailyCycle)
        assertEquals(60L, merged.dailyOrderXp["plesk"])
        val capped = EconomyTradeRelations.awardPurchase(state.copy(tradeRelations = merged), "plesk", 20, now)
        assertEquals(600L, capped.tradeRelations.reputation["plesk"])
    }

    @Test fun `merged consumed weekly window cannot be reopened with another active guest in either direction`() {
        val choice = EconomyTradeRelations.weeklyBoard(stocked(), now).offers.single { it.residentId == "lopukh" }
        val accepted = apply(stocked(), "accept_weekly_order", choice.id)
        var paid = accepted
        repeat(3) {
            val active = EconomyTradeRelations.weeklyBoard(paid, now).active!!
            paid = apply(paid, "complete_resident_order", active.id)
        }
        val finished = paid.tradeRelations
        assertNull(finished.weekly)
        val fresh = apply(stocked(), "accept_weekly_order", choice.id, now.plusSeconds(1)).tradeRelations
        listOf(finished to fresh, fresh to finished).forEach { (target, source) ->
            val merged = EconomyTradeRelations.merge(target, source, now.plusSeconds(2))
            assertNull(merged.weekly)
            assertEquals(finished.reputation, merged.reputation.filterValues { it > 0 })
            assertEquals(fresh.weeklyAvailableAt, merged.weeklyAvailableAt)
            assertEquals(finished.completedWeekly, merged.completedWeekly)
            val repeated = EconomyTradeRelations.merge(merged, fresh, now.plusSeconds(3))
            assertNull(repeated.weekly)
            assertEquals(merged.reputation, repeated.reputation)
            val view = EconomyTradeRelations.weeklyBoard(paid.copy(tradeRelations = repeated), now.plusSeconds(3))
            assertFalse(view.canChoose); assertNull(view.active)
            val oldId = EconomyTradeRelations.weeklyBoard(accepted, now).active!!.id
            failure("ECONOMY_WEEKLY_CHANGED") { apply(paid.copy(tradeRelations = repeated), "complete_resident_order", oldId, now.plusSeconds(3)) }
        }
        val unused = EconomyTradeRelationsState()
        assertEquals(fresh.weekly, EconomyTradeRelations.merge(unused, fresh, now.plusSeconds(2)).weekly)
        assertEquals(fresh.weekly, EconomyTradeRelations.merge(fresh, unused, now.plusSeconds(2)).weekly)
        val afterFence = now.plusSeconds(604801)
        val nextChoice = EconomyTradeRelations.weeklyBoard(stocked(), afterFence).offers.first()
        val next = apply(stocked(), "accept_weekly_order", nextChoice.id, afterFence).tradeRelations
        assertEquals(next.weekly, EconomyTradeRelations.merge(finished, next, afterFence).weekly)
    }

    @Test fun `merging the same frozen weekly retains the furthest paid stage`() {
        val choice = EconomyTradeRelations.weeklyBoard(stocked(), now).offers.single { it.residentId == "lopukh" }
        val accepted = apply(stocked(), "accept_weekly_order", choice.id)
        val first = EconomyTradeRelations.weeklyBoard(accepted, now).active!!
        val sameSecond = apply(stocked(), "accept_weekly_order", choice.id, now.plusMillis(1))
        assertEquals(accepted.tradeRelations.weekly!!.id, sameSecond.tradeRelations.weekly!!.id)
        assertNotEquals(accepted.tradeRelations.weekly.acceptedAt, sameSecond.tradeRelations.weekly.acceptedAt)
        val delivered = apply(sameSecond, "complete_resident_order", first.id, now.plusMillis(2))
        listOf(accepted.tradeRelations to delivered.tradeRelations, delivered.tradeRelations to accepted.tradeRelations).forEach { (a, b) ->
            val merged = EconomyTradeRelations.merge(a, b, now.plusMillis(2))
            assertEquals(1, merged.weekly!!.stage)
            assertEquals(delivered.tradeRelations.reputation["lopukh"], merged.reputation["lopukh"])
            failure("ECONOMY_WEEKLY_CHANGED") { apply(delivered.copy(tradeRelations = merged), "complete_resident_order", first.id, now.plusMillis(2)) }
        }
    }

    @Serializable private data class OrdinaryVector(val templateId: String, val residentId: String, val home: Int,
        val requiredBuildings: Map<String, Int>, val items: Map<String, Long>, val coins: Long, val reputationXp: Int,
        val effortSeconds: Long, val manufacturingSeconds: Long, val fishingUncertain: Boolean)
    @Serializable private data class WeeklyVector(val templateId: String, val residentId: String, val home: Int,
        val requiredBuildings: Map<String, Int>, val stages: List<OrdinaryVector>, val coins: Long, val reputationXp: Int,
        val effortSeconds: Long, val manufacturingSeconds: Long, val fishingUncertain: Boolean)
    @Serializable private data class RankVector(val xp: Long, val rankIndex: Int, val bonusBps: Int)

    @Serializable private data class OfferVector(val id: String, val slot: Int, val templateId: String,
        val residentId: String, val name: String, val description: String? = null, val items: Map<String, Long>, val coins: Long,
        val reputationXp: Int?, val effortSeconds: Long?, val manufacturingSeconds: Long?, val fishingUncertain: Boolean?,
        val requiredBuildings: Map<String, Int> = emptyMap())
    @Serializable private data class ChoiceVector(val id: String, val templateId: String, val residentId: String,
        val coins: Long, val reputationXp: Int, val effortSeconds: Long, val manufacturingSeconds: Long, val fishingUncertain: Boolean,
        val savedWeeklyId: String, val acceptedAt: String, val expiresAt: String, val stages: List<EconomyResidentOrderTemplate>,
        val activeStages: List<OfferVector>)
    @Serializable private data class IdCase(val label: String, val now: String, val buildings: Map<String, Int>,
        val ownedRods: List<String>, val ownedHooks: List<String>, val completedRecipes: Map<String, Long>,
        val ordinary: List<OfferVector>, val weeklyChoices: List<ChoiceVector>)
    @Serializable private data class HashVector(val input: String, val expected: Long)
    private fun EconomyResidentOrderOffer.vector() = OfferVector(id, slot, templateId, residentId, name, description,
        items, coins, reputationXp, effortSeconds, manufacturingSeconds, fishingUncertain, requiredBuildings)
    private fun vectors() = economyJson.parseToJsonElement(checkNotNull(javaClass.getResourceAsStream(
        "/world/trade-relations-vectors.json")).bufferedReader().readText()).jsonObject

    @Test fun `actual TypeScript runtime choices ordinary and accepted stage identifiers match Kotlin literally`() {
        val fixture = vectors()
        economyJson.decodeFromString<List<HashVector>>(fixture.getValue("hashCases").toString()).forEach {
            assertEquals(it.expected, EconomyFood.hash(it.input), it.input)
        }
        val cases = economyJson.decodeFromString<List<IdCase>>(fixture.getValue("idCases").toString())
        cases.forEach { row ->
            val instant = Instant.parse(row.now)
            val state = EconomyRules.initial().copy(buildings = row.buildings,
                fishing = EconomyFishing(ownedRods = row.ownedRods, ownedHooks = row.ownedHooks),
                progression = EconomyProgression(recipes = row.completedRecipes))
            assertEquals(row.ordinary, EconomyFood.residentOrderBoard(state, instant).offers.map { it.vector() }, row.label)
            val choices = EconomyTradeRelations.weeklyBoard(state, instant).offers
            assertEquals(row.weeklyChoices.map { it.id }, choices.map { it.id }, row.label)
            row.weeklyChoices.zip(choices).forEach { (expected, actual) ->
                assertEquals(expected.templateId, actual.templateId); assertEquals(expected.residentId, actual.residentId)
                assertEquals(expected.coins, actual.coins); assertEquals(expected.reputationXp, actual.reputationXp)
                assertEquals(expected.effortSeconds, actual.effortSeconds); assertEquals(expected.manufacturingSeconds, actual.manufacturingSeconds)
                assertEquals(expected.fishingUncertain, actual.fishingUncertain); assertEquals(expected.stages, actual.stages)
                val accepted = apply(state, "accept_weekly_order", expected.id, instant)
                val saved = accepted.tradeRelations.weekly!!
                assertEquals(expected.savedWeeklyId, saved.id); assertEquals(expected.stages, saved.stages)
                assertEquals(Instant.parse(expected.acceptedAt), Instant.parse(saved.acceptedAt))
                assertEquals(Instant.parse(expected.expiresAt), Instant.parse(saved.expiresAt))
                expected.activeStages.forEachIndexed { index, stage ->
                    val stageState = accepted.copy(tradeRelations = accepted.tradeRelations.copy(weekly = saved.copy(stage = index)))
                    assertEquals(stage, EconomyTradeRelations.weeklyBoard(stageState, instant).active!!.vector(), row.label)
                }
            }
        }
    }

    @Test fun `clock rollback cannot deliver a future started weekly`() {
        val choice = EconomyTradeRelations.weeklyBoard(stocked(), now).offers.first()
        val accepted = apply(stocked(), "accept_weekly_order", choice.id)
        val active = EconomyTradeRelations.weeklyBoard(accepted, now).active!!
        failure("ECONOMY_WEEKLY_UNAVAILABLE") { apply(accepted, "complete_resident_order", active.id, now.minusMillis(1)) }
        assertEquals(0L, accepted.tradeRelations.reputation[choice.residentId] ?: 0L)
    }

    @Test fun `shared catalog vectors cover every ordinary and weekly work quote and capped rank`() {
        val json = economyJson.parseToJsonElement(checkNotNull(javaClass.getResourceAsStream("/world/trade-relations-vectors.json")).bufferedReader().readText()).jsonObject
        val ordinary = economyJson.decodeFromString<List<OrdinaryVector>>(json.getValue("orders").toString())
        assertEquals(catalog.food!!.orders.templates.size, ordinary.size)
        ordinary.forEach { row ->
            val actual = catalog.food.orders.templates.single { it.id == row.templateId }
            assertEquals(row.residentId, actual.residentId); assertEquals(row.items, actual.items); assertEquals(row.coins, actual.coins)
            assertEquals(row.reputationXp, actual.reputationXp); assertEquals(row.effortSeconds, actual.effortSeconds)
            assertEquals(row.manufacturingSeconds, actual.manufacturingSeconds); assertEquals(row.fishingUncertain, actual.fishingUncertain)
        }
        val weeklies = economyJson.decodeFromString<List<WeeklyVector>>(json.getValue("weekly").toString())
        assertEquals(catalog.tradeRelations!!.weekly.templates.size, weeklies.size)
        weeklies.forEach { row ->
            val actual = catalog.tradeRelations.weekly.templates.single { it.id == row.templateId }
            assertEquals(row.residentId, actual.residentId); assertEquals(row.home, actual.requiredHomeLevel)
            assertEquals(row.requiredBuildings, actual.requiredBuildings)
            assertEquals(row.coins, actual.stages.sumOf { it.coins }); assertEquals(row.reputationXp, actual.stages.sumOf { it.reputationXp })
            assertEquals(row.effortSeconds, actual.stages.sumOf { it.effortSeconds })
            assertEquals(row.manufacturingSeconds, actual.stages.sumOf { it.manufacturingSeconds })
            assertEquals(row.fishingUncertain, actual.stages.any { it.fishingUncertain })
            row.stages.zip(actual.stages).forEach { (expected, stage) ->
                assertEquals(expected.templateId, stage.id); assertEquals(expected.items, stage.items); assertEquals(expected.coins, stage.coins)
                assertEquals(expected.reputationXp, stage.reputationXp); assertEquals(expected.effortSeconds, stage.effortSeconds)
                assertEquals(expected.manufacturingSeconds, stage.manufacturingSeconds); assertEquals(expected.fishingUncertain, stage.fishingUncertain)
            }
        }
        val ranks = economyJson.decodeFromString<List<RankVector>>(json.getValue("ranks").toString())
        ranks.forEach { row ->
            val state = stocked().copy(tradeRelations = EconomyTradeRelationsState(reputation = mapOf("builder" to row.xp)))
            assertEquals(row.bonusBps, EconomyTradeRelations.bonusBps(state, "builder"))
        }
        assertTrue(catalog.tradeRelations!!.ranks.all { it.bonusBps <= 1000 })
    }
}
