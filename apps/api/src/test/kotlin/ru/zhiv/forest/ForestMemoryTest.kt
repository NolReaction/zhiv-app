package ru.zhiv.forest

import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.util.UUID
import kotlin.test.*

fun memoryFixture(energy: Double = 0.7) = ForestMemoryPayload(1, "tiled-forest", "geometry-v1",
    ForestMemoryMind(40.0, ForestMemoryNeeds(energy, 0.6, 0.8, 0.4),
        listOf(ForestMemoryRecent("home", "rest", "completed", 30.0, 4.0)), 55.0),
    ForestMemoryHero(ForestMemoryPoint(300.0, 420.0), false, 12.0, 4.0,
        listOf(ForestMemoryInterest("bush-1", "sniff", 9.0))),
    listOf(ForestMemoryMushroom("mushroom-1", ForestMemoryPoint(320.0, 440.0), 0.5, 0.0)))

class ForestMemoryTest {
    @Test fun `snapshot rejects unbounded nonfinite duplicate and stale cosmetic data`() {
        val valid = memoryFixture()
        validateForestMemoryPayload(valid)
        val bad = listOf(
            valid.copy(version = 2), valid.copy(sceneId = "bad\u0000"),
            valid.copy(mind = valid.mind.copy(elapsed = Double.NaN)),
            valid.copy(mind = valid.mind.copy(attentionUntil = 71.0)),
            valid.copy(mind = valid.mind.copy(elapsed = 1e9, attentionUntil = 1e9 + 1, recent = emptyList())),
            valid.copy(mind = valid.mind.copy(recent = listOf(valid.mind.recent.single().copy(at = 41.0)))),
            valid.copy(mind = valid.mind.copy(elapsed = 400.0)),
            valid.copy(hero = valid.hero.copy(awakeFor = 31.0)),
            valid.copy(hero = valid.hero.copy(position = ForestMemoryPoint(-1.0, 1.0))),
            valid.copy(mushrooms = valid.mushrooms + valid.mushrooms),
            valid.copy(mushrooms = listOf(valid.mushrooms.single().copy(regrowIn = 23.0))),
            valid.copy(mushrooms = (0..128).map { valid.mushrooms.single().copy(id = "mushroom-$it") }),
            valid.copy(mushrooms = (0..127).map { valid.mushrooms.single().copy(id = "$it" + "я".repeat(155)) }),
        )
        bad.forEach { assertEquals("INVALID_FOREST_MEMORY", assertFailsWith<AuthFailure> { validateForestMemoryPayload(it) }.code) }
        val raw = forestMemoryJson.encodeToString(valid)
        assertFailsWith<SerializationException> { forestMemoryJson.decodeFromString<ForestMemoryPayload>(raw.dropLast(1) + ",\"sparks\":100}") }
    }

    @Test fun `commands require canonical identities and action specific capabilities`() {
        val command = ForestMemoryCommand("0000-0000-0001", UUID.randomUUID().toString(), UUID.randomUUID().toString(), 0, "acquire")
        validateForestMemoryCommand(command)
        validateForestMemoryCommand(command.copy(expectedRevision = FOREST_MEMORY_MAX_REVISION))
        val bad = listOf(command.copy(ownerPublicId = "000000000001"), command.copy(clientId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
            command.copy(requestId = "00000000-0000-1000-8000-000000000000"), command.copy(expectedRevision = -1),
            command.copy(expectedRevision = FOREST_MEMORY_MAX_REVISION + 1), command.copy(action = "delete"),
            command.copy(snapshot = memoryFixture()), command.copy(leaseToken = UUID.randomUUID().toString()),
            command.copy(action = "save"), command.copy(action = "release"),
            command.copy(action = "save", leaseToken = UUID.randomUUID().toString(), snapshot = memoryFixture(), takeover = true))
        bad.forEach { assertFailsWith<AuthFailure> { validateForestMemoryCommand(it) } }
        validateForestMemoryCommand(command.copy(action = "save", leaseToken = UUID.randomUUID().toString(), snapshot = memoryFixture()))
    }

    @Test fun `JSON primitive types match the browser schema without quoted number coercion`() {
        val command = ForestMemoryCommand("0000-0000-0001", UUID.randomUUID().toString(), UUID.randomUUID().toString(), 0, "save",
            leaseToken = UUID.randomUUID().toString(), snapshot = memoryFixture())
        val json = forestMemoryJson.encodeToString(command)
        assertEquals(command, decodeForestMemoryCommand(forestMemoryJson.parseToJsonElement(json)))
        for (bad in listOf(json.replace("\"expectedRevision\":0", "\"expectedRevision\":\"0\""),
            json.replace("\"energy\":0.7", "\"energy\":\"0.7\""), json.replace("\"x\":300.0", "\"x\":\"300\""),
            json.replace("\"sleepingHome\":false", "\"sleepingHome\":\"false\""))) {
            assertNotEquals(json, bad)
            assertFailsWith<AuthFailure> { decodeForestMemoryCommand(forestMemoryJson.parseToJsonElement(bad)) }
        }
    }
}
