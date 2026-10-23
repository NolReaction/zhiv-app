package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyProductionCollectionTest {
    private val now = Instant.parse("2026-10-23T12:00:00Z")
    private fun command(station: String = "woodlot") = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, "claim_production", station)
    private fun job(station: String = "woodlot", item: String = "wood", at: Instant = now) = EconomyJob(
        id = UUID.randomUUID().toString(), kind = "production", targetId = station, recipeId = "gather_wood",
        rewards = mapOf(item to 1L), startedAt = now.minusSeconds(30).toString(), finishesAt = at.toString(), catalogVersion = 12)
    private fun fixture(station: String = "woodlot", item: String = "wood") = EconomyRules.initial().copy(inventory = emptyMap(),
        buildings = EconomyRules.initial().buildings + mapOf("home" to 5, "woodlot" to 1, "workshop" to 1, "kiln" to 1, "dryer" to 1),
        jobs = listOf(job(station, item), job(station, item), job(station, item, now.plusSeconds(1))))

    @Test fun `all ready production cells are delivered together while later work and other stations remain`() {
        for ((station, item) in listOf("woodlot" to "wood", "workshop" to "planks", "kiln" to "bricks", "dryer" to "berry_compote")) {
            val base = fixture(station, item)
            val other = job(if (station == "workshop") "woodlot" else "workshop", "fiber")
            val state = base.copy(jobs = base.jobs + other)
            val claimed = EconomyRules.apply(state, command(station), now).first
            assertEquals(mapOf(item to 2L), claimed.inventory)
            assertEquals(listOf(base.jobs.last(), other), claimed.jobs)
            assertEquals(state.wallet, claimed.wallet)
            val repeated = assertFailsWith<AuthFailure> { EconomyRules.apply(claimed, command(station), now) }
            assertEquals("ECONOMY_JOB_NOT_READY", repeated.code)
        }
    }

    @Test fun `the whole delivery requires storage including escrow and cannot consume any result on failure`() {
        val state = fixture().copy(inventory = mapOf("stone" to 49L))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { EconomyRules.apply(state, command(), now) }.code)
        assertEquals(3, state.jobs.size); assertEquals(mapOf("stone" to 49L), state.inventory)
        val freed = state.copy(inventory = mapOf("stone" to 48L))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.apply(freed, command(), now, mapOf("fiber" to 1L)) }.code)
        assertEquals(mapOf("stone" to 48L, "wood" to 2L), EconomyRules.apply(freed, command(), now).first.inventory)
    }

    @Test fun `bulk claim never bypasses berries construction actor work or command validation`() {
        val base = fixture()
        val berries = job("garden", "berries")
        val construction = job().copy(kind = "construction", targetLevel = 2, rewards = emptyMap())
        val original = base.copy(jobs = base.jobs + listOf(berries, construction))
        val claimed = EconomyRules.apply(original, command(), now).first
        assertTrue(claimed.jobs.containsAll(listOf(berries, construction))); assertEquals(1, claimed.buildings["woodlot"])
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { EconomyRules.apply(original, command("garden"), now) }.code)
        for (station in listOf("home", "quarry", "unknown")) assertEquals("ECONOMY_PRODUCTION_STATION",
            assertFailsWith<AuthFailure> { EconomyRules.apply(original, command(station), now) }.code)
        for (forged in listOf(command().copy(quantity = 2), command().copy(totalPrice = 1), command().copy(fishSelection = mapOf("fish" to 1L))))
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { EconomyRules.apply(original, forged, now) }.code)
    }
}
