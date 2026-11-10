package ru.zhiv.economy

import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class EconomyBoatAimTest {
    @Test fun `server recomputes the score of the visible aiming track`() {
        val vectors = checkNotNull(javaClass.getResourceAsStream("/world/boat-cast-aim-vectors.json"))
            .bufferedReader().use { economyJson.parseToJsonElement(it.readText()).jsonArray }
        for (case in vectors) {
            val row = case.jsonObject
            val id = row.getValue("voyageId").jsonPrimitive.content
            val cast = row.getValue("cast").jsonPrimitive.int
            val offset = row.getValue("heldMs").jsonPrimitive.int
            assertEquals(row.getValue("quality").jsonPrimitive.int, boatCastQuality(id, cast, offset))
        }
    }
}
