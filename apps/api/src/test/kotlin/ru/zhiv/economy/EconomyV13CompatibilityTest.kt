package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyV13CompatibilityTest {
    private val now = Instant.parse("2026-10-26T12:00:00Z")
    private val catalog = EconomyRules.catalog
    private fun command(action: String, target: String) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, command(action, target), at).first
    private fun player() = EconomyRules.initial().let { state -> state.copy(
        wallet = EconomyWallet(100_000, 10_000), inventory = emptyMap(),
        buildings = catalog.buildings.associate { it.id to it.levels.last().level },
        tutorialOrder = state.tutorialOrder.copy(step = 4, completed = true),
        progression = state.progression.copy(recipes = catalog.recipes.associate { it.id to 100L }),
    ) }
    private fun failure(code: String, action: () -> Unit) =
        assertEquals(code, assertFailsWith<AuthFailure>(block = action).code)

    @Test fun `old catalog fields remain optional while reference technologies are validated`() {
        val oldRecipe = catalog.recipes.first().copy(retired = false)
        val oldRoute = catalog.explorations.first().copy(retired = false)
        assertFalse("retired" in economyJson.encodeToJsonElement(oldRecipe).jsonObject)
        assertFalse("retired" in economyJson.encodeToJsonElement(oldRoute).jsonObject)
        assertFalse(economyJson.decodeFromString<EconomyRecipe>(economyJson.encodeToString(oldRecipe)).retired)
        assertFalse(economyJson.decodeFromString<EconomyExploration>(economyJson.encodeToString(oldRoute)).retired)
        val old = catalog.copy(version = 12, timeEconomy = null)
        assertNull(economyJson.decodeFromString<EconomyCatalog>(economyJson.encodeToString(old)).timeEconomy)
        for (version in 10..12) EconomyRules.validateTimeEconomy(old.copy(version = version))
        assertFailsWith<IllegalArgumentException> { EconomyRules.validateTimeEconomy(old.copy(version = 13)) }
        val policy = EconomyTimeEconomy(version = 1, coinsPerMinute = 10, constructionCoinsPerMinute = 10, orderBonusBps = 2500,
            baselineRecipes = mapOf("berries" to "grow_berries"), baselineExplorations = emptyMap(), externalPrices = emptyMap())
        assertFails { economyJson.decodeFromJsonElement<EconomyTimeEconomy>(
            JsonObject(economyJson.encodeToJsonElement(policy).jsonObject - "version")) }
        assertFailsWith<IllegalArgumentException> { policy.copy(coinsPerMinute = 0) }
        assertFailsWith<IllegalArgumentException> { policy.copy(constructionCoinsPerMinute = 1_000_001) }
        assertFailsWith<IllegalArgumentException> { policy.copy(orderBonusBps = 10_001) }
        assertFailsWith<IllegalArgumentException> { policy.copy(externalPrices = mapOf("berries" to -1)) }
        val current = old.copy(version = 13, timeEconomy = policy)
        EconomyRules.validateTimeEconomy(current)
        assertFailsWith<IllegalArgumentException> { EconomyRules.validateTimeEconomy(current.copy(
            timeEconomy = policy.copy(externalPrices = mapOf("berries" to 10)))) }
        assertFailsWith<IllegalArgumentException> { EconomyRules.validateTimeEconomy(current.copy(
            timeEconomy = policy.copy(baselineRecipes = mapOf("berries" to "make_planks")))) }
        assertFailsWith<IllegalArgumentException> { EconomyRules.validateTimeEconomy(current.copy(
            recipes = current.recipes.map { if (it.id == "grow_berries") it.copy(retired = true) else it })) }
    }

    @Test fun `retired definitions cannot start even with all buildings and materials`() {
        val recipes = catalog.recipes.filter { it.retired }
        val routes = catalog.explorations.filter { it.retired }
        assertTrue(recipes.isNotEmpty(), "Keep superseded recipe IDs for saved jobs")
        assertTrue(routes.isNotEmpty(), "Keep old shift IDs for saved jobs")
        recipes.forEach { source ->
            failure("ECONOMY_SOURCE_RETIRED") { apply(player().copy(inventory = source.cost.items), "start_production", source.id) }
        }
        routes.forEach { source ->
            for (action in listOf("start_exploration", "start_fishing"))
                failure("ECONOMY_SOURCE_RETIRED") { apply(player().copy(inventory = source.cost.items), action, source.id) }
        }
    }

    @Test fun `saved v12 shift keeps original timer and forty eight rewards and can be claimed only once`() {
        val source = catalog.explorations.first { it.retired && it.activity == "mining" }
        val saved = EconomyJob(UUID.randomUUID().toString(), "exploration", source.id, actorId = "miner",
            startedAt = now.toString(), finishesAt = now.plusSeconds(8 * 3600).toString(),
            rewards = mapOf("clay" to 48L), cost = EconomyCost(37, mapOf("rope" to 1L)), catalogVersion = 12)
        val state = player().copy(jobs = listOf(economyJson.decodeFromString<EconomyJob>(economyJson.encodeToString(saved))))
        failure("ECONOMY_JOB_NOT_READY") { apply(state, "claim_job", saved.id, now.plusSeconds(8 * 3600 - 1)) }
        assertEquals(saved, state.jobs.single())
        val claimed = apply(state, "claim_job", saved.id, Instant.parse(saved.finishesAt))
        assertEquals(48L, claimed.inventory["clay"])
        assertEquals(state.wallet, claimed.wallet)
        assertTrue(claimed.jobs.isEmpty())
        failure("ECONOMY_JOB_GONE") { apply(claimed, "claim_job", saved.id, Instant.parse(saved.finishesAt)) }
    }

    @Test fun `saved retired production preserves output and cancellation refunds only paid cost`() {
        val source = catalog.recipes.first { it.retired && it.collection == null }
        val itemId = source.rewards.keys.first()
        val saved = EconomyJob(UUID.randomUUID().toString(), "production", source.buildingId, source.id,
            startedAt = now.toString(), finishesAt = now.plusSeconds(3600).toString(),
            rewards = mapOf(itemId to 3L), cost = EconomyCost(17, mapOf("wood" to 2L)), catalogVersion = 12)
        val state = player().copy(jobs = listOf(saved))
        val claimed = apply(state, "claim_job", saved.id, Instant.parse(saved.finishesAt))
        assertEquals(3L, claimed.inventory[itemId])
        assertEquals(state.wallet, claimed.wallet)
        val cancelled = apply(state, "cancel_production", saved.id)
        assertEquals(mapOf("wood" to 2L), cancelled.inventory)
        assertEquals(state.wallet.coins + 17L, cancelled.wallet.coins)
        assertTrue(cancelled.jobs.isEmpty())
    }

    @Test fun `retired acquisition cannot unlock new orders even when the player holds old stock`() {
        val isolated = catalog.copy(
            recipes = catalog.recipes.map { if ((it.rewards["clay"] ?: 0) > 0) it.copy(retired = true) else it },
            explorations = catalog.explorations.map { if ((it.rewards["clay"] ?: 0) > 0) it.copy(retired = true) else it },
        )
        val obtained = EconomyFood.obtainableOrderItems(player().copy(inventory = mapOf("clay" to 100L)), isolated)
        assertFalse("clay" in obtained)
        assertFalse("bricks" in obtained)
    }

    @Test fun `new single item mining uses its fixed duration and a separate miner`() {
        val source = catalog.explorations.first { !it.retired && it.activity == "mining" }
        assertEquals(1L, source.rewards.values.sum())
        val state = player().copy(inventory = source.cost.items,
            minerRareDropState = EconomyRareDropClock(remainingSeconds = catalog.rareDrops!!.maxSeconds, itemId = "moon_crystal"))
        val started = apply(state, "start_exploration", source.id)
        val job = started.jobs.single()
        assertEquals("miner", job.actorId)
        assertEquals(source.rewards, job.rewards)
        assertEquals(source.seconds, Instant.parse(job.finishesAt).epochSecond - now.epochSecond)
        failure("ECONOMY_MINER_BUSY") { apply(started, "start_exploration", source.id) }
    }

    @Test fun `new one coin order rounding never changes frozen older conditions`() {
        val template = catalog.food!!.orders.templates.first { it.residentId == "builder" && it.items.keys.all { id -> id in setOf("wood", "berries", "fiber", "stone") } }
        val quoted = template.copy(coins = 13)
        assertEquals(13L, EconomyFood.progressedTemplate(quoted, 5, catalog.copy(version = 13)).coins)
        assertEquals(20L, EconomyFood.progressedTemplate(quoted, 5, catalog.copy(version = 12)).coins)
        val frozen = template.copy(coins = 77, items = mapOf("wood" to 1L), reputationXp = null)
        val cycle = Math.floorDiv(now.epochSecond, catalog.food.orders.refreshSeconds)
        val state = player().copy(inventory = frozen.items, residentOrders = EconomyResidentOrders(
            version = 3, cycle = cycle, slots = listOf(EconomyResidentOrderSlot(readyAt = now.toString(),
                templateId = frozen.id, terms = frozen, residentId = frozen.residentId))))
        val board = EconomyFood.residentOrderBoard(state, now)
        val offer = board.offers.single { it.templateId == frozen.id }
        assertEquals(77L, offer.coins)
        val completed = EconomyFood.order(state, offer.id, false, now).first
        assertEquals(state.wallet.coins + 77L, completed.wallet.coins)
        assertNull(completed.inventory["wood"])
    }

    @Test fun `frozen requests remain payable from owned stock when their former source retires`() {
        val frozen = catalog.food!!.orders.templates.first { it.residentId == "builder" }
            .copy(items = mapOf("wood" to 1L), coins = 77, reputationXp = null)
        val changed = catalog.copy(
            recipes = catalog.recipes.map { if ((it.rewards["wood"] ?: 0L) > 0L) it.copy(retired = true) else it },
            explorations = catalog.explorations.map { if ((it.rewards["wood"] ?: 0L) > 0L) it.copy(retired = true) else it })
        val state = player().copy(inventory = frozen.items, residentOrders = EconomyResidentOrders(
            version = 3, cycle = Math.floorDiv(now.epochSecond, catalog.food.orders.refreshSeconds),
            slots = listOf(EconomyResidentOrderSlot(readyAt = now.toString(), templateId = frozen.id,
                terms = frozen, residentId = frozen.residentId))))
        assertFalse("wood" in EconomyFood.obtainableOrderItems(state, changed))
        assertFalse(EconomyFood.eligibleOrderTemplates(state, changed).any { "wood" in it.items })
        val offer = EconomyFood.residentOrderBoard(state, now, changed).offers.single { it.templateId == frozen.id }
        assertEquals(77L, offer.coins)
        val completed = EconomyFood.order(state, offer.id, false, now, catalog = changed).first
        assertEquals(state.wallet.coins + 77L, completed.wallet.coins)
        assertNull(completed.inventory["wood"])
    }

    @Test fun `commands cannot inject a previous catalog or cheaper time policy`() {
        val encoded = economyJson.encodeToJsonElement(command("start_production", "grow_berries")).jsonObject
        val stale = economyJson.encodeToJsonElement(catalog.copy(version = 12, timeEconomy = null))
        for ((key, value) in mapOf("catalog" to stale, "catalogVersion" to JsonPrimitive(12),
            "timeEconomy" to economyJson.encodeToJsonElement(catalog.timeEconomy!!.copy(coinsPerMinute = 1)))) {
            failure("INVALID_ECONOMY_COMMAND") { decodeEconomyCommand(JsonObject(encoded + (key to value))) }
        }
    }


    @Test fun `repricing an active recipe never recalculates a saved production job`() {
        val source = catalog.recipes.single { it.id == "dry_berries" }
        assertFalse(source.retired)
        val saved = EconomyJob(UUID.randomUUID().toString(), "production", source.buildingId, source.id,
            startedAt = now.toString(), finishesAt = now.plusSeconds(2700).toString(),
            rewards = mapOf("dried_berries" to 2L), cost = EconomyCost(items = mapOf("berries" to 6L)), catalogVersion = 12)
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(player().copy(jobs = listOf(saved))))
        val unrelated = apply(restored, "start_production", "grow_berries")
        assertEquals(saved, unrelated.jobs.single { it.id == saved.id })
        failure("ECONOMY_JOB_NOT_READY") { apply(restored, "claim_job", saved.id, now.plusSeconds(2699)) }
        val claimed = apply(restored, "claim_job", saved.id, now.plusSeconds(2700))
        assertEquals(2L, claimed.inventory["dried_berries"])
        assertEquals(101L, claimed.progression.recipes["dry_berries"])
    }

    @Test fun `frozen resident requests survive stricter resident and source house gates`() {
        val frozen = catalog.food!!.orders.templates.first { it.residentId == "leaftail" }
            .copy(items = mapOf("wood" to 1L), coins = 77, requiredBuildings = emptyMap(), reputationXp = null)
        val state = player().copy(buildings = player().buildings + ("home" to 1), inventory = frozen.items,
            residentOrders = EconomyResidentOrders(version = 3, cycle = Math.floorDiv(now.epochSecond, catalog.food.orders.refreshSeconds),
                slots = listOf(EconomyResidentOrderSlot(readyAt = now.toString(), templateId = frozen.id,
                    terms = frozen, residentId = frozen.residentId))))
        assertFalse(EconomyTradeRelations.available(state, "leaftail", catalog))
        val offer = EconomyFood.residentOrderBoard(state, now).offers.single { it.templateId == frozen.id }
        assertEquals(77L, offer.coins)
        val completed = EconomyFood.order(state, offer.id, false, now).first
        assertEquals(state.wallet.coins + 77L, completed.wallet.coins)
        assertNull(completed.inventory["wood"])
    }

}
