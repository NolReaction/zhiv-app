package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyTelescopeTest {
    private val now = Instant.parse("2026-11-02T10:00:00Z")
    private fun player() = EconomyRules.initial().copy(
        buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.last().level },
        boat = EconomyBoatState(level = 1, artifacts = listOf("telescope")))
    private fun command(action: String, target: String = "port") =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun inspect(state: EconomyState, at: Instant = now) = EconomyRules.apply(state, command("inspect_telescope"), at).first

    @Test fun `inspection requires the crafted artifact and a claimed lighthouse`() {
        assertEquals("ECONOMY_TELESCOPE_LOCKED", assertFailsWith<AuthFailure> { inspect(player().copy(boat = null)) }.code)
        assertEquals("ECONOMY_SHIP_LOCKED", assertFailsWith<AuthFailure> {
            inspect(player().copy(buildings = player().buildings + ("lighthouse" to 0)))
        }.code)
    }

    @Test fun `forecast survives serialization and repeated inspections without starting the port clock`() {
        val first = inspect(player())
        assertNull(first.ship.voyage)
        val predicted = first.ship.nextVoyage!!
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(first))
        assertEquals(predicted, inspect(restored, now.plusSeconds(500)).ship.nextVoyage)
        assertNull(inspect(restored).ship.voyage)
    }

    @Test fun `arrival uses the exact saved cargo and starts its own full stay`() {
        val first = inspect(player())
        val predicted = first.ship.nextVoyage!!
        val arrival = now.plusSeconds(500)
        val opened = EconomyRules.apply(first, command("open_ship_voyage"), arrival).first
        assertEquals(predicted.id, opened.ship.voyage!!.id)
        assertEquals(predicted.orders, opened.ship.voyage!!.orders)
        assertEquals(arrival.toString(), opened.ship.voyage!!.openedAt)
        assertNull(opened.ship.nextVoyage)
    }

    @Test fun `a forecast while a ship is present is retained through automatic departure`() {
        val current = EconomyShipOrders.open(player(), now)
        val inspected = inspect(current)
        val predicted = inspected.ship.nextVoyage!!
        assertNotEquals(inspected.ship.voyage!!.id, predicted.id)
        val arrival = EconomyShipOrders.departureAt(inspected.ship.voyage!!).plusSeconds(EconomyShipOrders.config.intervalSeconds)
        val opened = EconomyRules.apply(inspected, command("open_ship_voyage"), arrival).first
        assertEquals(predicted.orders, opened.ship.voyage!!.orders)
        assertNull(opened.ship.nextVoyage)
    }

    @Test fun `account merge cannot silently throw away either promised manifest`() {
        val first = inspect(player()).ship
        val second = inspect(player()).ship
        assertEquals("ACCOUNT_MERGE_CONFLICT", assertFailsWith<AuthFailure> { EconomyShipOrders.merge(first, second) }.code)
        assertEquals(first.nextVoyage, EconomyShipOrders.merge(first, EconomyShipState()).nextVoyage)
    }
}
