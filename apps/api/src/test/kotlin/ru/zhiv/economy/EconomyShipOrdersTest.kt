package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyShipOrdersTest {
    private val now = Instant.parse("2026-11-01T12:00:00Z")
    private val voyageId = "12345678-1234-4234-8234-123456789abc"
    private val catalog = EconomyRules.catalog
    private fun stocked() = EconomyRules.initial().copy(wallet = EconomyWallet(100_000, 100),
        buildings = catalog.buildings.associate { it.id to it.levels.last().level },
        inventory = catalog.items.filter { item -> catalog.fishing!!.fish.none { it.itemId == item.id } }.associate { it.id to 100L },
        progression = EconomyProgression(recipes = catalog.recipes.associate { it.id to 100L }))
    private fun request(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, request(action, target), at).first
    private fun opened(state: EconomyState = stocked()) = EconomyShipOrders.open(state, now, voyageId)
    private fun completed(state: EconomyState = opened(), at: Instant = now): EconomyState = state.ship.voyage!!.orders.filter { it.deliveredAt == null }.fold(state) { current, order ->
        apply(current, "complete_ship_order", order.id, at)
    }
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `old saves default to empty port and accepted frozen manifests roundtrip`() {
        val old = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(stocked())).jsonObject - "ship")
        assertEquals(EconomyShipState(), economyJson.decodeFromString<EconomyState>(old.toString()).ship)
        val accepted = opened()
        assertEquals(accepted, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(accepted)))
        assertEquals(stocked().wallet, accepted.wallet)
        assertEquals(stocked().inventory, accepted.inventory)
        assertEquals(1L, accepted.ship.voyage!!.number)
        assertEquals(now.plusSeconds(21600).toString(), accepted.ship.nextAvailableAt)
    }

    @Test fun `lighthouse must be claimed and request id cannot choose a manifest`() {
        val locked = stocked().copy(buildings = stocked().buildings + ("lighthouse" to 0))
        failure("ECONOMY_SHIP_LOCKED") { apply(locked, "open_ship_voyage", "port") }
        val pending = locked.copy(jobs = listOf(EconomyJob(UUID.randomUUID().toString(), "construction", "lighthouse",
            targetLevel = 1, startedAt = now.minusSeconds(20).toString(), finishesAt = now.minusSeconds(1).toString())))
        failure("ECONOMY_SHIP_LOCKED") { apply(pending, "open_ship_voyage", "port") }
        val command = request("open_ship_voyage", "port")
        assertNotEquals(command.requestId, EconomyRules.apply(stocked(), command, now).first.ship.voyage!!.id)
    }

    @Test fun `three categories are deterministic for server seed and vary between players`() {
        val accepted = opened()
        val voyage = accepted.ship.voyage!!
        assertEquals(3, voyage.orders.size)
        assertEquals(listOf("supplies", "provisions", "craft"), voyage.orders.map { order ->
            EconomyShipOrders.config.templates.single { it.id == order.templateId }.group
        })
        assertEquals(voyage.orders, opened().ship.voyage!!.orders)
        assertEquals(listOf("$voyageId:0", "$voyageId:1", "$voyageId:2"), voyage.orders.map { it.id })
        val variants = (0 until 20).map { index ->
            EconomyShipOrders.open(stocked(), now, "12345678-1234-4234-8234-${index.toString().padStart(12, '0')}")
                .ship.voyage!!.orders.map { it.templateId }
        }.toSet()
        assertTrue(variants.size > 1)
    }

    @Test fun `shared seed and minimum home three factories match TypeScript cargo vector`() {
        val early = EconomyRules.initial().copy(buildings = mapOf("home" to 3, "garden" to 1, "woodlot" to 3,
            "quarry" to 3, "workshop" to 3, "kiln" to 3, "dryer" to 1, "bridge" to 1, "lighthouse" to 1, "warehouse" to 1))
        val voyage = EconomyShipOrders.open(early, now, "11111111-1111-4111-8111-111111111111").ship.voyage!!
        assertEquals(listOf("rigging" to 1050L, "berry_provisions" to 1554L, "sailmakers" to 1575L),
            voyage.orders.map { it.templateId to it.rewardCoins })
        assertEquals(8L, voyage.rewardPearls)
    }

    @Test fun `earliest lighthouse receives only sustainable goods and higher recipes require real unlocks`() {
        val source = stocked()
        val early = source.copy(buildings = mapOf("home" to 3, "garden" to 1, "woodlot" to 2,
            "quarry" to 2, "workshop" to 3, "kiln" to 3, "dryer" to 1, "bridge" to 1, "lighthouse" to 1, "warehouse" to 1),
            progression = EconomyProgression())
        val eligible = EconomyShipOrders.eligibleTemplates(early)
        assertEquals(setOf("supplies", "provisions", "craft"), eligible.map { it.group }.toSet())
        assertTrue(eligible.all { it.requiredHomeLevel <= 3 })
        assertTrue(eligible.flatMap { it.items.keys }.all { it in EconomyFood.obtainableOrderItems(early) })
        assertFalse(eligible.any { "field_kit" in it.items || "tools" in it.items || "lens" in it.items })
        val giftOnly = EconomyRules.initial().copy(buildings = mapOf("home" to 3, "lighthouse" to 1), inventory = source.inventory)
        assertTrue(EconomyShipOrders.eligibleTemplates(giftOnly).isEmpty(), "Holding a gift cannot unlock its production chain")
        failure("ECONOMY_SHIP_UNAVAILABLE") { EconomyShipOrders.open(giftOnly, now, voyageId) }
        val noRecipe = source.copy(progression = EconomyProgression())
        val custom = EconomyShipOrders.config.copy(templates = EconomyShipOrders.config.templates.map {
            if (it.id == "rigging") it.copy(items = mapOf("strawberries" to 2L)) else it
        })
        assertFalse(EconomyShipOrders.eligibleTemplates(noRecipe, ship = custom).any { it.id == "rigging" })
    }

    @Test fun `payouts are based on whole cargo sale values with only five percent extra`() {
        val ship = EconomyShipOrders.config
        assertEquals(8L, ship.rewardPearls)
        assertEquals(21600L, ship.intervalSeconds)
        opened().ship.voyage!!.orders.forEach { order ->
            val value = order.items.entries.sumOf { (id, count) -> EconomyRules.localSellPrice(
                catalog.items.single { it.id == id }.baseSellPrice, count, itemId = id) }
            assertEquals((value * 10500 + 9999) / 10000, order.rewardCoins)
        }
    }

    @Test fun `one whole cargo is charged and paid once without touching other cards or reputation`() {
        val before = opened()
        val order = before.ship.voyage!!.orders.first()
        val after = apply(before, "complete_ship_order", order.id)
        assertEquals(before.wallet.coins + order.rewardCoins, after.wallet.coins)
        assertEquals(before.wallet.pearls, after.wallet.pearls)
        before.inventory.forEach { (id, count) -> assertEquals(count - (order.items[id] ?: 0), after.inventory[id] ?: 0) }
        assertEquals(now.toString(), after.ship.voyage!!.orders.first().deliveredAt)
        assertTrue(after.ship.voyage!!.orders.drop(1).all { it.deliveredAt == null })
        assertEquals(before.tradeRelations, after.tradeRelations)
        failure("ECONOMY_SHIP_CHANGED") { apply(after, "complete_ship_order", order.id) }
    }

    @Test fun `missing goods and wallet caps reject before any payment or cargo state changes`() {
        val before = opened()
        val order = before.ship.voyage!!.orders.first()
        val missing = before.copy(inventory = order.items.mapValues { (_, count) -> count - 1 })
        val frozen = economyJson.encodeToString(missing)
        failure("ECONOMY_RESOURCES") { apply(missing, "complete_ship_order", order.id) }
        assertEquals(frozen, economyJson.encodeToString(missing))
        val fullWallet = before.copy(wallet = before.wallet.copy(coins = ECONOMY_MAX_BALANCE))
        failure("ECONOMY_CAPACITY") { apply(fullWallet, "complete_ship_order", order.id) }
        assertNull(fullWallet.ship.voyage!!.orders.first().deliveredAt)
    }

    @Test fun `accepted cargo and reward survive catalog replacement relocking and long absence`() {
        val before = opened()
        val voyage = before.ship.voyage!!
        val promised = voyage.orders.first().copy(title = "Сохранённый груз", templateId = "retired_template", items = mapOf("wood" to 1L), rewardCoins = 777)
        val frozen = before.copy(buildings = mapOf("lighthouse" to 1),
            ship = before.ship.copy(voyage = voyage.copy(orders = listOf(promised) + voyage.orders.drop(1), rewardPearls = 6)))
        val returnedAt = now.plusSeconds(86400L * 365)
        val after = apply(frozen, "complete_ship_order", promised.id, returnedAt)
        assertEquals(frozen.wallet.coins + 777, after.wallet.coins)
        assertEquals(frozen.inventory.getValue("wood") - 1, after.inventory.getValue("wood"))
        val all = completed(after, returnedAt)
        val claimed = apply(all, "claim_ship_voyage", voyage.id, returnedAt)
        assertEquals(before.wallet.pearls + 6, claimed.wallet.pearls)
    }

    @Test fun `full reward requires three loads and only explicit claim grants pearls once`() {
        val before = opened()
        failure("ECONOMY_SHIP_INCOMPLETE") { apply(before, "claim_ship_voyage", voyageId) }
        val ready = completed(before)
        assertEquals(before.wallet.pearls, ready.wallet.pearls)
        failure("ECONOMY_SHIP_COMPLETE") { apply(ready, "skip_ship_voyage", voyageId) }
        val after = apply(ready, "claim_ship_voyage", voyageId)
        assertEquals(before.wallet.pearls + before.ship.voyage!!.rewardPearls, after.wallet.pearls)
        assertEquals(1L, after.ship.completedVoyages)
        assertNull(after.ship.voyage)
        assertEquals(before.ship.nextAvailableAt, after.ship.nextAvailableAt)
        failure("ECONOMY_SHIP_CHANGED") { apply(after, "claim_ship_voyage", voyageId) }
        failure("ECONOMY_SHIP_CHANGED") { apply(after, "complete_ship_order", "$voyageId:2") }
    }

    @Test fun `full pearl wallet leaves ready reward intact for later claim`() {
        val ready = completed().let { it.copy(wallet = it.wallet.copy(pearls = ECONOMY_MAX_PEARLS)) }
        failure("ECONOMY_CAPACITY") { apply(ready, "claim_ship_voyage", voyageId) }
        assertNotNull(ready.ship.voyage)
        assertTrue(ready.ship.voyage!!.orders.all { it.deliveredAt != null })
        assertEquals(0L, ready.ship.completedVoyages)
    }

    @Test fun `skip preserves paid cargo and cooldown and never refunds or completes the voyage`() {
        val accepted = opened()
        val paid = apply(accepted, "complete_ship_order", "$voyageId:0")
        val skipped = apply(paid, "skip_ship_voyage", voyageId)
        assertEquals(paid.wallet, skipped.wallet)
        assertEquals(paid.inventory, skipped.inventory)
        assertEquals(0L, skipped.ship.completedVoyages)
        assertNull(skipped.ship.voyage)
        failure("ECONOMY_SHIP_WAIT") { apply(skipped, "open_ship_voyage", "port", now.plusSeconds(21599)) }
        val next = apply(skipped, "open_ship_voyage", "port", now.plusSeconds(21600))
        assertNotEquals(voyageId, next.ship.voyage!!.id)
        assertEquals(1L, next.ship.voyage!!.number)
        failure("ECONOMY_SHIP_CHANGED") { apply(next, "complete_ship_order", "$voyageId:1", now.plusSeconds(21600)) }
    }

    @Test fun `active manifest cannot be replaced and malformed command extras are rejected`() {
        val before = opened()
        failure("ECONOMY_SHIP_ACTIVE") { apply(before, "open_ship_voyage", "port", now.plusSeconds(86400)) }
        failure("INVALID_ECONOMY_COMMAND") { apply(stocked(), "open_ship_voyage", voyageId) }
        listOf(request("complete_ship_order", "$voyageId:0").copy(quantity = 2),
            request("complete_ship_order", "$voyageId:0").copy(totalPrice = 1),
            request("complete_ship_order", "$voyageId:0").copy(fishSelection = emptyMap())).forEach { command ->
            failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(before, command, now) }
        }
        failure("ECONOMY_CAPACITY") { EconomyShipOrders.open(stocked().copy(ship = EconomyShipState(completedVoyages = ECONOMY_MAX_REVISION)), now) }
    }

    @Test fun `merge preserves one paid manifest latest cooldown and rejects two active manifests`() {
        val a = apply(opened(), "complete_ship_order", "$voyageId:0").ship
        val b = EconomyShipState(completedVoyages = 8, nextAvailableAt = now.plusSeconds(86400).toString())
        val merged = EconomyShipOrders.merge(a, b)
        assertEquals(a.voyage, merged.voyage)
        assertEquals(8L, merged.completedVoyages)
        assertEquals(b.nextAvailableAt, merged.nextAvailableAt)
        assertEquals(merged, EconomyShipOrders.merge(b, a))
        failure("ACCOUNT_MERGE_CONFLICT") { EconomyShipOrders.merge(a, a) }
    }
}
