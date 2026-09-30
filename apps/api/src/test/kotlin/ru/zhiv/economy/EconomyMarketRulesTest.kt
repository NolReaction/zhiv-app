package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.util.UUID
import kotlin.test.*

class EconomyMarketRulesTest {
    private fun command() = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0,
        "create_listing", "berries", quantity = 2, totalPrice = 6)

    @Test fun `market commands have bounded lots canonical ids and explicit owner`() {
        EconomyMarketRules.validate(command())
        for (bad in listOf(
            command().copy(requestId = "wrong"), command().copy(ownerPublicId = ""),
            command().copy(expectedRevision = -1), command().copy(expectedRevision = ECONOMY_MAX_REVISION),
            command().copy(quantity = 0), command().copy(quantity = 100), command().copy(quantity = Long.MAX_VALUE),
            command().copy(totalPrice = -1), command().copy(totalPrice = Long.MAX_VALUE),
            command().copy(action = "credit_coins"), command().copy(targetId = ""),
            command().copy(action = "buy_listing", targetId = "not-an-id"),
        )) assertFailsWith<AuthFailure> { EconomyMarketRules.validate(bad) }
        EconomyMarketRules.validate(command().copy(action = "cancel_listing", targetId = UUID.randomUUID().toString(), quantity = 1, totalPrice = 0))
        assertFailsWith<AuthFailure> { EconomyMarketRules.validate(command().copy(action = "cancel_listing", targetId = UUID.randomUUID().toString())) }
    }

    @Test fun `whole lot price allows exact cap but no overflow or one coin over`() {
        EconomyMarketRules.validatePrice(2, 30, 3)
        EconomyMarketRules.validatePrice(2, 2, 3)
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 31, 3) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 1, 3) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(0, 1, 3) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(1, Long.MAX_VALUE, Long.MAX_VALUE) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(1, 1, 0) }
        EconomyMarketRules.validatePrice(99, 1_000_000_000, Long.MAX_VALUE)
    }

    @Test fun `cursor round trip preserves microseconds and rejects arbitrary query text`() {
        val listing = EconomyMarketListing(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", "Мохлик", "berries", 2, 6,
            "active", "2026-10-01T12:00:00.123456Z", owned = false)
        val cursor = assertNotNull(EconomyMarketRules.cursor(EconomyMarketRules.cursor(listing)))
        assertEquals(listing.createdAt, cursor.createdAt.toString())
        assertEquals(listing.id, cursor.id.toString())
        assertNull(EconomyMarketRules.cursor(null as String?))
        listOf("", " ", "a".repeat(161), "not-a-cursor", "JztEUk9QIFRBQkxFIGVjb25vbXk7")
            .forEach { assertFailsWith<AuthFailure> { EconomyMarketRules.cursor(it) } }
    }
}
