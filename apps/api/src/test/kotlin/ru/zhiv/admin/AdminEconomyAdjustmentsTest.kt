package ru.zhiv.admin

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import ru.zhiv.mail.PlayerMailMessage
import java.util.UUID
import kotlin.test.*

class AdminEconomyAdjustmentsTest {
    private fun request() = AdminEconomyAdjustmentRequest(UUID.randomUUID().toString(), "0123-4567-89AB", "Исправление ошибочного начисления", 3)
    private val state = EconomyRules.initial(includeStartingPack = false).copy(wallet = EconomyWallet(100, 15))

    @Test fun `signed visible corrections preserve half pearls and every other economy field`() {
        val next = AdminEconomyAdjustments.apply(state, request().copy(coinsDelta = -40, pearlsDelta = -3))
        assertEquals(EconomyWallet(60, 9), next.wallet)
        assertEquals(state, next.copy(wallet = state.wallet))
        assertEquals(EconomyWallet(102, 17), AdminEconomyAdjustments.apply(state, request().copy(coinsDelta = 2, pearlsDelta = 1)).wallet)
    }

    @Test fun `negative balances and overflowing corrections fail without clamping or changing the input`() {
        for (command in listOf(request().copy(coinsDelta = -101), request().copy(pearlsDelta = -8)))
            assertEquals("ADMIN_ADJUSTMENT_INSUFFICIENT_BALANCE", assertFailsWith<AuthFailure> { AdminEconomyAdjustments.apply(state, command) }.code)
        val full = state.copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS))
        for (command in listOf(request().copy(coinsDelta = 1), request().copy(pearlsDelta = 1)))
            assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> { AdminEconomyAdjustments.apply(full, command) }.code)
        assertEquals(EconomyWallet(100, 15), state.wallet)
        assertEquals(EconomyWallet(0, 1), AdminEconomyAdjustments.apply(state, request().copy(coinsDelta = -100, pearlsDelta = -7)).wallet)
    }

    @Test fun `zero fractional range extremes and missing observations cannot become wallet corrections`() {
        for (command in listOf(request(), request().copy(coinsDelta = Long.MIN_VALUE), request().copy(pearlsDelta = Long.MAX_VALUE),
            request().copy(coinsDelta = 1, expectedRevision = -1), request().copy(coinsDelta = 1, expectedRevision = Long.MAX_VALUE),
            request().copy(coinsDelta = 1, reason = "коротко")))
            assertEquals("INVALID_ADMIN_ADJUSTMENT", assertFailsWith<AuthFailure> { AdminEconomyAdjustments.validate(command) }.code)
        assertFails { Json.decodeFromString<AdminEconomyAdjustmentRequest>("""{"requestId":"${UUID.randomUUID()}","confirmationPublicId":"0123-4567-89AB","reason":"Исправление баланса","expectedRevision":0,"coinsDelta":1.5}""") }
    }

    @Test fun `old grants decode as silent and player text must be explicit and separate from audit reason`() {
        val grant = Json.decodeFromString<AdminEconomyGrantRequest>("""{"requestId":"${UUID.randomUUID()}","confirmationPublicId":"0123-4567-89AB","reason":"Внутренняя причина выдачи","coins":1}""")
        assertEquals("silent", grant.delivery); assertNull(grant.playerMessage)
        AdminEconomyGrants.validate(grant)
        for ((delivery, message) in listOf("silent" to PlayerMailMessage("Заголовок", "Текст игроку"), "invented" to null,
            "notify" to PlayerMailMessage("", "Текст игроку"), "notify" to PlayerMailMessage("x".repeat(121), "Текст игроку"),
            "notify" to PlayerMailMessage("Заголовок", "x".repeat(2001))))
            assertEquals("INVALID_ADMIN_DELIVERY", assertFailsWith<AuthFailure> { AdminEconomyGrants.validate(grant.copy(delivery = delivery, playerMessage = message)) }.code)
        AdminEconomyAdjustments.validate(request().copy(coinsDelta = -1, delivery = "notify", playerMessage = PlayerMailMessage("<b>Поправка</b>", "Строка первая\nСтрока вторая")))
    }
}
