package ru.zhiv.economy

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import kotlin.test.*

class EconomyBoatReelV4Test {
    private val vectors = economyJson.parseToJsonElement(checkNotNull(javaClass.getResourceAsStream("/world/boat-reel-v4-vectors.json"))
        .bufferedReader().use { it.readText() }).jsonObject

    @Test fun `V4 inertia and terminal replay match independent shared integer vectors`() {
        assertEquals(4, vectors.getValue("version").jsonPrimitive.int)
        for (value in vectors.getValue("cases").jsonArray) {
            val row = value.jsonObject; val name = row.getValue("name").jsonPrimitive.content
            val challenge = economyJson.decodeFromJsonElement<EconomyBoatChallenge>(row.getValue("challenge"))
            val inputs = economyJson.decodeFromJsonElement<List<EconomyBoatReelInput>>(row.getValue("inputs"))
            val end = row.getValue("endTick").jsonPrimitive.int
            val expected = economyJson.decodeFromJsonElement<EconomyBoatReel.Frame>(row.getValue("expected"))
            assertEquals(expected, EconomyBoatReel.replay(challenge, EconomyBoatReelSubmission(challenge.id, inputs, end)), name)
            val checkpoints = row.getValue("checkpoints").jsonArray.map { economyJson.decodeFromJsonElement<EconomyBoatReel.Frame>(it) }.associateBy { it.tick }
            var frame = EconomyBoatReel.Frame(); var held = false
            while (frame.tick < end) {
                inputs.find { it.tick == frame.tick }?.let { held = it.held }
                frame = EconomyBoatReel.step(frame, held, challenge)
                checkpoints[frame.tick]?.let { assertEquals(it, frame, "$name tick ${frame.tick}") }
            }
        }
    }

    @Test fun `V4 lower bounce upper stop and directional momentum match independent boundary samples`() {
        for (value in vectors.getValue("controlSamples").jsonArray) {
            val row = value.jsonObject
            val challenge = economyJson.decodeFromJsonElement<EconomyBoatChallenge>(row.getValue("challenge"))
            val before = economyJson.decodeFromJsonElement<EconomyBoatReel.Frame>(row.getValue("before"))
            val expected = economyJson.decodeFromJsonElement<EconomyBoatReel.Frame>(row.getValue("expected"))
            assertEquals(expected, EconomyBoatReel.step(before, row.getValue("held").jsonPrimitive.boolean, challenge), row.getValue("name").jsonPrimitive.content)
        }
    }

    @Test fun `V4 uses existing V3 fish phases while prior controls and class requirements remain versioned`() {
        val challenge = economyJson.decodeFromJsonElement<EconomyBoatChallenge>(vectors.getValue("cases").jsonArray.first().jsonObject.getValue("challenge"))
        val before = EconomyBoatReel.Frame(tick = 42, bar = 5000, velocity = 120, fish = 5000, progress = 5000)
        for (version in listOf(1, 2, 3)) {
            val legacy = EconomyBoatReel.step(before, false, challenge.copy(rulesVersion = version))
            assertEquals(5092, legacy.bar); assertEquals(92, legacy.velocity)
        }
        for (tick in listOf(0, 24, 38, 64, 72, 96, 599)) {
            assertEquals(EconomyBoatReel.resistancePhase(challenge.copy(rulesVersion = 3), tick), EconomyBoatReel.resistancePhase(challenge, tick))
        }
        assertFailsWith<IllegalArgumentException> { challenge.copy(fishRarity = null) }
    }
}
