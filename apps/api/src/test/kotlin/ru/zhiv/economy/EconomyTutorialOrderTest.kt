package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyTutorialOrderTest {
    private val now = Instant.parse("2026-10-11T20:00:00Z")
    private fun command(action: String = "claim_tutorial_order", target: String = EconomyTutorialOrders.ID, quantity: Long = 1, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity, price)
    private fun claim(state: EconomyState) = EconomyRules.apply(state, command(), now).first
    private fun complete(state: EconomyState, at: Instant = now) = EconomyRules.apply(state,
        command("complete_resident_order", state.tutorialOrder.terms!!.id), at).first
    private fun fails(code: String, block: () -> Unit) { assertEquals(code, assertFailsWith<AuthFailure>(block = block).code) }
    private fun legacy(terms: EconomyResidentOrderTemplate? = null, claimed: Boolean = false) = EconomyRules.initial().copy(
        tutorialOrder = EconomyTutorialOrder(terms = terms, ingredientsClaimed = claimed))
    private fun oldTerms() = EconomyResidentOrderTemplate(EconomyTutorialOrders.ID, "builder", "Сохранённый заказ",
        items = mapOf("berries" to 3L, "wood" to 2L), coins = 100)
    private val course get() = EconomyRules.catalog.stageOrders.single { it.homeLevel == 1 }
    private fun previousRequests() = listOf(EconomyRules.catalog.onboarding!!.residentOrder.copy(items = mapOf("berries" to 2L), coins = 30)) +
        course.orders.map { it.copy(id = it.id.replace("stage1_", "tutorial_")) }

    @Test fun `fresh profiles get the small pack and a single one berry teaching request`() {
        val fresh = EconomyRules.initial()
        assertEquals(EconomyWallet(100, 0), fresh.wallet)
        assertEquals(mapOf("stone" to 5L, "wood" to 3L), fresh.inventory)
        assertEquals(3, fresh.tutorialOrder.version); assertEquals(0, fresh.tutorialOrder.step)
        assertTrue(fresh.tutorialOrder.ingredientsClaimed); assertFalse(fresh.tutorialOrder.completed)
        assertEquals(EconomyRules.catalog.onboarding!!.residentOrder, fresh.tutorialOrder.terms)
        assertEquals(mapOf("berries" to 1L), fresh.tutorialOrder.terms!!.items)
        assertEquals(13L, fresh.tutorialOrder.terms!!.coins)
        assertNull(EconomyStageOrders.offer(fresh))
        assertEquals(50L, EconomyRules.storage(fresh).capacity)
        fails("ECONOMY_TUTORIAL_ORDER_CLAIMED") { claim(fresh) }
        val migrated = EconomyRules.initial(100, 81, 49, 4, 2)
        assertEquals(EconomyMigration(coinsGranted = 360, woodGranted = 9, stoneGranted = 7), migrated.migration)
        assertEquals(EconomyWallet(460, 0), migrated.wallet)
        assertEquals(mapOf("wood" to 12L, "stone" to 12L), migrated.inventory)
        val converted = EconomyRules.initial(includeStartingPack = false)
        assertEquals(EconomyWallet(), converted.wallet); assertTrue(converted.inventory.isEmpty())
        assertEquals(EconomyTutorialOrder(), converted.tutorialOrder)
    }

    @Test fun `older saved states default to v1 without resetting balances`() {
        val previous = EconomyRules.initial().copy(wallet = EconomyWallet(21, 4), inventory = mapOf("stone" to 2L))
        val json = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(previous)).jsonObject - "tutorialOrder")
        val decoded = economyJson.decodeFromString<EconomyState>(json.toString())
        assertEquals(previous.wallet, decoded.wallet); assertEquals(previous.inventory, decoded.inventory)
        assertEquals(EconomyTutorialOrder(), decoded.tutorialOrder)
    }

    @Test fun `legacy claim pins terms without issuing goods even with full warehouse and escrow`() {
        val before = legacy(oldTerms()).copy(inventory = mapOf("stone" to 50L))
        val after = EconomyRules.apply(before, command(), now, mapOf("wood" to 20L)).first
        assertEquals(before.wallet, after.wallet); assertEquals(before.inventory, after.inventory)
        assertEquals(oldTerms(), after.tutorialOrder.terms)
        assertTrue(after.tutorialOrder.ingredientsClaimed); assertEquals(1, after.tutorialOrder.version)
        assertEquals(before.jobs, after.jobs); assertEquals(before.buildings, after.buildings)
    }

    @Test fun `one teaching request opens three independent house deliveries paying 338 altogether`() {
        var state = EconomyRules.initial().copy(inventory = mapOf("berries" to 1L, "wood" to 2L, "berry_compote" to 2L, "planks" to 2L))
        val board = EconomyFood.residentOrderBoard(state, now)
        state = complete(state)
        assertTrue(state.tutorialOrder.completed); assertEquals(1, state.tutorialOrder.step)
        assertEquals(113L, state.wallet.coins)
        assertEquals("stage1_wood_order", EconomyStageOrders.offer(state)!!.id)
        fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") { complete(state) }
        for ((index, request) in course.orders.withIndex()) {
            assertEquals(index, EconomyStageOrders.progress(state).step)
            assertEquals(request, EconomyStageOrders.offer(state))
            for (other in course.orders.filter { it.id != request.id }) fails("ECONOMY_STAGE_ORDER_UNAVAILABLE") {
                EconomyRules.apply(state, command("complete_resident_order", other.id), now) }
            state = EconomyRules.apply(state, command("complete_resident_order", request.id), now).first
            assertEquals(index + 1, EconomyStageOrders.progress(state).step)
            assertEquals(index == course.orders.lastIndex, EconomyStageOrders.progress(state).completed)
            fails("ECONOMY_STAGE_ORDER_UNAVAILABLE") { EconomyRules.apply(state, command("complete_resident_order", request.id), now) }
        }
        assertTrue(state.inventory.isEmpty()); assertEquals(438L, state.wallet.coins)
        assertEquals(4L, state.residentOrders.completed); assertEquals(338L, state.residentOrders.earnedCoins)
        assertEquals(board.offers, EconomyFood.residentOrderBoard(state, now).offers)
        assertNull(EconomyStageOrders.offer(state)); fails("ECONOMY_TUTORIAL_ORDER_CLAIMED") { claim(state) }
    }

    @Test fun `v2 first quote is reduced to one berry with its promised thirty coin reward intact`() {
        val previous = EconomyRules.initial().copy(inventory = mapOf("berries" to 1L), tutorialOrder = EconomyTutorialOrder(
            version = 2, terms = previousRequests().first(), ingredientsClaimed = true))
        val projected = EconomyTutorialOrders.normalize(previous)
        assertEquals(2L, previous.tutorialOrder.terms!!.items["berries"])
        assertEquals(3, projected.tutorialOrder.version); assertEquals(mapOf("berries" to 1L), projected.tutorialOrder.terms!!.items)
        assertEquals(30L, projected.tutorialOrder.terms!!.coins)
        assertEquals(previous.wallet, projected.wallet); assertEquals(previous.inventory, projected.inventory)
        val done = complete(previous)
        assertEquals(130L, done.wallet.coins); assertTrue(done.tutorialOrder.completed)
        assertEquals(0, EconomyStageOrders.progress(done).step)
    }

    @Test fun `v2 paid steps transfer to house progress and frozen remaining requests retain their IDs and rewards`() {
        for (step in 1..4) {
            val request = previousRequests()[minOf(step, 3)].copy(coins = 137)
            val previous = EconomyRules.initial().copy(wallet = EconomyWallet(51), inventory = request.items,
                residentOrders = EconomyResidentOrders(completed = step.toLong(), earnedCoins = 137L * step),
                tutorialOrder = EconomyTutorialOrder(version = 2, step = step, completed = step == 4,
                    ingredientsClaimed = true, terms = request))
            val projected = EconomyTutorialOrders.normalize(previous)
            assertEquals(2, previous.tutorialOrder.version); assertEquals(3, projected.tutorialOrder.version)
            assertTrue(projected.tutorialOrder.completed); assertEquals(step - 1, EconomyStageOrders.progress(projected).step)
            assertEquals(previous.wallet, projected.wallet); assertEquals(previous.residentOrders, projected.residentOrders)
            if (step == 4) {
                assertTrue(EconomyStageOrders.progress(projected).completed); assertNull(EconomyStageOrders.offer(projected)); continue
            }
            assertEquals(request, EconomyStageOrders.offer(previous))
            val done = EconomyRules.apply(previous, command("complete_resident_order", request.id), now).first
            assertEquals(188L, done.wallet.coins); assertEquals(step, EconomyStageOrders.progress(done).step)
            assertEquals(step + 1L, done.residentOrders.completed)
            if (step < 3) assertEquals(course.orders[step], EconomyStageOrders.offer(done))
        }
    }

    @Test fun `legacy completion preserves saved reward and never starts the new house course`() {
        val before = legacy(oldTerms().copy(coins = 123), true).copy(inventory = oldTerms().items)
        val saved = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(before))
        val after = complete(saved, now.plusSeconds(30 * 86400))
        assertEquals(before.wallet.coins + 123, after.wallet.coins)
        assertTrue(after.tutorialOrder.completed); assertEquals(1, after.tutorialOrder.version)
        assertEquals(0, after.tutorialOrder.step); assertEquals(before.tutorialOrder.terms, after.tutorialOrder.terms)
        assertNull(EconomyStageOrders.offer(after)); fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") { complete(after) }
    }

    @Test fun `missing resources and wallet overflow preserve tutorial progress`() {
        val missing = EconomyRules.initial()
        fails("ECONOMY_RESOURCES") { complete(missing) }
        val full = missing.copy(inventory = mapOf("berries" to 1L), wallet = EconomyWallet(ECONOMY_MAX_BALANCE - 12))
        fails("ECONOMY_CAPACITY") { complete(full) }
        assertEquals(0, full.tutorialOrder.step); assertFalse(full.tutorialOrder.completed)
        fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") { EconomyRules.apply(missing, command("replace_resident_order"), now) }
        for (cmd in listOf(command(target = "workshop"), command(quantity = 2), command(price = 1)))
            fails("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(missing, cmd, now) }
    }

    @Test fun `home two needs the tutorial then three house deliveries while older courses stay completed`() {
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(300), inventory = mapOf("wood" to 3L, "stone" to 2L, "planks" to 2L))
        fails("ECONOMY_TUTORIAL_REQUIRED") { EconomyRules.apply(before, command("start_construction", "home"), now) }
        val built = before.copy(buildings = before.buildings + mapOf("woodlot" to 1, "dryer" to 1, "workshop" to 1),
            tutorialOrder = before.tutorialOrder.copy(step = 1, completed = true))
        fails("ECONOMY_STAGE_REQUIRED") { EconomyRules.apply(built, command("start_construction", "home"), now) }
        for (progress in listOf(EconomyTutorialOrder(), EconomyTutorialOrder(version = 2, step = 4, completed = true, ingredientsClaimed = true))) {
            val started = EconomyRules.apply(built.copy(tutorialOrder = progress), command("start_construction", "home"), now).first
            assertEquals(0L, started.wallet.coins); assertEquals(2, started.jobs.single().targetLevel)
        }
    }

    @Test fun `account merges retain completed teaching progress and never reopen active legacy rewards`() {
        val fresh = EconomyRules.initial().tutorialOrder
        val finished = fresh.copy(step = 1, completed = true)
        for ((a, b) in listOf(fresh to finished, finished to fresh, EconomyTutorialOrder() to finished, finished to EconomyTutorialOrder()))
            assertEquals(finished, EconomyTutorialOrders.merge(a, b))
        val old = EconomyTutorialOrder(ingredientsClaimed = true, terms = oldTerms(), completed = true)
        for ((a, b) in listOf(fresh to old, old to fresh)) assertEquals(old, EconomyTutorialOrders.merge(a, b))
        val first = EconomyStageOrderState(stages = mapOf("1" to EconomyStageOrderProgress(step = 1, terms = course.orders[1])))
        val last = EconomyStageOrderState(stages = mapOf("1" to EconomyStageOrderProgress(step = 3, completed = true)))
        for ((a, b) in listOf(first to last, last to first)) assertTrue(EconomyStageOrders.merge(a, b).stages.getValue("1").completed)
    }
}
