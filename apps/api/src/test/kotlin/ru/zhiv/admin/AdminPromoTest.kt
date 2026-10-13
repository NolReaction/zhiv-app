package ru.zhiv.admin

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.promo.*
import java.util.UUID
import kotlin.test.*

class AdminPromoTest {
    private val gift = PromoDefinition("admin-gift", "ADMIN-GIFT", true, "Подарок", reward = PromoReward(500, 20, mapOf("wood" to 5)))
    private fun command() = AdminPromoCommand(UUID.randomUUID().toString(), "create", gift.id, 0, "Подарок к событию", gift)
    @Test fun `normalizes code and accepts precise bounded Moscow validity window`() {
        val input = command().copy(definition = gift.copy(code = " admin-gift ", startsAt = "2026-10-15T10:00:00+03:00", endsAt = "2026-11-01T00:00:00+03:00"))
        assertEquals("ADMIN-GIFT", validateAdminPromo(input).definition!!.code)
        assertEquals(20L, validateAdminPromo(input).definition!!.reward.pearls)
    }
    @Test fun `rejects invalid campaign identities rewards lifetime and control characters`() {
        val badDefinitions = listOf(gift.copy(id = "other-gift"), gift.copy(title = "Подарок\nигрокам"),
            gift.copy(startsAt = "2026-10-15T10:00", endsAt = null),
            gift.copy(startsAt = "2026-10-15T10:00:00Z", endsAt = "2026-10-15T10:00:00Z"),
            gift.copy(reward = PromoReward()), gift.copy(reward = PromoReward(coins = 1_000_001)),
            gift.copy(reward = PromoReward(pearls = 10_001)), gift.copy(reward = PromoReward(items = mapOf("fake-item" to 1))),
            gift.copy(reward = PromoReward(items = mapOf("wood" to 6_000, "stone" to 6_000))))
        for (bad in badDefinitions) assertEquals("INVALID_ADMIN_PROMO", assertFailsWith<AuthFailure> { validateAdminPromo(command().copy(definition = bad)) }.code)
        for (bad in listOf(command().copy(action = "erase"), command().copy(expectedVersion = 1), command().copy(reason = "коротко"),
            command().copy(requestId = "invalid"), command().copy(action = "delete")))
            assertFailsWith<AuthFailure> { validateAdminPromo(bad) }
        assertNull(validateAdminPromo(command().copy(action = "delete", definition = null)).definition)
    }
    @Test fun `write decoder rejects unknown fields and coerced numbers booleans and strings`() {
        val valid = promoJson.encodeToString(command())
        val variants = listOf(valid.dropLast(1) + ",\"admin\":true}", valid.replace("\"expectedVersion\":0", "\"expectedVersion\":\"0\""),
            valid.replace("\"coins\":500", "\"coins\":\"500\""), valid.replace("\"wood\":5", "\"wood\":5.1"),
            valid.replace("\"enabled\":true", "\"enabled\":\"true\""), valid.replace("\"title\":\"Подарок\"", "\"title\":123"),
            valid.replace("\"coins\":500", "\"extra\":1,\"coins\":500"))
        for (bad in variants) assertFailsWith<AuthFailure> { decodeAdminPromo(promoJson.parseToJsonElement(bad)) }
        assertEquals(gift, decodeAdminPromo(promoJson.parseToJsonElement(valid)).definition)
    }
}
