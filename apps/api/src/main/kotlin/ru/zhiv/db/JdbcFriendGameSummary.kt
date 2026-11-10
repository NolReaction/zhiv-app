package ru.zhiv.db

import kotlinx.serialization.json.*
import ru.zhiv.economy.*
import ru.zhiv.relationships.*
import java.sql.Connection
import java.sql.ResultSet
import java.util.UUID

/** One viewer projection per people response, never a profile creation or a write. */
internal fun friendSummaryBuyer(c: Connection, viewer: UUID): EconomyState? =
    if (c.economyRows("SELECT 1 FROM economy_profiles WHERE user_id=?", viewer) { true }.isEmpty()) null
    else readEconomyProfile(c, viewer).state

internal fun ResultSet.friendGameSummary(buyer: EconomyState?): FriendGameSummary {
    val economy = getString("friend_economy")?.let { Json.parseToJsonElement(it).jsonObject }
    val seller = economy?.let { saved -> EconomyRules.initial(includeStartingPack=false).copy(
        buildings = saved["buildings"]?.jsonObject?.mapValues { it.value.jsonPrimitive.int } ?: emptyMap(),
        completedExplorations = saved["completedExplorations"]?.jsonPrimitive?.longOrNull ?: 0,
    ) }
    val xp = economy?.get("progression")?.jsonObject?.get("player")?.takeUnless { it is JsonNull }
        ?.jsonObject?.get("xp")?.jsonPrimitive?.longOrNull ?: 0
    val listings = Json.parseToJsonElement(getString("friend_listings")).jsonArray.map { value ->
        val row = value.jsonObject
        FriendMarketPreview(row.getValue("id").jsonPrimitive.content, row.getValue("itemId").jsonPrimitive.content,
            row.getValue("quantity").jsonPrimitive.long,
            EconomyMoney.nominal(row.getValue("totalPrice").jsonPrimitive.long, row.getValue("currencyScale").jsonPrimitive.int))
    }
    return FriendGameSummaryRules.project(xp, seller, buyer, getString("their_sharing_mode") != "OFF", listings)
}
