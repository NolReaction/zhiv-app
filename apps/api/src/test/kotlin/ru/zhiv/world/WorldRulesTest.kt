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
    fun `production rules never grant development resources`() {
        assertEquals("INVALID_WORLD_COMMAND", assertFailsWith<AuthFailure> {
            WorldRules.apply(WorldState(), command("dev_grant_resources"), now)
        }.code)
    }
}
