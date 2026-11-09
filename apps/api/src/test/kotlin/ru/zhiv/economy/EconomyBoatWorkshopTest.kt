package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyBoatWorkshopTest {
    private val time = Instant.parse("2026-11-05T15:45:37Z")
    private val config get() = requireNotNull(EconomyRules.catalog.boat)
    private fun player(boat: EconomyBoatState) = EconomyRules.initial().copy(boat = boat,
        buildings = mapOf("home" to 1), inventory = emptyMap(),
        wallet = EconomyWallet(1_000_000, 500))
    private fun command(s: EconomyState, action: String, target: String, now: Instant = time, price: Long = 0) =
        EconomyBoats.command(s, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, totalPrice = price), now).first
    private fun rejects(code: String, call: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = call).code)

    @Test fun `old dock and active work grant the mapped tier only once regardless of data format`() {
        val old = economyJson.decodeFromString<EconomyBoatState>("""{"level":1,"upgrades":["oars","crate"]}""")
        assertEquals(EconomyBoatModules(1,1,0,1), EconomyBoatWorkshop.modules(old))
        val first = player(old)
        rejects("ECONOMY_BOAT_UPGRADE") { command(first,"start_boat_upgrade","oars") }
        rejects("ECONOMY_BOAT_UPGRADE") { command(first,"start_boat_upgrade","engine_3") }
        val started = command(first,"start_boat_upgrade","engine_2")
        val bill = config.upgrades.single { it.id == "engine_2" }
        assertEquals(first.wallet.coins - bill.cost.coins, started.wallet.coins)
        assertEquals(first.inventory, started.inventory)
        val work = started.boat!!.work!!
        val installed = command(started, "claim_boat_upgrade", work.id, Instant.parse(work.finishesAt))
        assertEquals(2, EconomyBoatWorkshop.modules(installed.boat!!).engine)
        assertEquals(old.upgrades, installed.boat!!.upgrades)
        rejects("ECONOMY_BOAT_WORK_GONE") { command(installed, "claim_boat_upgrade", work.id, Instant.parse(work.finishesAt)) }

        val pending = EconomyBoatState(level=1, work=EconomyBoatWork(UUID.randomUUID().toString(), "crate",
            time.minusSeconds(1000).toString(), time.minusSeconds(10).toString(), EconomyCost(600, mapOf("rope" to 3))))
        val converted = command(player(pending), "claim_boat_upgrade", pending.work!!.id).boat!!
        assertEquals(1, EconomyBoatWorkshop.modules(converted).storage)
        assertEquals(listOf("crate"), converted.upgrades)
    }

    @Test fun `all four modules can be installed sequentially and effects are frozen in a new voyage`() {
        var state = player(EconomyBoatState(level=1))
        var now = time
        for (module in listOf("hull", "engine", "tank", "storage")) {
            for (tier in (if (module == "hull") 2 else 1)..5) {
                val upgrade = config.upgrades.single { it.module == module && it.tier == tier }
                val paid = command(state, "start_boat_upgrade", upgrade.id, now)
                val work = paid.boat!!.work!!
                now = Instant.parse(work.finishesAt)
                state = command(paid, "claim_boat_upgrade", work.id, now)
                assertEquals(tier, EconomyBoatWorkshop.modules(state.boat!!).tier(module))
            }
        }
        assertEquals(1_000_000L - 47_150, state.wallet.coins)
        assertTrue(state.inventory.isEmpty())
        val outward = command(state,"depart_boat",config.routeId,now)
        val voyage = outward.boat!!.voyage!!
        assertEquals(9, voyage.maxCatches)
        assertEquals(11, voyage.slots.size)
        assertEquals("fishing", EconomyBoats.phase(outward.boat!!,now))
        val cast = command(outward,"begin_boat_cast",voyage.id,now)
        val challenge = cast.boat!!.voyage!!.challenge!!
        assertEquals(5, challenge.rulesVersion)
        assertEquals(5, challenge.motorResponse)
        assertEquals(20, challenge.hullDamping)
        assertEquals(cast, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(cast)))
        val returned = command(cast,"return_boat",voyage.id,now.plusSeconds(2))
        assertEquals("ready", EconomyBoats.phase(returned.boat!!,now.plusSeconds(2)))
        assertNull(command(returned,"claim_boat",voyage.id,now.plusSeconds(2)).boat!!.voyage)
    }

    @Test fun `refill uses elapsed server time with no banked credit past capacity and charges only an empty dock`() {
        val dock = EconomyBoatState(level = 1)
        val full = EconomyBoatWorkshop.fuel(dock, time)
        assertEquals(config.fuel.baseCapacity, full.cells); assertNull(full.nextAt)
        val departure = command(player(dock), "depart_boat",config.routeId)
        val onboard = departure.boat!!
        assertEquals(full.cells - 1, onboard.fuel!!.cells)
        assertEquals(time.plusSeconds(1800), Instant.parse(onboard.fuel!!.nextAt))
        assertEquals(full.cells - 1, EconomyBoatWorkshop.fuel(onboard, time.plusSeconds(1799)).cells)
        assertEquals(full, EconomyBoatWorkshop.fuel(onboard, time.plusSeconds(86_400)))
        val empty = dock.copy(fuel = EconomyBoatFuel(0, time.plusSeconds(10).toString()))
        val base = player(empty)
        val price = config.fuel.refillPricePearls
        fun buy(s: EconomyState, at: Instant = time, ask: Long = price) = command(s,"buy_boat_fuel","fuel_cell",at,ask)
        rejects("ECONOMY_BOAT_DEPARTURE") { command(base,"depart_boat",config.routeId) }
        rejects("ECONOMY_BOAT_FUEL_PRICE") { buy(base, ask = price - 1) }
        rejects("ECONOMY_PEARLS") { buy(base.copy(wallet = EconomyWallet(500,price - 1))) }
        rejects("ECONOMY_BOAT_FUEL") { buy(base,time.plusSeconds(10)) }
        rejects("ECONOMY_BOAT_FUEL") { buy(departure) }
        val topped = buy(base)
        assertEquals(base.wallet.pearls - price, topped.wallet.pearls)
        assertEquals(empty.fuel!!.nextAt, topped.boat!!.fuel!!.nextAt)
        assertEquals(1, topped.boat!!.fuel!!.cells)
        assertEquals(full, EconomyBoatWorkshop.fuel(topped.boat!!,time.plusSeconds(10)))
        rejects("ECONOMY_BOAT_FUEL") { buy(topped) }
        val afterLongIdle = command(base,"depart_boat",config.routeId,time.plusSeconds(86_400)).boat!!
        assertEquals(1, afterLongIdle.fuel!!.cells)
        assertEquals(time.plusSeconds(86_400 + 1800), Instant.parse(afterLongIdle.fuel!!.nextAt))
    }

    @Test fun `tank install and merged accounts retain partial fuel timers without adding both balances`() {
        val dock = EconomyBoatState(level = 1)
        val grown = EconomyBoatWorkshop.install(dock,"tank_1",time)
        assertEquals(config.fuel.baseCapacity, grown.fuel!!.cells)
        assertEquals(time.plusSeconds(1800), Instant.parse(grown.fuel!!.nextAt))
        val pending = EconomyBoatFuel(0, time.plusSeconds(8).toString())
        val low = dock.copy(fuel=pending)
        assertEquals(pending, EconomyBoatWorkshop.install(low,"tank_1",time).fuel)
        assertEquals(pending, EconomyBoats.merge(low,EconomyBoatState(),time)!!.fuel)
        val two = low.copy(modules=EconomyBoatModules(tank=2), fuel=EconomyBoatFuel(1,time.plusSeconds(60).toString()))
        val merged = EconomyBoats.merge(grown,two,time)!!
        assertEquals(2, merged.modules!!.tank)
        assertEquals(grown.fuel, merged.fuel)
    }
}
