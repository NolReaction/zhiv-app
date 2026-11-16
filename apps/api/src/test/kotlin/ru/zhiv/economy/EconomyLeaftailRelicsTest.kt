package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyLeaftailRelicsTest {
    private val now = Instant.parse("2026-10-26T12:00:00Z")
    private val relics = listOf("ancient_core", "moon_crystal", "living_resin")
    private val fee = 20_000L
    private fun ready() = EconomyRules.initial(homeLevel = 4).copy(
        wallet = EconomyWallet(100_000, 300), inventory = mapOf("moon_crystal" to 4L),
        rareDropState = EconomyRareDropClock(remainingSeconds = 9000, itemId = "living_resin"),
        minerRareDropState = EconomyRareDropClock(remainingSeconds = 12000, itemId = "ancient_core"),
    )
    private fun command(target: String = "moon_crystal:ancient_core") =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, "exchange_leaftail_relic", target, 1, fee)
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `six ordered pairs have exact cost and never advance rare clocks jobs reputation or pearl wallet`() {
        val config = checkNotNull(EconomyRules.catalog.leaftailShop?.relicExchange)
        assertEquals(4, config.requiredHomeLevel); assertEquals(2L, config.quantity); assertEquals(fee, config.priceCoins)
        for (from in relics) for (to in relics.filter { it != from }) {
            val before = ready().copy(inventory = mapOf(from to 2L))
            val (after, notice) = EconomyRules.apply(before, command("$from:$to"), now)
            assertEquals("Реликвии обменены. Находка отправлена в кладовую", notice)
            assertEquals(mapOf(to to 1L), after.inventory)
            assertEquals(before.wallet.copy(coins = before.wallet.coins - fee), after.wallet)
            assertEquals(before.rareDropState, after.rareDropState); assertEquals(before.minerRareDropState, after.minerRareDropState)
            assertEquals(before.jobs, after.jobs); assertEquals(before.progression, after.progression)
            assertEquals(before.completedExplorations, after.completedExplorations)
            assertEquals(before.tradeRelations, after.tradeRelations); assertEquals(before.leaftailShop, after.leaftailShop)
        }
    }

    @Test fun `private pending rewards and frozen cost and speed survive exchange unchanged`() {
        val state = ready().copy(jobs = listOf(EconomyJob(id = UUID.randomUUID().toString(), kind = "exploration",
            targetId = "quarry", actorId = "miner", startedAt = now.toString(), finishesAt = now.plusSeconds(90).toString(),
            rewards = mapOf("ancient_core" to 1L, "stone" to 4L), cost = EconomyCost(coins = 123, items = mapOf("wood" to 2L)),
            catalogVersion = 14, tradeSpeedBps = 700, rareDrop = EconomyRareDropDelivery(seconds = 90, itemId = "ancient_core"),
            expeditionFinds = mapOf("moon_crystal" to 1L),
        )))
        val after = EconomyRules.apply(state, command(), now).first
        assertEquals(state.jobs, after.jobs); assertEquals(state.progression, after.progression)
        assertEquals(state.rareDropState, after.rareDropState); assertEquals(state.minerRareDropState, after.minerRareDropState)
    }

    @Test fun `completed home four is required even if upgrade is already paid`() {
        val state = ready().copy(buildings = ready().buildings + ("home" to 3), jobs = listOf(EconomyJob(
            id = UUID.randomUUID().toString(), kind = "construction", targetId = "home", targetLevel = 4,
            startedAt = now.toString(), finishesAt = now.plusSeconds(1).toString(),
        )))
        failure("ECONOMY_HOME_REQUIRED") { EconomyRules.apply(state, command(), now) }
        failure("ECONOMY_HOME_REQUIRED") { EconomyRules.apply(state, command(), now.plusSeconds(2)) }
        assertEquals(ready().wallet, state.wallet)
    }

    @Test fun `invalid pairs and quantities changed prices or insufficient actual inventory fail without debit`() {
        val state = ready()
        for (target in listOf("moon_crystal:moon_crystal", "wood:ancient_core", "moon_crystal:wood", "moon_crystal", "moon_crystal:ancient_core:living_resin", ":ancient_core", "moon_crystal:"))
            failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command(target), now) }
        for (quantity in listOf(0L, 2L, 100L))
            failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command().copy(quantity = quantity), now) }
        failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command().copy(fishSelection = mapOf("fish_common" to 1L)), now) }
        for (price in listOf(0L, fee - 1, fee + 1))
            failure("ECONOMY_LEAFTAIL_PRICE_CHANGED") { EconomyRules.apply(state, command().copy(totalPrice = price), now) }
        failure("ECONOMY_RESOURCES") { EconomyRules.apply(state.copy(wallet = state.wallet.copy(coins = fee - 1)), command(), now) }
        failure("ECONOMY_RESOURCES") {
            EconomyRules.apply(state.copy(inventory = mapOf("moon_crystal" to 1L)), command(), now, mapOf("moon_crystal" to 100L))
        }
        assertEquals(ready(), state)
    }

    @Test fun `net inventory reduction is allowed in full overflow but target item cap includes escrow`() {
        val state = ready(); val capacity = EconomyRules.storage(state).capacity
        for (extra in 0L..1L) {
            val full = state.copy(inventory = state.inventory + ("wood" to capacity - 4 + extra))
            val after = EconomyRules.apply(full, command(), now, mapOf("stone" to 10L)).first
            assertEquals(EconomyRules.storage(full).used - 1, EconomyRules.storage(after).used)
        }
        failure("ECONOMY_CAPACITY") {
            EconomyRules.apply(state.copy(inventory = state.inventory + ("ancient_core" to ECONOMY_MAX_ITEMS)), command(), now)
        }
        failure("ECONOMY_CAPACITY") {
            EconomyRules.apply(state.copy(inventory = state.inventory + ("ancient_core" to ECONOMY_MAX_ITEMS - 1)), command(), now, mapOf("ancient_core" to 1L))
        }
        assertEquals(ready(), state)
    }

    @Test fun `round trips are a strict item and coin sink with no arbitrary daily cooldown`() {
        val one = EconomyRules.apply(ready(), command(), now).first
        val two = EconomyRules.apply(one, command(), now).first
        val back = EconomyRules.apply(two, command("ancient_core:moon_crystal"), now).first
        assertEquals(mapOf("moon_crystal" to 1L), back.inventory); assertEquals(40_000L, back.wallet.coins)
        assertEquals(ready().tradeRelations, back.tradeRelations)
    }
}
