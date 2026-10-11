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
    private fun claim(state: EconomyState = EconomyRules.initial()) = EconomyRules.apply(state, command(), now).first
    private fun complete(state: EconomyState, at: Instant = now) = EconomyRules.apply(state, command("complete_resident_order"), at).first
    private fun fails(code: String, block: () -> Unit) { assertEquals(code, assertFailsWith<AuthFailure>(block = block).code) }

    @Test fun `starting pack preserves conversion and uses current stored money units`() {
        val fresh = EconomyRules.initial()
        assertEquals(EconomyWallet(2500, 1000), fresh.wallet)
        assertEquals(mapOf("fish" to 10L, "stone" to 10L, "wood" to 10L), fresh.inventory)
        assertTrue(fresh.fishing.catches.isEmpty())
        assertFalse(fresh.workshopStarterClaimed)
        val legacy = EconomyRules.initial(100, 81, 49, 4, 2)
        assertEquals(EconomyMigration(coinsGranted = 360, woodGranted = 9, stoneGranted = 7), legacy.migration)
        assertEquals(EconomyWallet(2860, 1000), legacy.wallet)
        assertEquals(mapOf("fish" to 10L, "wood" to 19L, "stone" to 17L), legacy.inventory)
        assertEquals(EconomyWallet(), EconomyRules.initial(includeStartingPack = false).wallet)
        assertTrue(EconomyRules.initial(includeStartingPack = false).inventory.isEmpty())
    }

    @Test fun `older saved state gains compatible progress fields without resetting balances`() {
        val previous = EconomyRules.initial().copy(wallet = EconomyWallet(21, 4), inventory = mapOf("stone" to 2L))
        val json = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(previous)).jsonObject - "tutorialOrder")
        val decoded = economyJson.decodeFromString<EconomyState>(json.toString())
        assertEquals(previous.wallet, decoded.wallet); assertEquals(previous.inventory, decoded.inventory)
        assertEquals(EconomyTutorialOrder(), decoded.tutorialOrder)
    }

    @Test fun `explicit grant adds exact ingredients without paying coins constructing or replacing normal offers`() {
        val before = EconomyRules.initial(); val after = claim(before)
        assertEquals(before.wallet, after.wallet)
        assertEquals(mapOf("fish" to 10L, "wood" to 12L, "stone" to 10L, "berries" to 3L), after.inventory)
        assertTrue(after.tutorialOrder.ingredientsClaimed); assertFalse(after.tutorialOrder.completed)
        assertEquals(EconomyRules.catalog.onboarding!!.residentOrder, after.tutorialOrder.terms)
        assertEquals(EconomyFood.residentOrderBoard(before, now).offers, EconomyFood.residentOrderBoard(after, now).offers)
        assertEquals(before.jobs, after.jobs); assertEquals(before.buildings, after.buildings)
    }

    @Test fun `completion spends the saved request once with one reward and no board replacement`() {
        val before = claim(); val after = complete(before)
        assertEquals(mapOf("fish" to 10L, "stone" to 10L, "wood" to 10L), after.inventory)
        assertEquals(before.wallet.coins + 100, after.wallet.coins)
        assertEquals(before.wallet.pearls, after.wallet.pearls)
        assertTrue(after.tutorialOrder.completed)
        assertEquals(1L, after.residentOrders.completed); assertEquals(100L, after.residentOrders.earnedCoins)
        assertEquals(EconomyFood.residentOrderBoard(before, now).offers, EconomyFood.residentOrderBoard(after, now).offers)
        fails("ECONOMY_TUTORIAL_ORDER_CLAIMED") { claim(after) }
        fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") { complete(after) }
    }

    @Test fun `request survives serialization and month boundaries with frozen terms`() {
        val before = claim()
        val saved = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(before))
        val changed = saved.copy(tutorialOrder = saved.tutorialOrder.copy(terms = saved.tutorialOrder.terms!!.copy(coins = 123)))
        val after = complete(changed, now.plusSeconds(30 * 86400))
        assertEquals(before.wallet.coins + 123, after.wallet.coins)
        assertTrue(after.tutorialOrder.completed)
    }

    @Test fun `selling ingredients prevents submission and does not reopen a grant`() {
        val before = claim().copy(inventory = mapOf("wood" to 2L))
        fails("ECONOMY_RESOURCES") { complete(before) }
        fails("ECONOMY_TUTORIAL_ORDER_CLAIMED") { claim(before) }
        assertFalse(before.tutorialOrder.completed)
        assertTrue(complete(before.copy(inventory = mapOf("wood" to 2L, "berries" to 3L))).tutorialOrder.completed)
    }

    @Test fun `capacity guards include escrow and reject before consuming progress`() {
        val full = EconomyRules.initial().copy(inventory = mapOf("stone" to 200L))
        fails("ECONOMY_STORAGE_FULL") { claim(full) }
        assertFalse(full.tutorialOrder.ingredientsClaimed)
        val nearlyFull = full.copy(inventory = mapOf("stone" to 195L))
        fails("ECONOMY_STORAGE_FULL") { EconomyRules.apply(nearlyFull, command(), now, mapOf("wood" to 1L)) }
        assertEquals(200L, EconomyRules.storage(claim(nearlyFull)).used)
        val walletFull = claim().copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE - 99, 1000))
        fails("ECONOMY_CAPACITY") { complete(walletFull) }
        assertFalse(walletFull.tutorialOrder.completed)
    }

    @Test fun `unclaimed or replace requests and forged grant parameters cannot mutate state`() {
        val before = EconomyRules.initial()
        fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") { complete(before) }
        fails("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE") { EconomyRules.apply(claim(), command("replace_resident_order"), now) }
        for (cmd in listOf(command(target = "workshop"), command(quantity = 2), command(price = 1)))
            fails("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(before, cmd, now) }
    }

    @Test fun `account merge keeps paid progress monotonic in either direction`() {
        val empty = EconomyTutorialOrder(); val accepted = claim().tutorialOrder; val finished = complete(claim()).tutorialOrder
        for ((a, b) in listOf(empty to accepted, accepted to empty)) assertEquals(accepted, EconomyTutorialOrders.merge(a, b))
        for ((a, b) in listOf(empty to finished, finished to empty, accepted to finished, finished to accepted)) {
            val merged = EconomyTutorialOrders.merge(a, b)
            assertTrue(merged.ingredientsClaimed); assertTrue(merged.completed)
            fails("ECONOMY_TUTORIAL_ORDER_CLAIMED") { claim(EconomyRules.initial().copy(tutorialOrder = merged)) }
        }
    }

    @Test fun `first workshop retains its separate full gift after practice`() {
        val before = complete(claim())
        val after = EconomyRules.apply(before, command("claim_workshop_starter", "workshop"), now).first
        val cost = EconomyWorkshopStarter.cost()
        assertEquals(before.wallet.coins + cost.coins, after.wallet.coins)
        cost.items.forEach { (id, count) -> assertEquals((before.inventory[id] ?: 0) + count, after.inventory[id]) }
        assertTrue(after.workshopStarterClaimed); assertEquals(before.tutorialOrder, after.tutorialOrder)
    }
}
