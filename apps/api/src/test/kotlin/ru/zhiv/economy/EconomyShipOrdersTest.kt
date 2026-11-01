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
    private fun cargoRequest(order: EconomyShipOrder, item: String, amount: Long = 1) =
        request("load_ship_cargo", order.id).copy(voyageId = voyageId, orderId = order.id, itemId = item, quantity = amount)
    private fun completed(state: EconomyState = opened(), at: Instant = now): EconomyState = state.ship.voyage!!.orders.filter { it.deliveredAt == null }.fold(state) { current, order ->
        apply(current, "complete_ship_order", order.id, at)
    }
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `old saves and manifests default new fields and partial manifests roundtrip`() {
        val old = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(stocked())).jsonObject - "ship")
        assertEquals(EconomyShipState(), economyJson.decodeFromString<EconomyState>(old.toString()).ship)
        val accepted = opened()
        assertNull(accepted.ship.nextAvailableAt)
        assertEquals(20L, accepted.ship.voyage!!.rewardPearls)
        assertEquals(stocked().inventory, accepted.inventory)
        val oldOrder = """{"id":"$voyageId:0","templateId":"legacy","title":"Груз","items":{"wood":3},"rewardCoins":15} """
        val parsed = economyJson.decodeFromString<EconomyShipOrder>(oldOrder)
        assertEquals(emptyMap(), parsed.loadedItems)
        assertEquals(emptyMap(), parsed.rewardItems)
        assertEquals("medium", parsed.difficulty)
        val order = accepted.ship.voyage!!.orders.first()
        val partial = EconomyRules.apply(accepted, cargoRequest(order, order.items.keys.first()), now).first
        assertEquals(partial, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(partial)))
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

    @Test fun `every ship has increasing difficulties deterministic for server seed and diverse manifests`() {
        val voyage = opened().ship.voyage!!
        assertEquals(listOf("easy", "medium", "hard"), voyage.orders.map { it.difficulty })
        assertEquals(voyage.orders, opened().ship.voyage!!.orders)
        assertEquals(listOf("$voyageId:0", "$voyageId:1", "$voyageId:2"), voyage.orders.map { it.id })
        val variants = (0 until 20).map { index ->
            EconomyShipOrders.open(stocked(), now, "12345678-1234-4234-8234-${index.toString().padStart(12, '0')}")
                .ship.voyage!!.orders.map { it.templateId }
        }.toSet()
        assertTrue(variants.size > 1)
    }

    @Test fun `earliest lighthouse has all difficulties with sustainable cargo and bonus items`() {
        val early = stocked().copy(buildings = mapOf("home" to 3, "garden" to 1, "woodlot" to 2,
            "quarry" to 2, "workshop" to 3, "kiln" to 3, "dryer" to 1, "bridge" to 1, "lighthouse" to 1, "warehouse" to 1),
            progression = EconomyProgression())
        val eligible = EconomyShipOrders.eligibleTemplates(early)
        assertEquals(setOf("easy", "medium", "hard"), eligible.map { it.difficulty }.toSet())
        assertTrue(eligible.all { it.requiredHomeLevel <= 3 })
        val obtainable = EconomyFood.obtainableOrderItems(early)
        assertTrue(eligible.flatMap { it.items.keys + it.rewardItems.keys }.all { it in obtainable })
        assertFalse(eligible.any { "field_kit" in it.items || "tools" in it.items || "lens" in it.items })
        val giftOnly = EconomyRules.initial().copy(buildings = mapOf("home" to 3, "lighthouse" to 1), inventory = stocked().inventory)
        assertTrue(EconomyShipOrders.eligibleTemplates(giftOnly).isEmpty(), "Holding gifts cannot unlock a production chain")
        failure("ECONOMY_SHIP_UNAVAILABLE") { EconomyShipOrders.open(giftOnly, now, voyageId) }
    }

    @Test fun `shared TypeScript seed produces identical early home three difficulty and rewards`() {
        val early = EconomyRules.initial().copy(buildings = mapOf("home" to 3, "garden" to 1, "woodlot" to 2,
            "quarry" to 2, "workshop" to 3, "kiln" to 3, "dryer" to 1, "bridge" to 1, "lighthouse" to 1, "warehouse" to 1))
        val voyage = EconomyShipOrders.open(early, now, "11111111-1111-4111-8111-111111111111").ship.voyage!!
        assertEquals(listOf("driftwood_post", "sailmakers", "storm_watch"), voyage.orders.map { it.templateId })
        assertEquals(listOf("easy", "medium", "hard"), voyage.orders.map { it.difficulty })
        assertEquals(listOf(525L, 1575L, 2940L), voyage.orders.map { it.rewardCoins })
        assertEquals(listOf(emptyMap(), emptyMap(), mapOf("dried_berries" to 2L)), voyage.orders.map { it.rewardItems })
        assertEquals(listOf(mapOf("planks" to 6L, "rope" to 4L), mapOf("cloth" to 5L, "rope" to 8L),
            mapOf("berry_compote" to 12L, "dried_berries" to 10L, "rope" to 8L)), voyage.orders.map { it.items })
        assertEquals(20L, voyage.rewardPearls)
    }

    @Test fun `partial loading deducts only specified amount without early reward and resumes after reload`() {
        val before = opened()
        val order = before.ship.voyage!!.orders.first()
        val item = order.items.keys.first()
        val after = EconomyRules.apply(before, cargoRequest(order, item), now).first
        assertEquals(before.inventory.getValue(item) - 1, after.inventory.getValue(item))
        assertEquals(before.wallet, after.wallet)
        assertEquals(mapOf(item to 1L), after.ship.voyage!!.orders.first().loadedItems)
        assertNull(after.ship.voyage!!.orders.first().deliveredAt)
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(after))
        val paid = apply(restored, "complete_ship_order", order.id)
        assertEquals(before.wallet.coins + order.rewardCoins, paid.wallet.coins)
        for ((id, count) in before.inventory) assertEquals(count - (order.items[id] ?: 0) + (order.rewardItems[id] ?: 0), paid.inventory[id] ?: 0)
        assertEquals(order.items, paid.ship.voyage!!.orders.first().loadedItems)
        failure("ECONOMY_SHIP_CHANGED") { apply(paid, "complete_ship_order", order.id) }
    }

    @Test fun `unavailable goods oversized loads and cross voyage commands preserve state`() {
        val before = opened()
        val order = before.ship.voyage!!.orders.first()
        val item = order.items.keys.first()
        val command = cargoRequest(order, item)
        val empty = before.copy(inventory = emptyMap())
        failure("ECONOMY_RESOURCES") { EconomyRules.apply(empty, command, now) }
        failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(before, command.copy(quantity = order.items.getValue(item) + 1), now) }
        failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(before, command.copy(itemId = "missing"), now) }
        failure("ECONOMY_SHIP_CHANGED") { EconomyRules.apply(before, command.copy(voyageId = UUID.randomUUID().toString()), now) }
        assertEquals(emptyMap(), before.ship.voyage!!.orders.first().loadedItems)
    }

    @Test fun `final loading automatically pays ten pearls and next six hours start at departure`() {
        val before = opened()
        val finishAt = now.plusSeconds(5 * 3600 + 55 * 60)
        val after = completed(before, finishAt)
        assertEquals(before.wallet.pearls + 20, after.wallet.pearls)
        assertEquals(before.wallet.coins + before.ship.voyage!!.orders.sumOf { it.rewardCoins }, after.wallet.coins)
        assertEquals(1L, after.ship.completedVoyages)
        assertNull(after.ship.voyage)
        assertEquals(finishAt.plusSeconds(21600).toString(), after.ship.nextAvailableAt)
        failure("ECONOMY_SHIP_WAIT") { apply(after, "open_ship_voyage", "port", now.plusSeconds(21600)) }
        failure("ECONOMY_SHIP_WAIT") { apply(after, "open_ship_voyage", "port", finishAt.plusSeconds(21599)) }
        val next = apply(after, "open_ship_voyage", "port", finishAt.plusSeconds(21600))
        assertEquals(2L, next.ship.voyage!!.number)
        assertNull(next.ship.nextAvailableAt)
        failure("ECONOMY_SHIP_CHANGED") { apply(after, "claim_ship_voyage", voyageId) }
        failure("ECONOMY_SHIP_CHANGED") { apply(next, "complete_ship_order", "$voyageId:2", finishAt.plusSeconds(21600)) }
    }

    @Test fun `legacy promised goods remain unchanged while completed manifest gets fixed ten pearls`() {
        val source = opened()
        val voyage = source.ship.voyage!!
        val frozen = source.copy(ship = source.ship.copy(voyage = voyage.copy(rewardPearls = 6,
            orders = voyage.orders.map { it.copy(deliveredAt = now.toString()) })))
        val after = apply(frozen, "claim_ship_voyage", voyage.id, now.plusSeconds(90000))
        assertEquals(source.wallet.pearls + 20, after.wallet.pearls)
        assertEquals(now.plusSeconds(111600).toString(), after.ship.nextAvailableAt)
        failure("ECONOMY_SHIP_CHANGED") { apply(after, "claim_ship_voyage", voyage.id) }
    }

    @Test fun `skip never cancels paid or unpaid cargo even after several days`() {
        val accepted = opened()
        failure("ECONOMY_SHIP_CANNOT_SKIP") { apply(accepted, "skip_ship_voyage", voyageId) }
        val paid = apply(accepted, "complete_ship_order", "$voyageId:0")
        failure("ECONOMY_SHIP_CANNOT_SKIP") { apply(paid, "skip_ship_voyage", voyageId, now.plusSeconds(86400 * 7)) }
        failure("ECONOMY_SHIP_ACTIVE") { apply(paid, "open_ship_voyage", "port", now.plusSeconds(86400 * 7)) }
        assertNotNull(paid.ship.voyage)
    }

    @Test fun `optional item rewards paid once and excessive warehouse growth rolls back last load`() {
        val source = opened()
        val voyage = source.ship.voyage!!
        val promised = voyage.orders.first().copy(items = mapOf("wood" to 1L), rewardItems = mapOf("stone" to 2L))
        val before = source.copy(inventory = mapOf("wood" to 1L), ship = source.ship.copy(voyage = voyage.copy(orders = listOf(promised) + voyage.orders.drop(1))))
        val after = apply(before, "complete_ship_order", promised.id)
        assertEquals(mapOf("stone" to 2L), after.inventory)
        failure("ECONOMY_SHIP_CHANGED") { apply(after, "complete_ship_order", promised.id) }
        val full = before.copy(inventory = mapOf("wood" to 1L, "stone" to EconomyRules.storage(before).capacity - 1))
        failure("ECONOMY_STORAGE_FULL") { apply(full, "complete_ship_order", promised.id) }
        assertNull(full.ship.voyage!!.orders.first().deliveredAt)
        val reserved = before.copy(inventory = mapOf("wood" to 1L))
        failure("ECONOMY_STORAGE_FULL") { EconomyRules.apply(reserved, request("complete_ship_order", promised.id), now,
            mapOf("stone" to EconomyRules.storage(reserved).capacity - 1)) }
    }

    @Test fun `full pearl wallet rejects final cargo atomically but allows earlier partial loads`() {
        val source = opened()
        var before = apply(source, "complete_ship_order", "$voyageId:0")
        before = apply(before, "complete_ship_order", "$voyageId:1")
        before = before.copy(wallet = before.wallet.copy(pearls = ECONOMY_MAX_PEARLS))
        failure("ECONOMY_CAPACITY") { apply(before, "complete_ship_order", "$voyageId:2") }
        assertNull(before.ship.voyage!!.orders.last().deliveredAt)
        assertEquals(0L, before.ship.completedVoyages)
    }

    @Test fun `cargo protocol rejects missing contradictory extra and wrong typed fields`() {
        val before = opened()
        val order = before.ship.voyage!!.orders.first()
        val valid = cargoRequest(order, order.items.keys.first())
        listOf(valid.copy(voyageId = null), valid.copy(orderId = null), valid.copy(itemId = null), valid.copy(targetId = "wrong"),
            valid.copy(quantity = 0), valid.copy(quantity = 10001), valid.copy(totalPrice = 1), valid.copy(fishSelection = emptyMap()),
            valid.copy(action = "sell")).forEach { failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(before, it, now) } }
        val json = economyJson.parseToJsonElement(economyJson.encodeToString(valid))
        assertEquals(valid, decodeEconomyCommand(json))
        val wrong = economyJson.parseToJsonElement(economyJson.encodeToString(valid).replace("\"itemId\":\"${valid.itemId}\"", "\"itemId\":3"))
        failure("INVALID_ECONOMY_COMMAND") { decodeEconomyCommand(wrong) }
    }

    @Test fun `merge preserves partial loads and latest cooldown but rejects two active voyages`() {
        val before = opened(); val order = before.ship.voyage!!.orders.first()
        val a = EconomyRules.apply(before, cargoRequest(order, order.items.keys.first()), now).first.ship
        val b = EconomyShipState(completedVoyages = 8, nextAvailableAt = now.plusSeconds(86400).toString())
        val merged = EconomyShipOrders.merge(a, b)
        assertEquals(a.voyage, merged.voyage)
        assertEquals(8L, merged.completedVoyages)
        assertEquals(b.nextAvailableAt, merged.nextAvailableAt)
        assertEquals(merged, EconomyShipOrders.merge(b, a))
        failure("ACCOUNT_MERGE_CONFLICT") { EconomyShipOrders.merge(a, a) }
    }
}
