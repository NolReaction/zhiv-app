package ru.zhiv.relationships

import kotlinx.serialization.Serializable
import ru.zhiv.economy.EconomyMarketRules
import ru.zhiv.economy.EconomyPlayerProgression
import ru.zhiv.economy.EconomyState

@Serializable data class FriendMarketPreview(val id: String, val itemId: String, val quantity: Long, val totalPrice: Long)
@Serializable data class FriendMarketSummary(
    val available: Boolean, val reason: String?, val count: Int, val listings: List<FriendMarketPreview>,
)
@Serializable data class FriendGameSummary(val level: Int, val market: FriendMarketSummary)

/** The active friendship authorizes the level; world sharing separately guards the storefront.
 * Callers supply active lots in newest-first order and projected buyer item discovery. */
object FriendGameSummaryRules {
    fun project(playerXp: Long, seller: EconomyState?, buyer: EconomyState?, worldVisible: Boolean,
                activeListings: List<FriendMarketPreview>): FriendGameSummary {
        val reason = when {
            !worldVisible -> "world_hidden"
            buyer == null || !EconomyMarketRules.unlocked(buyer) -> "buyer_locked"
            seller == null || !EconomyMarketRules.unlocked(seller) -> "seller_locked"
            !EconomyMarketRules.canTrade(buyer.buildings["home"] ?: 1, seller.buildings["home"] ?: 1) -> "home_band"
            else -> null
        }
        val visible = if (reason == null && buyer != null) activeListings.filter {
            EconomyMarketRules.eligible(it.itemId, it.quantity, it.totalPrice, buyer)
        } else emptyList()
        return FriendGameSummary(EconomyPlayerProgression.level(playerXp),
            FriendMarketSummary(reason == null, reason, visible.size, visible.take(3)))
    }
}
