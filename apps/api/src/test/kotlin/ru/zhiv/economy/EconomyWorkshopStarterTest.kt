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

    private fun tutorialCommand() = command().copy(action = "start_tutorial_workshop")
    private fun workshop() = EconomyRules.catalog.buildings.single { it.id == "workshop" }.levels.single { it.level == 1 }
    private fun job(kind: String, target: String, finishesAt: Instant = now.plusSeconds(300)) = EconomyJob(
        UUID.randomUUID().toString(), kind, target, targetLevel = if (kind == "construction") 1 else null,
        startedAt = now.toString(), finishesAt = finishesAt.toString(), cost = EconomyCost(), catalogVersion = EconomyRules.catalog.version)

    @Test fun `tutorial aid builds directly after supplies are spent without crediting personal stock`() {
        for (inventory in listOf(emptyMap(), mapOf("wood" to 3L, "stone" to 5L, "berries" to 2L))) {
            val state = EconomyRules.initial().copy(wallet = EconomyWallet(0, 7), inventory = inventory)
            assertTrue(EconomyWorkshopStarter.canStartTutorialWorkshop(state))
            val started = EconomyRules.apply(state, tutorialCommand(), now).first
            val job = started.jobs.single()
            assertEquals(state.wallet, started.wallet); assertEquals(state.inventory, started.inventory)
            assertTrue(started.workshopStarterClaimed); assertEquals(0, started.buildings["workshop"])
            assertEquals("construction", job.kind); assertEquals("workshop", job.targetId); assertEquals(1, job.targetLevel)
            assertEquals(EconomyCost(), job.cost); assertTrue(job.rewards.isEmpty())
            assertEquals(now.plusSeconds(workshop().seconds), Instant.parse(job.finishesAt))
            assertFalse(EconomyWorkshopStarter.canStartTutorialWorkshop(started))
        }
    }

    @Test fun `legacy claims paid starts and completed workshops cannot receive tutorial aid`() {
        val initial = EconomyRules.initial()
        val paid = job("construction", "workshop").copy(cost = workshop().cost)
        for (state in listOf(initial.copy(workshopStarterClaimed = true),
            initial.copy(buildings = initial.buildings + ("workshop" to 1)), initial.copy(jobs = listOf(paid)))) {
            val before = economyJson.encodeToString(state)
            assertFalse(EconomyWorkshopStarter.canStartTutorialWorkshop(state))
            assertEquals("ECONOMY_WORKSHOP_STARTER_UNAVAILABLE", assertFailsWith<AuthFailure> {
                EconomyRules.apply(state, tutorialCommand(), now) }.code)
            assertEquals(before, economyJson.encodeToString(state))
        }
    }

    @Test fun `tutorial build preserves ordinary builder capacity home and building checks without consuming the marker`() {
        val initial = EconomyRules.initial()
        val attempts = listOf(
            initial.copy(jobs = listOf(job("construction", "woodlot"))) to "ECONOMY_CONSTRUCTION_BUSY",
            initial.copy(jobs = listOf(job("construction", "woodlot", now))) to "ECONOMY_CONSTRUCTION_BUSY",
            initial.copy(jobs = List(18) { job("production", "garden") }) to "ECONOMY_JOBS_CAPACITY",
            initial.copy(jobs = listOf(job("production", "workshop"))) to "ECONOMY_BUILDING_BUSY",
            initial.copy(buildings = initial.buildings + ("home" to 0)) to "ECONOMY_HOME_REQUIRED")
        for ((state, code) in attempts) {
            val before = economyJson.encodeToString(state)
            assertEquals(code, assertFailsWith<AuthFailure> { EconomyRules.apply(state, tutorialCommand(), now) }.code)
            assertEquals(before, economyJson.encodeToString(state)); assertFalse(state.workshopStarterClaimed)
        }
    }

    @Test fun `tutorial construction rejects forged targets quantities prices and unrelated fish selections`() {
        val initial = EconomyRules.initial()
        for (request in listOf(tutorialCommand().copy(targetId = "home"), tutorialCommand().copy(quantity = 2),
            tutorialCommand().copy(totalPrice = 1), tutorialCommand().copy(fishSelection = mapOf("fish_roach" to 1L)))) {
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
                EconomyRules.apply(initial, request, now) }.code)
            assertFalse(initial.workshopStarterClaimed); assertTrue(initial.jobs.isEmpty())
        }
    }

    @Test fun `earmarked aid preserves overflowing storage reserved market goods capped balances and legacy debt`() {
        val initial = EconomyRules.initial()
        val reserved = mapOf("wood" to 1L)
        val states = listOf(initial.copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE, 7), inventory = mapOf("berries" to ECONOMY_MAX_ITEMS)),
            initial.copy(wallet = EconomyWallet(-20, 7), inventory = mapOf("berries" to 49L)))
        for (state in states) {
            val started = EconomyRules.apply(state, tutorialCommand(), now, reserved).first
            assertEquals(state.wallet, started.wallet); assertEquals(state.inventory, started.inventory)
            assertEquals(EconomyRules.storage(state, reserved), EconomyRules.storage(started, reserved))
            assertEquals(EconomyCost(), started.jobs.single().cost); assertTrue(started.workshopStarterClaimed)
        }
        assertEquals(mapOf("wood" to 1L), reserved)
    }

    @Test fun `aid consumes the next builder meal once and preserves the usual construction duration boost`() {
        val initial = EconomyRules.initial().copy(food = EconomyFoodState(builderMeal = "grilled_fish"))
        val started = EconomyRules.apply(initial, tutorialCommand(), now).first
        val meal = EconomyRules.catalog.food!!.meals.single { it.itemId == "grilled_fish" }
        assertEquals(EconomyJobMeal(meal.itemId, "builder", meal.builderSpeedBps), started.jobs.single().meal)
        assertEquals(now.plusSeconds(EconomyFood.mealDuration(workshop().seconds, meal.builderSpeedBps)), Instant.parse(started.jobs.single().finishesAt))
        assertNull(started.food.builderMeal)
        assertEquals(initial.wallet, started.wallet); assertEquals(initial.inventory, started.inventory)
    }

    @Test fun `normal workshop build keeps its paid catalog cost and tutorial completion cannot award another aid`() {
        val initial = EconomyRules.initial()
        val paid = EconomyRules.apply(initial, tutorialCommand().copy(action = "start_construction"), now).first
        assertEquals(workshop().cost, paid.jobs.single().cost)
        assertEquals(initial.wallet.coins - workshop().cost.coins, paid.wallet.coins)
        workshop().cost.items.forEach { (item, quantity) -> assertEquals((initial.inventory[item] ?: 0) - quantity, paid.inventory[item] ?: 0) }
        assertFalse(paid.workshopStarterClaimed)
        val started = EconomyRules.apply(initial, tutorialCommand(), now).first
        val job = started.jobs.single()
        val completed = EconomyRules.apply(started, tutorialCommand().copy(action = "claim_job", targetId = job.id), Instant.parse(job.finishesAt)).first
        assertEquals(1, completed.buildings["workshop"]); assertTrue(completed.workshopStarterClaimed)
        assertEquals(initial.wallet, completed.wallet); assertEquals(initial.inventory, completed.inventory)
        assertEquals("ECONOMY_WORKSHOP_STARTER_UNAVAILABLE", assertFailsWith<AuthFailure> {
            EconomyRules.apply(completed, tutorialCommand(), Instant.parse(job.finishesAt)) }.code)
    }
}
