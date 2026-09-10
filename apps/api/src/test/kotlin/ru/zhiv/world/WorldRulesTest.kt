package ru.zhiv.world

import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import ru.zhiv.auth.AuthFailure

class WorldRulesTest {
    private val now = Instant.parse("2026-09-08T12:00:00Z")
    private fun command(action: String) = WorldCommand(UUID.randomUUID().toString(), "OWNER", 0, action)

    @Test
    fun `house grows through five levels and cannot charge for level six`() {
        var state = WorldState(resources = WorldResources(300, 200, 100))
        for (level in 2..5) {
            state = WorldRules.apply(state, command("upgrade_house"), now).first
            assertEquals(level, state.houseLevel)
        }
        assertEquals(WorldResources(90, 81, 37), state.resources)
        assertEquals("WORLD_MAX_LEVEL", assertFailsWith<AuthFailure> {
            WorldRules.apply(state, command("upgrade_house"), now)
        }.code)
    }

    @Test
    fun `workshop upgrades preserve legacy ownership and stop at three`() {
        var state = WorldState(workshop=true,resources=WorldResources(200,200,200))
        state = WorldRules.apply(state,command("upgrade_workshop"),now).first
        assertEquals(2,state.workshopLevel)
        state = WorldRules.apply(state,command("upgrade_workshop"),now).first
        assertEquals(3,state.workshopLevel)
        assertEquals(WorldResources(95,140,165),state.resources)
        assertEquals("WORLD_MAX_LEVEL",assertFailsWith<AuthFailure> { WorldRules.apply(state,command("upgrade_workshop"),now) }.code)
        assertEquals("WORLD_WORKSHOP_REQUIRED",assertFailsWith<AuthFailure> { WorldRules.apply(WorldState(),command("upgrade_workshop"),now) }.code)
        assertEquals(3,WorldRules.merge(WorldState(),state).workshopLevel)
        assertEquals(1,WorldRules.merge(WorldState(),WorldState(workshop=true)).workshopLevel)
    }

    @Test
    fun `production rules never grant development resources`() {
        assertEquals("INVALID_WORLD_COMMAND", assertFailsWith<AuthFailure> {
            WorldRules.apply(WorldState(), command("dev_grant_resources"), now)
        }.code)
    }
    @Test
    fun `fishing claim becomes valid exactly when the complete outing ends`() {
        for (minutes in listOf(5L, 15L, 30L, 60L)) {
            val before = WorldState(houseLevel = 2)
            val started = WorldRules.apply(before, command("start_journey").copy(target = "fishing_$minutes"), now).first
            val journey = started.journeys.single()
            val finish = now.plusSeconds(minutes * 60)
            val claim = command("claim_journey").copy(target = journey.id)
            assertEquals(finish, Instant.parse(journey.finishesAt))
            assertEquals(before.resources, started.resources)
            assertEquals("WORLD_JOURNEY_NOT_READY", assertFailsWith<AuthFailure> {
                WorldRules.apply(started, claim, finish.minusNanos(1))
            }.code)
            val paid = WorldRules.apply(started, claim, finish).first
            assertEquals(journey.rewards, paid.resources)
            assertEquals(1L, paid.completedJourneys)
            assertEquals(emptyList(), paid.journeys)
            assertEquals("WORLD_JOURNEY_GONE", assertFailsWith<AuthFailure> {
                WorldRules.apply(paid, claim, finish)
            }.code)
        }
    }
}
