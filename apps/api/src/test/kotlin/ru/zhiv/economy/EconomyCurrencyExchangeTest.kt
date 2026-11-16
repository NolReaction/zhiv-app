package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class EconomyCurrencyExchangeTest {
    private val now = Instant.parse("2026-11-02T12:00:00Z")
    private val config = EconomyCurrencyExchange.config
    private fun command(id: String = "gold_pouch_v1", price: Long = 40) = EconomyCommand(
        UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, "exchange_pearls_for_gold", id, 1, price)
    private fun funded(pearls: Long = 200, coins: Long = 123) = EconomyRules.initial().copy(wallet = EconomyWallet(coins, pearls))
    private fun apply(state: EconomyState, command: EconomyCommand) = EconomyRules.apply(state, command, now)
    private fun rejected(state: EconomyState, command: EconomyCommand, code: String) {
        val before = economyJson.encodeToString(state)
        assertEquals(code, assertFailsWith<AuthFailure> { apply(state, command) }.code)
        assertEquals(before, economyJson.encodeToString(state), "A rejected exchange must leave both balances and all progress untouched")
    }

    @Test fun `all versioned offers use exact raw pearl costs and display bonuses without an item reward`() {
        assertEquals(1, config.version)
        assertEquals(listOf("gold_pouch_v1", "gold_casket_v1", "gold_chest_v1"), config.offers.map { it.id })
        assertEquals(listOf(20L, 50L, 100L), config.offers.map { it.pearls / 2 })
        assertEquals(listOf(1000L, 2750L, 6000L), config.offers.map { it.coins })
        assertEquals(listOf(0, 10, 20), config.offers.map { it.bonusPercent })
        config.offers.forEach { offer ->
            val state = funded(offer.pearls)
            val before = economyJson.encodeToString(state)
            val (after, message) = apply(state, command(offer.id, offer.pearls))
            assertEquals(EconomyWallet(state.wallet.coins + offer.coins, 0), after.wallet)
            assertEquals(state.inventory, after.inventory)
            assertEquals(state.buildings, after.buildings)
            assertEquals(state.jobs, after.jobs)
            assertEquals(state.fishing, after.fishing)
            assertEquals(state.progression.skills, after.progression.skills)
            assertEquals(state.progression.recipes, after.progression.recipes)
            assertEquals(state.progression.player?.xp ?: 0, after.progression.player?.xp ?: 0)
            assertEquals(state.progression.player?.season?.points ?: 0, after.progression.player?.season?.points ?: 0)
            assertEquals(state.completedExplorations, after.completedExplorations)
            assertTrue(message.startsWith("Обмен выполнен. Получено "))
            assertEquals(before, economyJson.encodeToString(state), "The immutable source cannot be edited by a successful transition")
        }
    }

    @Test fun `stale offer ids and any nonexact quote reject before debit`() {
        val state = funded()
        for (id in listOf("gold_pouch_v0", "gold_pouch_v2", "gold_pouch", "gold_chest_v999", "1000", "gold_pouch_v1@1000000"))
            rejected(state, command(id), "ECONOMY_EXCHANGE_CHANGED")
        for (price in listOf(0L, 20L, 39L, 41L, 100L))
            rejected(state, command(price = price), "ECONOMY_EXCHANGE_PRICE_CHANGED")
    }

    @Test fun `low pearl balance and either side of the coin cap remain atomic`() {
        config.offers.forEach { offer ->
            rejected(funded(offer.pearls - 1), command(offer.id, offer.pearls), "ECONOMY_PEARLS")
            rejected(funded(offer.pearls, ECONOMY_MAX_BALANCE - offer.coins + 1), command(offer.id, offer.pearls), "ECONOMY_CAPACITY")
            val exact = apply(funded(offer.pearls, ECONOMY_MAX_BALANCE - offer.coins), command(offer.id, offer.pearls)).first
            assertEquals(EconomyWallet(ECONOMY_MAX_BALANCE, 0), exact.wallet)
        }
    }

    @Test fun `bulk quantities fish selections and cargo fields cannot repurpose an exchange`() {
        val state = funded()
        for (quantity in listOf(0L, 2L, 10000L, 10001L)) rejected(state, command().copy(quantity = quantity), "INVALID_ECONOMY_COMMAND")
        for (malformed in listOf(
            command().copy(fishSelection = emptyMap()),
            command().copy(fishSelection = mapOf("fish" to 1L)),
            command().copy(voyageId = UUID.randomUUID().toString()),
            command().copy(orderId = "gold_pouch_v1"),
            command().copy(itemId = "coins"),
            command().copy(totalPrice = -1),
        )) rejected(state, malformed, "INVALID_ECONOMY_COMMAND")
        val legitimate = economyJson.parseToJsonElement(economyJson.encodeToString(command()))
        assertEquals("exchange_pearls_for_gold", decodeEconomyCommand(legitimate).action)
        val injected = buildJsonObject {
            legitimate.let { it as kotlinx.serialization.json.JsonObject }.forEach { (key, value) -> put(key, value) }
            put("coins", JsonPrimitive(1_000_000))
        }
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { decodeEconomyCommand(injected) }.code)
    }

    @Test fun `exchange does not depend on warehouse space jobs or claimed building levels`() {
        val state = funded().copy(inventory = mapOf("wood" to 1_000_000L), buildings = mapOf("home" to 1, "warehouse" to 1))
        val after = apply(state, command()).first
        assertEquals(state.inventory, after.inventory)
        assertEquals(state.buildings, after.buildings)
        assertEquals(state.wallet.coins + 1000, after.wallet.coins)
        assertEquals(state.wallet.pearls - 40, after.wallet.pearls)
    }

    @Test fun `shared catalog rejects fractional displayed pearls hidden bonus inflation and duplicate ids`() {
        val offer = config.offers.first()
        for (invalid in listOf<() -> Any>(
            { offer.copy(id = "gold_pouch") }, { offer.copy(id = "gold_pouch_v0") },
            { offer.copy(pearls = 39) }, { offer.copy(pearls = 0) },
            { offer.copy(coins = 1001) }, { offer.copy(bonusPercent = 21) },
            { offer.copy(coins = ECONOMY_MAX_BALANCE + 1) }, { offer.copy(pearls = ECONOMY_MAX_PEARLS + 2) },
            { EconomyCurrencyExchangeCatalog(2, config.offers) },
            { EconomyCurrencyExchangeCatalog(1, listOf(offer, offer)) },
            { EconomyCurrencyExchangeCatalog(1, emptyList()) },
        )) assertFailsWith<IllegalArgumentException> { invalid() }
    }
}
