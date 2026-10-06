package ru.zhiv.economy

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4

@Serializable
data class EconomyMarketListing(
    val id: String,
    val sellerPublicId: String,
    val sellerName: String,
    val itemId: String,
    val quantity: Long,
    val totalPrice: Long,
    val status: String,
    val createdAt: String,
    val closedAt: String? = null,
    val owned: Boolean,
    val feeBps: Int = 0,
)

@Serializable
data class EconomyMarketShowcase(val refreshAt: String, val slots: Int, val maxPerSeller: Int, val refreshSeconds: Long)

@Serializable
data class EconomyMarketTradeBudget(
    val buysUsed: Long, val salesUsed: Long, val limit: Long, val resetsAt: String,
    val feeBps: Int, val homeBandMin: Int, val homeBandMax: Int,
)

@Serializable
data class EconomyMarketView(
    val listings: List<EconomyMarketListing>,
    val mine: List<EconomyMarketListing>,
    val nextCursor: String? = null,
    val serverTime: String,
    val showcase: EconomyMarketShowcase,
    val tradeBudget: EconomyMarketTradeBudget? = null,
)

interface EconomyMarketRepository {
    suspend fun market(sessionHash: ByteArray, cursor: String? = null, limit: Int = EconomyRules.catalog.market.showcaseSlots): EconomyMarketView
    suspend fun command(sessionHash: ByteArray, command: EconomyCommand): EconomyResult
}

/** Pure validation shared by the SQL boundary and inexpensive unit tests. */
object EconomyMarketRules {
    const val MAX_LISTINGS = 10
    const val MAX_QUANTITY = 99L
    const val MAX_PRICE_MULTIPLIER = 2L
    const val MAX_PAGE_SIZE = 12

    fun homeBand(homeLevel: Int): IntRange = when (homeLevel) {
        2, 3 -> 2..3
        4, 5 -> 4..5
        else -> 1..1
    }

    fun sameHomeBand(buyerHome: Int, sellerHome: Int): Boolean =
        buyerHome in 2..5 && sellerHome in homeBand(buyerHome)

    fun dailyTradeLimit(homeLevel: Int, config: EconomyMarketConfig = EconomyRules.catalog.market): Long =
        config.dailyTradeValueByHome.getOrNull(homeLevel - 1) ?: 0L

    fun sellerFee(totalPrice: Long, feeBps: Int): Long {
        require(totalPrice in 0L..ECONOMY_MAX_BALANCE && feeBps in 0..10000)
        return (totalPrice * feeBps + 9999L) / 10000L
    }

    fun assertTradeBudget(used: Long, value: Long, limit: Long, seller: Boolean = false) {
        if (used < 0L || value <= 0L || used > limit || value > limit - used)
            throw AuthFailure(if (seller) "ECONOMY_MARKET_SELLER_DAILY_LIMIT" else "ECONOMY_MARKET_DAILY_LIMIT",
                if (seller) "Продавец исчерпал дневной объём продаж. Выберите другую партию."
                else "Дневной объём покупок исчерпан. Лимит обновится в 00:00 UTC.", 409)
    }

    fun validate(command: EconomyCommand) {
        validateEconomyCommand(command)
        if (parseCanonicalUuidV4(command.requestId) == null || command.ownerPublicId.isBlank() ||
            command.ownerPublicId.length > 80 || command.expectedRevision !in 0L until 9_007_199_254_740_991L ||
            command.targetId.isBlank() || command.targetId.length > 80 ||
            command.action !in setOf("create_listing", "buy_listing", "cancel_listing")) {
            throw AuthFailure("INVALID_ECONOMY_COMMAND", "Некорректный запрос рынка", 400)
        }
        if (command.action != "create_listing" && parseCanonicalUuidV4(command.targetId) == null)
            throw AuthFailure("INVALID_ECONOMY_COMMAND", "Некорректное объявление", 400)
        if (command.action == "cancel_listing") {
            if (command.quantity != 1L || command.totalPrice != 0L)
                throw AuthFailure("INVALID_ECONOMY_COMMAND", "Некорректный запрос отмены", 400)
        } else {
            if (command.quantity !in 1L..EconomyRules.catalog.market.maxLotQuantity)
                throw AuthFailure("ECONOMY_MARKET_QUANTITY", "В объявлении может быть от 1 до 99 предметов", 400)
            if (command.totalPrice !in command.quantity..ECONOMY_MAX_BALANCE)
                throw AuthFailure("ECONOMY_MARKET_PRICE", "Укажите цену всей партии в монетах", 400)
        }
    }

    fun validatePrice(quantity: Long, totalPrice: Long, baseSellPrice: Long, multiplier: Long = MAX_PRICE_MULTIPLIER) {
        // Catalog prices are bounded independently; division avoids overflow even for a corrupt catalog.
        if (quantity !in 1L..MAX_QUANTITY || baseSellPrice <= 0L || multiplier !in 1L..MAX_PRICE_MULTIPLIER ||
            totalPrice !in quantity..ECONOMY_MAX_BALANCE || totalPrice % ECONOMY_CURRENCY_SCALE != 0L || totalPrice / quantity < baseSellPrice || (totalPrice - 1L) / quantity / multiplier >= baseSellPrice) {
            throw AuthFailure("ECONOMY_MARKET_PRICE", "Цена партии должна быть от базовой до двойной стоимости", 400)
        }
    }

    fun requiredHomeLevel(itemId: String, catalog: EconomyCatalog = EconomyRules.catalog): Int {
        fun buildingHome(id: String, level: Int, seen: Set<String> = emptySet()): Int {
            if (id == "home") return level
            val key = "$id:$level"
            if (key in seen) return Int.MAX_VALUE
            val definition = catalog.buildings.firstOrNull { it.id == id }?.levels?.firstOrNull { it.level == level }
                ?: return Int.MAX_VALUE
            return maxOf(definition.requiredHomeLevel, definition.requiredBuildings.maxOfOrNull { (required, amount) ->
                buildingHome(required, amount, seen + key)
            } ?: 1)
        }
        fun requirements(home: Int, buildings: Map<String, Int>): Int = maxOf(home,
            buildings.maxOfOrNull { (id, level) -> buildingHome(id, level) } ?: 1)
        val sources = (catalog.recipes.filter { (it.rewards[itemId] ?: 0L) > 0L }.map { recipe ->
            requirements(recipe.requiredHomeLevel, recipe.requiredBuildings + (recipe.buildingId to
                maxOf(recipe.buildingLevel, recipe.requiredBuildings[recipe.buildingId] ?: 0)))
        } + catalog.explorations.filter { (it.rewards[itemId] ?: 0L) > 0L }
            .map { requirements(it.requiredHomeLevel, it.requiredBuildings) }).toMutableList()
        catalog.fishing?.let { fishing ->
            fishing.baits.find { it.itemId == itemId }?.let { sources += it.requiredHomeLevel }
            fishing.fish.find { it.itemId == itemId }?.let { fish ->
                val hookHome = fish.requiredHookId?.let { id ->
                    fishing.hooks.find { it.id == id }?.requiredHomeLevel ?: Int.MAX_VALUE
                } ?: 1
                sources += catalog.explorations.filter { it.id in fishing.routeIds }.map {
                    maxOf(hookHome, requirements(it.requiredHomeLevel, it.requiredBuildings))
                }
            }
        }
        return sources.minOrNull() ?: Int.MAX_VALUE
    }

    fun eligible(itemId: String, quantity: Long, totalPrice: Long, homeLevel: Int): Boolean {
        val item = EconomyRules.catalog.items.firstOrNull { it.id == itemId && it.tradable } ?: return false
        return quantity in 1L..MAX_QUANTITY && totalPrice / quantity >= item.baseSellPrice &&
            totalPrice <= item.baseSellPrice * quantity * EconomyRules.catalog.market.maxPriceMultiplier &&
            homeLevel >= requiredHomeLevel(itemId)
    }
}
