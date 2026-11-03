package ru.zhiv.economy

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import kotlin.test.*

class EconomyBoatReelTest {
    private val vectors = economyJson.parseToJsonElement(checkNotNull(javaClass.getResourceAsStream("/world/boat-reel-vectors.json"))
        .bufferedReader().use { it.readText() }).jsonObject
    @Test fun `immutable V1 shared vectors match every integer checkpoint terminal result and weight`() {
        assertEquals(1, vectors.getValue("version").jsonPrimitive.int)
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
                frame = EconomyBoatReel.step(frame, held, challenge.seed, challenge.zoneWidth, challenge.difficulty)
                checkpoints[frame.tick]?.let { assertEquals(it, frame, "$name tick ${frame.tick}") }
            }
        }
        for (value in vectors.getValue("weights").jsonArray) {
            val row = value.jsonObject
            fun number(key: String) = row.getValue(key).jsonPrimitive.int
            assertEquals(number("expected"), EconomyBoats.fishWeight(number("minGrams"), number("maxGrams"), number("first"), number("second")))
        }
    }
    @Test fun `V2 profiles match independent shared unsigned and recovery vectors`() {
        val document = economyJson.parseToJsonElement(checkNotNull(javaClass.getResourceAsStream("/world/boat-reel-v2-vectors.json"))
            .bufferedReader().use { it.readText() }).jsonObject
        assertEquals(2, document.getValue("version").jsonPrimitive.int)
        for (value in document.getValue("cases").jsonArray) {
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

    @Test fun `active prefix and input after terminal cannot be submitted as a result`() {
        val row = vectors.getValue("cases").jsonArray.first().jsonObject
        val challenge = economyJson.decodeFromJsonElement<EconomyBoatChallenge>(row.getValue("challenge"))
        val inputs = economyJson.decodeFromJsonElement<List<EconomyBoatReelInput>>(row.getValue("inputs"))
        val end = row.getValue("endTick").jsonPrimitive.int
        assertFailsWith<AuthFailure> { EconomyBoatReel.replay(challenge, EconomyBoatReelSubmission(challenge.id, emptyList(), 1)) }
        assertFailsWith<AuthFailure> { EconomyBoatReel.replay(challenge, EconomyBoatReelSubmission(challenge.id, inputs + EconomyBoatReelInput(end, false), end + 1)) }
    }
}
