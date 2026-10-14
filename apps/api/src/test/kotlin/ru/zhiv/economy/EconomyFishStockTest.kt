package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyFishStockTest {
    private val now = Instant.parse("2026-10-14T23:00:00Z")
    private val spec = checkNotNull(EconomyRules.catalog.fishing)
    private val common = spec.fish.filter { it.rarity == "common" }
    private val epic = spec.fish.filter { it.rarity == "epic" }
    private fun command(action: String, target: String, selection: Map<String, Long>? = null) = EconomyCommand(
        UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, fishSelection = selection)
    private fun stock(inventory: Map<String, Long>, known: Map<String, Long>?, catches: Map<String, Long> = emptyMap()) =
        EconomyRules.initial().copy(inventory = inventory, fishing = EconomyFishing(stock = known, catches = catches))
    private fun failure(block: () -> Unit) = assertEquals("ECONOMY_FISH_SELECTION_CHANGED", assertFailsWith<AuthFailure> { block() }.code)

    @Test fun `class-only legacy stock never pretends lifetime collection is owned fish`() {
        val state = stock(mapOf("fish_epic" to 2L), null, mapOf(epic[0].itemId to 50L))
        val normalized = EconomyFishInventory.state(state)
        assertNull(normalized.fishing.stock)
        assertEquals(listOf(EconomyFishStock.Entry("fish_epic", 2L)), EconomyFishStock.entries(normalized, "fish_epic"))
        assertEquals(mapOf("fish_epic" to 2L), EconomyFishStock.autoFill(normalized, mapOf("fish_epic" to 2L)))
        assertFalse(economyJson.encodeToString(normalized.fishing).contains("\"stock\""))
        assertFalse(economyJson.encodeToString(command("start_production", "cook_grilled_fish")).contains("fishSelection"))
        val paid = EconomyRules.spend(normalized, EconomyCost(items = mapOf("fish_epic" to 1L)))
        assertNull(paid.fishing.stock)
        assertEquals(normalized.fishing, EconomyRules.spend(normalized, EconomyCost(coins = 1L)).fishing)
        val initialized = stock(mapOf("fish_epic" to 1L), mapOf(epic[0].itemId to 1L))
        val spent = EconomyRules.spend(initialized, EconomyCost(items = mapOf("fish_epic" to 1L)))
        assertNotNull(spent.fishing.stock)
        assertTrue(checkNotNull(spent.fishing.stock).isEmpty())
    }

    @Test fun `raw legacy species are captured once while corrupted stock is bounded by class inventory`() {
        val state = stock(mapOf(common[0].itemId to 2L, "fish_common" to 3L), null)
        val first = EconomyFishInventory.state(state)
        assertEquals(mapOf("fish_common" to 5L), first.inventory)
        assertEquals(mapOf(common[0].itemId to 2L), first.fishing.stock)
        assertEquals(first, EconomyFishInventory.state(first))
        val corrupt = stock(mapOf("fish_common" to 3L), linkedMapOf(common[0].itemId to 2L,
            common[1].itemId to 10L, "invented" to 99L, epic[0].itemId to 1L))
        assertEquals(mapOf(common[0].itemId to 2L, common[1].itemId to 1L), EconomyFishStock.normalized(corrupt))
    }

    @Test fun `automatic selection uses unknown first then abundant species with catalog-stable ties`() {
        val state = stock(mapOf("fish_common" to 9L), mapOf(common[0].itemId to 2L, common[1].itemId to 4L))
        val paid = EconomyRules.spend(state, EconomyCost(items = mapOf("fish_common" to 5L)))
        assertEquals(mapOf("fish_common" to 4L), paid.inventory)
        assertEquals(mapOf(common[0].itemId to 2L, common[1].itemId to 2L), paid.fishing.stock)
        val tied = stock(mapOf("fish_common" to 4L), mapOf(common[0].itemId to 2L, common[1].itemId to 2L))
        assertEquals(mapOf(common[0].itemId to 2L), EconomyFishStock.autoFill(tied, mapOf("fish_common" to 2L)))
    }

    @Test fun `explicit species choices conserve rarity goods and preserve the unchosen collection fish`() {
        val state = stock(mapOf("fish_epic" to 5L), mapOf(epic[0].itemId to 1L, epic[1].itemId to 4L))
        val paid = EconomyRules.spend(state, EconomyCost(items = mapOf("fish_epic" to 3L)), mapOf(epic[1].itemId to 3L))
        assertEquals(mapOf("fish_epic" to 2L), paid.inventory)
        assertEquals(mapOf(epic[0].itemId to 1L, epic[1].itemId to 1L), paid.fishing.stock)
        assertEquals(state.fishing.catches, paid.fishing.catches)
        assertEquals(5L, state.inventory["fish_epic"])
    }

    @Test fun `wrong rarity invented species oversupply undersupply and fake unidentified choices reject atomically`() {
        val state = stock(mapOf("fish_epic" to 3L, "fish_common" to 1L), mapOf(epic[0].itemId to 1L, epic[1].itemId to 2L))
        val cost = EconomyCost(items = mapOf("fish_epic" to 2L))
        for (selection in listOf(emptyMap(), mapOf(common[0].itemId to 2L), mapOf("fish_epic" to 2L),
            mapOf(epic[0].itemId to 2L), mapOf(epic[1].itemId to 1L), mapOf(epic[1].itemId to 3L),
            mapOf("invented" to 2L), mapOf(epic[1].itemId to 2L, epic[0].itemId to 0L))) {
            failure { EconomyRules.spend(state, cost, selection) }
        }
        assertEquals(mapOf(epic[0].itemId to 1L, epic[1].itemId to 2L), state.fishing.stock)
    }

    @Test fun `chosen cooking fish is saved in production and restored by cancellation exactly once`() {
        val recipe = EconomyRules.catalog.recipes.first { (it.cost.items["fish_epic"] ?: 0L) > 0L }
        val amount = recipe.cost.items.getValue("fish_epic")
        val initial = stock(recipe.cost.items + ("fish_epic" to amount + 1L),
            mapOf(epic[0].itemId to 1L, epic[1].itemId to amount)).copy(
            buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.maxOf { level -> level.level } },
            progression = EconomyProgression(recipes = EconomyRules.catalog.recipes.associate { it.id to 100L }))
        val start = command("start_production", recipe.id, mapOf(epic[1].itemId to amount))
        val started = EconomyRules.apply(initial, start, now).first
        assertEquals(mapOf(epic[0].itemId to 1L), started.fishing.stock)
        assertEquals(mapOf(epic[1].itemId to amount), started.jobs.single().fishStockCost)
        assertEquals(recipe.cost, started.jobs.single().cost)
        val refunded = EconomyRules.apply(started, command("cancel_production", start.requestId), now.plusSeconds(1)).first
        assertEquals(initial.inventory, refunded.inventory)
        assertEquals(initial.fishing.stock, refunded.fishing.stock)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            EconomyRules.apply(refunded, command("cancel_production", start.requestId), now.plusSeconds(2))
        }.code)
    }

    @Test fun `real fishing claim adds species stock while generic class credits remain unidentified`() {
        val species = epic[0].itemId
        val job = EconomyJob(UUID.randomUUID().toString(), "exploration", "shore", startedAt = now.minusSeconds(600).toString(),
            finishesAt = now.toString(), rewards = mapOf(species to 2L), fishing = EconomyFishingCatch("reed_rod", null, species))
        val initial = stock(mapOf("fish_epic" to 1L), null).copy(jobs = listOf(job))
        val claimed = EconomyRules.apply(initial, command("claim_job", job.id), now).first
        assertEquals(mapOf("fish_epic" to 3L), claimed.inventory)
        assertEquals(mapOf(species to 2L), claimed.fishing.stock)
        assertEquals(mapOf(species to 2L), claimed.fishing.catches)
        assertEquals(listOf(EconomyFishStock.Entry(species, 2L), EconomyFishStock.Entry("fish_epic", 1L)), EconomyFishStock.entries(claimed, "fish_epic"))
    }

    @Test fun `tutorial and normal resident orders honor exact species choices`() {
        val initial = stock(mapOf("fish_epic" to 3L), mapOf(epic[0].itemId to 1L, epic[1].itemId to 2L))
        val terms = EconomyResidentOrderTemplate("tutorial_first_order", "plesk", "Рыба", items = mapOf("fish_epic" to 2L), coins = 90L)
        val tutorial = initial.copy(tutorialOrder = EconomyTutorialOrder(ingredientsClaimed = true, terms = terms))
        val done = EconomyRules.apply(tutorial, command("complete_resident_order", terms.id, mapOf(epic[1].itemId to 2L)), now).first
        assertEquals(mapOf(epic[0].itemId to 1L), done.fishing.stock)
        assertTrue(done.tutorialOrder.completed)
        val board = EconomyFood.normalizedOrders(initial, now)
        val residentTerms = terms.copy(id = "saved_fish_order")
        val normal = initial.copy(residentOrders = board.copy(slots = board.slots.mapIndexed { index, slot ->
            if (index == 0) slot.copy(templateId = residentTerms.id, terms = residentTerms) else slot
        }))
        val offer = EconomyFood.residentOrderBoard(normal, now).offers.single { it.slot == 0 }
        val delivered = EconomyRules.apply(normal, command("complete_resident_order", offer.id, mapOf(epic[1].itemId to 2L)), now).first
        assertEquals(mapOf(epic[0].itemId to 1L), delivered.fishing.stock)
        assertEquals(initial.wallet.coins + terms.coins, delivered.wallet.coins)
    }

    @Test fun `stage fish requests honor species choices without changing progression or payout`() {
        val course = EconomyRules.catalog.stageOrders.first { stage -> stage.orders.any { order -> order.items.containsKey("fish_common") } }
        val step = course.orders.indexOfFirst { it.items.containsKey("fish_common") }
        val terms = course.orders[step]
        val quantity = terms.items.getValue("fish_common")
        val initial = stock(terms.items + ("fish_common" to quantity + 1L),
            mapOf(common[0].itemId to 1L, common[1].itemId to quantity)).copy(
            buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.maxOf { level -> level.level } } + ("home" to course.homeLevel),
            tutorialOrder = EconomyTutorialOrder(completed = true),
            progression = EconomyProgression(routes = terms.requiredExplorations),
            stageOrders = EconomyStageOrderState(stages = mapOf(course.homeLevel.toString() to EconomyStageOrderProgress(step = step))))
        val next = EconomyRules.apply(initial, command("complete_resident_order", terms.id, mapOf(common[1].itemId to quantity)), now).first
        assertEquals(mapOf(common[0].itemId to 1L), next.fishing.stock)
        assertEquals(initial.wallet.coins + terms.coins, next.wallet.coins)
        assertEquals(step + 1, EconomyStageOrders.progress(next).step)
    }

    @Test fun `legacy literal species refund is known while explicit empty proof remains unidentified`() {
        val species = common[1].itemId
        val job = EconomyJob(UUID.randomUUID().toString(), "production", "campfire", "legacy_fish_recipe",
            startedAt = now.toString(), finishesAt = now.plusSeconds(300).toString(), cost = EconomyCost(items = mapOf(species to 2L)))
        val initial = stock(emptyMap(), null).copy(jobs = listOf(job))
        val refunded = EconomyRules.apply(initial, command("cancel_production", job.id), now.plusSeconds(1)).first
        assertEquals(mapOf("fish_common" to 2L), refunded.inventory)
        assertEquals(mapOf(species to 2L), refunded.fishing.stock)
        val unidentified = EconomyRules.apply(initial.copy(jobs = listOf(job.copy(fishStockCost = emptyMap()))),
            command("cancel_production", job.id), now.plusSeconds(1)).first
        assertNull(unidentified.fishing.stock)
    }

    @Test fun `fish ownership moves through escrow without changing collections or class units`() {
        val state = stock(mapOf("fish_epic" to 4L), mapOf(epic[0].itemId to 1L, epic[1].itemId to 3L))
        val items = mapOf("fish_epic" to 2L)
        val debit = EconomyFishStock.debit(state, items)
        val id = UUID.randomUUID().toString()
        val held = EconomyFishStock.hold(EconomyRules.spend(state, EconomyCost(items = items)), id, debit.consumed)
        assertEquals(mapOf(epic[1].itemId to 2L), EconomyFishStock.escrow(held, id, items))
        val restored = EconomyFishStock.credit(EconomyFishStock.release(held.copy(inventory = EconomyRules.addItems(held.inventory, items)), id),
            EconomyFishStock.escrow(held, id, items))
        assertEquals(state.fishing.stock, restored.fishing.stock)
        assertTrue(restored.fishing.escrow.orEmpty().isEmpty())
        val buyer = stock(items, null)
        val bought = EconomyFishStock.credit(buyer, EconomyFishStock.escrow(held, id, items))
        assertEquals(items, bought.inventory)
        assertEquals(mapOf(epic[1].itemId to 2L), bought.fishing.stock)
        assertTrue(bought.fishing.catches.isEmpty())
        assertEquals(mapOf(epic[0].itemId to 1L), EconomyFishStock.within(mapOf(epic[0].itemId to 5L), mapOf("fish_epic" to 1L)))
        assertTrue(EconomyFishStock.within(mapOf(epic[0].itemId to 5L), mapOf("fish_common" to 1L)).isEmpty())
    }

    @Test fun `literal legacy market lot proves owned species only when escrow entry is absent`() {
        val id = UUID.randomUUID().toString()
        val species = common[1].itemId
        val state = stock(emptyMap(), null)
        val items = mapOf("fish_common" to 2L)
        assertEquals(mapOf(species to 2L), EconomyFishStock.escrow(state, id, items, legacyItems = mapOf(species to 2L)))
        val explicit = state.copy(fishing = state.fishing.copy(escrow = mapOf(id to emptyMap())))
        assertTrue(EconomyFishStock.escrow(explicit, id, items, legacyItems = mapOf(species to 2L)).isEmpty())
        assertTrue(EconomyFishStock.escrow(state, id, items, legacyItems = items).isEmpty())
    }

    @Test fun `selection decoder accepts nullable automatic choice but rejects coercion and unsupported actions`() {
        val request = command("start_production", "cook_grilled_fish")
        val json = economyJson.encodeToJsonElement(request).jsonObject
        assertNull(decodeEconomyCommand(JsonObject(json + ("fishSelection" to JsonNull))).fishSelection)
        assertEquals(mapOf(common[0].itemId to 1L), decodeEconomyCommand(JsonObject(json + ("fishSelection" to buildJsonObject {
            put(common[0].itemId, 1L)
        }))).fishSelection)
        for (bad in listOf(JsonPrimitive("1"), JsonPrimitive(1.5), JsonNull, buildJsonArray { add(1) })) {
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
                decodeEconomyCommand(JsonObject(json + ("fishSelection" to buildJsonObject { put(common[0].itemId, bad) })))
            }.code)
        }
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
            validateEconomyCommand(command("sell_fish", "fish_epic", mapOf(epic[0].itemId to 1L)))
        }.code)
    }
}
