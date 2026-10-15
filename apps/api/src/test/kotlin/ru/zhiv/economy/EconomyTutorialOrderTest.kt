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

    @Test fun `fresh profiles get a small pack and an already pinned first request`() {
        val fresh = EconomyRules.initial()
        assertEquals(EconomyWallet(100, 0), fresh.wallet)
        assertEquals(mapOf("stone" to 5L, "wood" to 3L), fresh.inventory)
        assertEquals(2, fresh.tutorialOrder.version); assertEquals(0, fresh.tutorialOrder.step)
        assertTrue(fresh.tutorialOrder.ingredientsClaimed); assertFalse(fresh.tutorialOrder.completed)
        assertEquals(EconomyRules.catalog.onboarding!!.residentOrder, fresh.tutorialOrder.terms)
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

    @Test fun `four requests spend actual goods sequentially and pay exactly 330 once`() {
        var state = EconomyRules.initial().copy(inventory = mapOf("berries" to 2L, "wood" to 2L, "berry_compote" to 2L, "planks" to 2L))
        val initialWallet = state.wallet
        val requests = EconomyTutorialOrders.orders(EconomyRules.catalog.onboarding!!)
        for ((index, request) in requests.withIndex()) {
            assertEquals(index, state.tutorialOrder.step); assertEquals(request, state.tutorialOrder.terms)
            for (other in requests.filter { it.id != request.id }) fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") {
                EconomyRules.apply(state, command("complete_resident_order", other.id), now) }
            val before = state
            state = complete(state)
            assertEquals(before.wallet.coins + request.coins, state.wallet.coins)
            assertEquals(index + 1, state.tutorialOrder.step)
            assertEquals(index == requests.lastIndex, state.tutorialOrder.completed)
            fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") {
                EconomyRules.apply(state, command("complete_resident_order", request.id), now) }
        }
        assertTrue(state.inventory.isEmpty())
        assertEquals(initialWallet.coins + 330, state.wallet.coins)
        assertEquals(4L, state.residentOrders.completed); assertEquals(330L, state.residentOrders.earnedCoins)
        fails("ECONOMY_TUTORIAL_ORDER_CLAIMED") { claim(state) }
    }

    @Test fun `legacy completion preserves saved reward and closes after its only request`() {
        val before = legacy(oldTerms().copy(coins = 123), true).copy(inventory = oldTerms().items)
        val saved = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(before))
        val after = complete(saved, now.plusSeconds(30 * 86400))
        assertEquals(before.wallet.coins + 123, after.wallet.coins)
        assertTrue(after.tutorialOrder.completed); assertEquals(1, after.tutorialOrder.version)
        assertEquals(0, after.tutorialOrder.step); assertEquals(before.tutorialOrder.terms, after.tutorialOrder.terms)
        fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") { complete(after) }
    }

    @Test fun `missing resources and wallet overflow preserve tutorial progress`() {
        val missing = EconomyRules.initial()
        fails("ECONOMY_RESOURCES") { complete(missing) }
        val full = missing.copy(inventory = mapOf("berries" to 2L), wallet = EconomyWallet(ECONOMY_MAX_BALANCE - 29))
        fails("ECONOMY_CAPACITY") { complete(full) }
        assertEquals(0, full.tutorialOrder.step); assertFalse(full.tutorialOrder.completed)
        fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") { EconomyRules.apply(missing, command("replace_resident_order"), now) }
        for (cmd in listOf(command(target = "workshop"), command(quantity = 2), command(price = 1)))
            fails("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(missing, cmd, now) }
    }

    @Test fun `home two requires all four requests only for v2 profiles`() {
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(250), inventory = mapOf("wood" to 3L, "stone" to 2L, "planks" to 2L))
        fails("ECONOMY_TUTORIAL_REQUIRED") { EconomyRules.apply(before, command("start_construction", "home"), now) }
        val built = before.copy(buildings = before.buildings + mapOf("woodlot" to 1, "dryer" to 1, "workshop" to 1))
        for (progress in listOf(EconomyTutorialOrder(), built.tutorialOrder.copy(step = 4, completed = true))) {
            val started = EconomyRules.apply(built.copy(tutorialOrder = progress), command("start_construction", "home"), now).first
            assertEquals(0L, started.wallet.coins); assertEquals(2, started.jobs.single().targetLevel)
        }
    }

    @Test fun `account merges retain furthest v2 step and never reopen active legacy rewards`() {
        val fresh = EconomyRules.initial().tutorialOrder
        val later = fresh.copy(step = 2, terms = EconomyTutorialOrders.orders(EconomyRules.catalog.onboarding!!)[2])
        val finished = later.copy(step = 4, completed = true)
        for ((a, b) in listOf(fresh to later, later to fresh, EconomyTutorialOrder() to later, later to EconomyTutorialOrder()))
            assertEquals(later, EconomyTutorialOrders.merge(a, b))
        for ((a, b) in listOf(later to finished, finished to later)) assertEquals(finished, EconomyTutorialOrders.merge(a, b))
        val old = EconomyTutorialOrder(ingredientsClaimed = true, terms = oldTerms(), completed = true)
        for ((a, b) in listOf(fresh to old, old to fresh)) assertEquals(old, EconomyTutorialOrders.merge(a, b))
    }
}
