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
    private fun claim(state: EconomyState, reserved: Map<String, Long> = emptyMap()) =
        EconomyRules.apply(state, command(), now, reserved).first
    private fun job(kind: String, target: String) = EconomyJob(UUID.randomUUID().toString(), kind, target,
        startedAt = now.toString(), finishesAt = now.plusSeconds(1200).toString(),
        targetLevel = if (kind == "construction") 1 else null)

    @Test fun `gift takes the complete first workshop cost from the catalog and leaves building work to the player`() {
        val state = EconomyRules.initial().copy(wallet = EconomyWallet(30, 77), inventory = mapOf("wood" to 3L, "berries" to 4L))
        val cost = EconomyWorkshopStarter.cost()
        assertEquals(EconomyCost(1200, mapOf("wood" to 10L, "stone" to 8L)), cost)
        assertEquals(EconomyRules.catalog.buildings.single { it.id == "workshop" }.levels.single { it.level == 1 }.cost, cost)
        val changed = EconomyRules.catalog.copy(buildings = EconomyRules.catalog.buildings.map { building ->
            if (building.id != "workshop") building else building.copy(levels = building.levels.map { level ->
                if (level.level != 1) level else level.copy(cost = EconomyCost(4321, mapOf("wood" to 2L))) }) })
        assertEquals(EconomyCost(4321, mapOf("wood" to 2L)), EconomyWorkshopStarter.cost(changed))
        val granted = claim(state)
        assertEquals(EconomyWallet(state.wallet.coins + cost.coins, state.wallet.pearls), granted.wallet)
        assertEquals(mapOf("wood" to 13L, "stone" to 8L, "berries" to 4L), granted.inventory)
        assertTrue(granted.workshopStarterClaimed)
        assertFalse(EconomyWorkshopStarter.canClaim(granted))
        assertEquals(state.buildings, granted.buildings)
        assertEquals(state.jobs, granted.jobs)
        val started = EconomyRules.apply(granted, command().copy(action = "start_construction"), now).first
        assertEquals(state.wallet, started.wallet)
        assertEquals(state.inventory, started.inventory)
        assertEquals(0, started.buildings["workshop"])
        assertEquals("workshop", started.jobs.single().targetId)
        assertTrue(started.workshopStarterClaimed)
    }

    @Test fun `different requests cannot claim the permanent gift twice`() {
        val state = claim(EconomyRules.initial())
        val before = economyJson.encodeToString(state)
        repeat(2) {
            assertEquals("ECONOMY_WORKSHOP_STARTER_CLAIMED", assertFailsWith<AuthFailure> { claim(state) }.code)
            assertEquals(before, economyJson.encodeToString(state))
        }
    }

    @Test fun `built or started workshops cannot receive first workshop materials`() {
        val initial = EconomyRules.initial()
        val blocked = listOf(initial.copy(buildings = initial.buildings + ("workshop" to 1)),
            initial.copy(jobs = listOf(job("construction", "workshop"))))
        blocked.forEach { state ->
            assertFalse(EconomyWorkshopStarter.canClaim(state))
            val before = economyJson.encodeToString(state)
            assertEquals("ECONOMY_WORKSHOP_STARTER_UNAVAILABLE", assertFailsWith<AuthFailure> { claim(state) }.code)
            assertEquals(before, economyJson.encodeToString(state))
        }
    }

    @Test fun `hero activity and construction of another building do not consume the gift opportunity`() {
        val state = EconomyRules.initial().copy(jobs = listOf(job("construction", "woodlot"), job("exploration", "forest")))
        assertTrue(EconomyWorkshopStarter.canClaim(state))
        assertFalse(EconomyRules.commandUsesActor(command()))
        val granted = claim(state)
        assertTrue(granted.workshopStarterClaimed)
        assertEquals(state.jobs, granted.jobs)
    }

    @Test fun `gift command rejects alternate targets quantity and price before issuing any resources`() {
        val state = EconomyRules.initial()
        for (request in listOf(command().copy(targetId = "home"), command().copy(quantity = 2), command().copy(totalPrice = 1))) {
            val before = economyJson.encodeToString(state)
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { EconomyRules.apply(state, request, now) }.code)
            assertEquals(before, economyJson.encodeToString(state))
        }
    }

    @Test fun `wallet item and warehouse limits reject the gift without consuming its permanent marker`() {
        val initial = EconomyRules.initial()
        val blocked = listOf(
            initial.copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE - 1199)) to "ECONOMY_CAPACITY",
            initial.copy(inventory = mapOf("wood" to ECONOMY_MAX_ITEMS - 9)) to "ECONOMY_CAPACITY",
            initial.copy(inventory = mapOf("berries" to 183L)) to "ECONOMY_STORAGE_FULL",
        )
        for ((state, code) in blocked) {
            val before = economyJson.encodeToString(state)
            assertEquals(code, assertFailsWith<AuthFailure> { claim(state) }.code)
            assertEquals(before, economyJson.encodeToString(state))
            assertFalse(state.workshopStarterClaimed)
        }
        val edge = initial.copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE - 1200), inventory = mapOf("berries" to 182L))
        val accepted = claim(edge)
        assertEquals(ECONOMY_MAX_BALANCE, accepted.wallet.coins)
        assertEquals(200L, EconomyRules.storage(accepted).used)
        assertTrue(accepted.workshopStarterClaimed)
    }

    @Test fun `reserved market and barter stock still occupies warehouse space before marking the gift claimed`() {
        val state = EconomyRules.initial().copy(inventory = mapOf("berries" to 172L))
        val before = economyJson.encodeToString(state)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { claim(state, mapOf("wood" to 11L)) }.code)
        assertEquals(before, economyJson.encodeToString(state))
        assertFalse(state.workshopStarterClaimed)
        val accepted = claim(state, mapOf("wood" to 10L))
        assertTrue(accepted.workshopStarterClaimed)
        assertEquals(0L, EconomyRules.storage(accepted, mapOf("wood" to 10L)).available)
    }

    @Test fun `persisted profiles without the gift field remain eligible and consumed state survives serialization`() {
        val initial = EconomyRules.initial()
        val oldJson = JsonObject(economyJson.parseToJsonElement(economyJson.encodeToString(initial)).jsonObject - "workshopStarterClaimed")
        val oldState = economyJson.decodeFromString<EconomyState>(oldJson.toString())
        assertFalse(oldState.workshopStarterClaimed)
        assertTrue(EconomyWorkshopStarter.canClaim(oldState))
        val granted = claim(oldState)
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(granted))
        assertTrue(restored.workshopStarterClaimed)
        assertEquals("ECONOMY_WORKSHOP_STARTER_CLAIMED", assertFailsWith<AuthFailure> { claim(restored) }.code)
    }
}
