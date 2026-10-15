package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyWorkshopStarterTest {
    private val now = Instant.parse("2026-10-08T12:00:00Z")
    private fun command() = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0,
        "claim_workshop_starter", "workshop")

    @Test fun `retired gift rejects fresh legacy built and previously claimed profiles without minting resources`() {
        val initial = EconomyRules.initial()
        val states = listOf(initial, initial.copy(tutorialOrder = EconomyTutorialOrder()),
            initial.copy(workshopStarterClaimed = true), initial.copy(buildings = initial.buildings + ("workshop" to 1)))
        for (state in states) {
            val before = economyJson.encodeToString(state)
            assertFalse(EconomyWorkshopStarter.canClaim(state))
            assertEquals("ECONOMY_WORKSHOP_STARTER_UNAVAILABLE", assertFailsWith<AuthFailure> {
                EconomyRules.apply(state, command(), now) }.code)
            assertEquals(before, economyJson.encodeToString(state))
        }
    }

    @Test fun `retired command still rejects forged input before reporting availability`() {
        for (request in listOf(command().copy(targetId = "home"), command().copy(quantity = 2), command().copy(totalPrice = 1)))
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
                EconomyRules.apply(EconomyRules.initial(), request, now) }.code)
    }

    @Test fun `saved gift marker remains compatible after retirement`() {
        val initial = EconomyRules.initial()
        val missing = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(initial)).jsonObject - "workshopStarterClaimed")
        assertFalse(economyJson.decodeFromString<EconomyState>(missing.toString()).workshopStarterClaimed)
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(initial.copy(workshopStarterClaimed = true)))
        assertTrue(restored.workshopStarterClaimed); assertFalse(EconomyWorkshopStarter.canClaim(restored))
    }
}
