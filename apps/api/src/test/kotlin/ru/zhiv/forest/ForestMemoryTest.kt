package ru.zhiv.forest

import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
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

fun gardenMemoryFixture(): ForestMemoryPayload {
    val old = memoryFixture()
    return old.copy(version = 2,
        mind = old.mind.copy(recent = listOf(
            ForestMemoryRecent("water:clearing-bush", "water-bush", "completed", 25.0, 8.0),
            ForestMemoryRecent("harvest:clearing-bush", "harvest-berries", "completed", 35.0, 10.0))),
        garden = ForestMemoryGarden(listOf(ForestMemoryBush("clearing-bush", ForestMemoryPoint(310.0, 420.0), 0.45, 0.7, 180.0)), 3))
}

class ForestMemoryTest {
    @Test fun `version 1 retains exact field set while version 2 round trips garden`() {
        val old = memoryFixture()
        val expectedKeys = setOf("version", "sceneId", "fingerprint", "mind", "hero", "mushrooms")
        for (codec in listOf(forestMemoryJson, Json { encodeDefaults = true; explicitNulls = true })) {
            val encoded = codec.encodeToString(old)
            assertEquals(expectedKeys, codec.parseToJsonElement(encoded).jsonObject.keys)
            assertEquals(old, codec.decodeFromString<ForestMemoryPayload>(encoded))
            val garden = gardenMemoryFixture()
            validateForestMemoryPayload(garden)
            assertEquals(garden, codec.decodeFromString<ForestMemoryPayload>(codec.encodeToString(garden)))
        }
    }

    @Test fun `garden enforces schema version finite bounds and unique stable IDs`() {
        val valid = gardenMemoryFixture()
        val garden = requireNotNull(valid.garden)
        val bush = garden.bushes.single()
        val bad = listOf(
            valid.copy(version = 1), valid.copy(version = 3), valid.copy(garden = null),
            memoryFixture().copy(mind = valid.mind),
            valid.copy(garden = garden.copy(basketBerries = -1)), valid.copy(garden = garden.copy(basketBerries = 13)),
            valid.copy(garden = garden.copy(bushes = garden.bushes + garden.bushes)),
            valid.copy(garden = garden.copy(bushes = (0..32).map { bush.copy(id = "bush-$it") })),
        ) + listOf(
            bush.copy(id = ""), bush.copy(id = "a".repeat(161)), bush.copy(id = "bad\u0000"),
            bush.copy(position = ForestMemoryPoint(-1.0, 0.0)), bush.copy(position = ForestMemoryPoint(0.0, Double.NaN)),
            bush.copy(growth = Double.POSITIVE_INFINITY), bush.copy(growth = 1.01), bush.copy(moisture = Double.NaN),
            bush.copy(moisture = -0.01), bush.copy(waterIn = -1.0), bush.copy(waterIn = 600.01),
        ).map { valid.copy(garden = garden.copy(bushes = listOf(it))) }
        bad.forEach { assertEquals("INVALID_FOREST_MEMORY", assertFailsWith<AuthFailure> { validateForestMemoryPayload(it) }.code) }
        for (edge in listOf(0.0, 1.0)) validateForestMemoryPayload(valid.copy(garden = ForestMemoryGarden(
            (0..31).map { bush.copy(id = "bush-$it", growth = edge, moisture = edge, waterIn = edge * 600.0) }, (edge * 12).toInt())))
        validateForestMemoryPayload(valid.copy(garden = ForestMemoryGarden(emptyList(), 0)))
    }

    @Test fun `garden JSON rejects unknown keys null and quoted or fractional primitive values`() {
        val command = ForestMemoryCommand("0000-0000-0001", UUID.randomUUID().toString(), UUID.randomUUID().toString(), 0, "save",
            leaseToken = UUID.randomUUID().toString(), snapshot = gardenMemoryFixture())
        val json = forestMemoryJson.encodeToString(command)
        val gardenJson = forestMemoryJson.encodeToString(requireNotNull(command.snapshot?.garden))
        assertEquals(command, decodeForestMemoryCommand(forestMemoryJson.parseToJsonElement(json)))
        val invalid = listOf(
            json.replace("\"basketBerries\":3", "\"basketBerries\":\"3\""),
            json.replace("\"basketBerries\":3", "\"basketBerries\":3.5"),
            json.replace("\"basketBerries\":3", "\"basketBerries\":3,\"resources\":100"),
            json.replace("\"moisture\":0.7", "\"moisture\":\"0.7\""),
            json.replace("\"waterIn\":180.0", "\"waterIn\":\"180\""),
            json.replace("\"waterIn\":180.0", "\"waterIn\":180.0,\"extra\":true"),
            json.replace("\"garden\":$gardenJson", "\"garden\":null"),
            json.replace(",\"garden\":$gardenJson", ""),
        )
        invalid.forEach { raw ->
            assertNotEquals(json, raw)
            assertFailsWith<AuthFailure> { decodeForestMemoryCommand(forestMemoryJson.parseToJsonElement(raw)) }
        }
        val old = forestMemoryJson.encodeToString(command.copy(snapshot = memoryFixture()))
        val nullGarden = old.replace("\"mushrooms\":", "\"garden\":null,\"mushrooms\":")
        assertFailsWith<AuthFailure> { decodeForestMemoryCommand(forestMemoryJson.parseToJsonElement(nullGarden)) }
    }

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
