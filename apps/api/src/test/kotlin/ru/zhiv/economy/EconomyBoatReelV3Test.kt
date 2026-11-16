package ru.zhiv.economy

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import kotlin.test.*

class EconomyBoatReelV3Test {
    private val vectors = economyJson.parseToJsonElement(checkNotNull(javaClass.getResourceAsStream("/world/boat-reel-v3-vectors.json"))
        .bufferedReader().use { it.readText() }).jsonObject

    @Test fun `V3 public class movement matches independent shared integer checkpoints and terminal replay`() {
        assertEquals(3, vectors.getValue("version").jsonPrimitive.int)
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

    @Test fun `V3 phase labels follow the same integer protocol and older versions ignore class scaling`() {
        for (value in vectors.getValue("phases").jsonArray) {
            val row = value.jsonObject
            val challenge = economyJson.decodeFromJsonElement<EconomyBoatChallenge>(row.getValue("challenge"))
            for (sample in row.getValue("samples").jsonArray) {
                val item = sample.jsonObject
                assertEquals(item.getValue("phase").jsonPrimitive.content,
                    EconomyBoatReel.resistancePhase(challenge, item.getValue("tick").jsonPrimitive.int))
            }
            for (version in listOf(1, 2)) {
                val old = challenge.copy(rulesVersion = version, fishRarity = null)
                val changed = old.copy(fishRarity = "common")
                assertEquals(EconomyBoatReel.step(EconomyBoatReel.Frame(), false, old), EconomyBoatReel.step(EconomyBoatReel.Frame(), false, changed))
                assertEquals("cruising", EconomyBoatReel.resistancePhase(old, 42))
            }
            assertFailsWith<IllegalArgumentException> { challenge.copy(fishRarity = null) }
        }
    }
}
