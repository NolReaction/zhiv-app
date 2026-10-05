package ru.zhiv.economy

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.util.UUID
import kotlin.test.*

class EconomyBarterRulesTest {
    private fun command() = EconomyBarterCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0,
        "create_offer", "ancient_core", "moon_crystal")
    private fun payload(command: EconomyBarterCommand = command()): JsonObject = buildJsonObject {
        put("requestId", command.requestId); put("ownerPublicId", command.ownerPublicId)
        put("expectedRevision", command.expectedRevision); put("action", command.action)
        if (command.action == "create_offer") {
            put("offeredItemId", command.offeredItemId); put("requestedItemId", command.requestedItemId)
        } else put("offerId", command.offerId)
    }

    @Test fun `strict union rejects money quantities foreign fields missing and coerced revisions`() {
        val valid = payload()
        EconomyBarterRules.validate(decodeEconomyBarterCommand(valid))
        val accept = command().copy(action="accept_offer", offeredItemId=null, requestedItemId=null, offerId=UUID.randomUUID().toString())
        assertEquals(accept, decodeEconomyBarterCommand(payload(accept)))
        assertEquals(accept.copy(action="cancel_offer"), decodeEconomyBarterCommand(payload(accept.copy(action="cancel_offer"))))
        for ((field, value) in listOf(
            "coins" to JsonPrimitive(1), "pearls" to JsonPrimitive(1), "quantity" to JsonPrimitive(1), "offerId" to JsonNull,
            "expectedRevision" to JsonPrimitive("0"), "expectedRevision" to JsonPrimitive(0.5),
            "expectedRevision" to JsonPrimitive(-1), "expectedRevision" to JsonPrimitive(ECONOMY_MAX_REVISION),
            "offeredItemId" to JsonPrimitive(1), "requestedItemId" to JsonNull,
        )) assertFailsWith<AuthFailure>(field) { decodeEconomyBarterCommand(JsonObject(valid + (field to value))) }
        for (field in valid.keys) assertFailsWith<AuthFailure>(field) { decodeEconomyBarterCommand(JsonObject(valid - field)) }
        assertFailsWith<AuthFailure> { decodeEconomyBarterCommand(JsonArray(listOf(valid))) }
        assertFailsWith<AuthFailure> { decodeEconomyBarterCommand(JsonObject(payload(accept) + ("offeredItemId" to JsonNull))) }
    }

    @Test fun `identifiers owner and action are validated for direct repository callers too`() {
        val valid = command()
        for (bad in listOf(valid.copy(requestId="wrong"), valid.copy(ownerPublicId=""), valid.copy(expectedRevision=-1),
            valid.copy(action="grant_relic"), valid.copy(offeredItemId=""), valid.copy(requestedItemId="x".repeat(81)),
            valid.copy(offeredItemId="moon_crystal"), valid.copy(offerId=UUID.randomUUID().toString()),
            valid.copy(action="accept_offer", offeredItemId=null, requestedItemId=null, offerId="not-a-uuid"))) {
            assertFailsWith<AuthFailure> { EconomyBarterRules.validate(bad) }
        }
    }

    @Test fun `only distinct catalog special nontradable materials can be exchanged`() {
        val relics = listOf("ancient_core", "moon_crystal", "living_resin")
        for (offered in relics) for (requested in relics) {
            if (offered == requested) assertFailsWith<AuthFailure> { EconomyBarterRules.validatePair(offered, requested) }
            else EconomyBarterRules.validatePair(offered, requested)
        }
        for (bad in listOf("coins", "pearls", "wood", "fish_mooncarp", "unknown")) {
            assertFalse(EconomyBarterRules.eligibleItem(bad))
            assertFailsWith<AuthFailure> { EconomyBarterRules.validatePair(bad, "ancient_core") }
            assertFailsWith<AuthFailure> { EconomyBarterRules.validatePair("ancient_core", bad) }
        }
        assertEquals(3, EconomyBarterRules.REQUIRED_HOME_LEVEL)
        assertEquals(3, EconomyBarterRules.MAX_OFFERS)
        assertEquals(6, EconomyBarterRules.SHOWCASE_SLOTS)
        assertEquals(1, EconomyBarterRules.SHOWCASE_PER_SELLER)
        assertEquals(1800L, EconomyBarterRules.SHOWCASE_SECONDS)
    }
}
