package ru.zhiv.economy

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EconomyBoatReelV6Test {
    private fun landed(motorResponse: Int, hullDamping: Int): Int = (1L..100L).count { index ->
        val seed = (index * 0x9e3779b9L) and 0xffff_ffffL
        val width = EconomyBoatReel.zoneWidth(3200, "legendary", motorResponse, hullDamping)
        val challenge = EconomyBoatChallenge(
            id = "00000000-0000-4000-8000-000000000001", seed = seed, zoneWidth = width, difficulty = 5,
            startedAt = "2026-11-10T00:00:00Z", expiresAt = "2026-11-10T00:02:00Z", fishRarity = "legendary",
            rulesVersion = 6, resistance = EconomyBoatReel.resistanceForClass("legendary", seed),
            motorResponse = motorResponse, hullDamping = hullDamping,
        )
        var frame = EconomyBoatReel.Frame()
        var held = false
        while (frame.status == "active") {
            if (frame.tick % 5 == 0) held = frame.fish > frame.bar + frame.velocity * 4
            frame = EconomyBoatReel.step(frame, held, challenge)
        }
        frame.status == "caught"
    }

    @Test fun `the same 100 legendary fish respond to steering and hull stability at a 250 ms input interval`() {
        assertEquals(1, landed(0, 0))
        assertEquals(86, landed(5, 20))
        assertTrue(landed(5, 0) in 2..85)
        assertTrue(landed(0, 20) in 2..85)
    }
}
