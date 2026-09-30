package ru.zhiv.economy

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4
import java.time.Instant
import java.util.Base64
import java.util.UUID

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
)

@Serializable
data class EconomyMarketView(
    val listings: List<EconomyMarketListing>,
    val mine: List<EconomyMarketListing>,
    val nextCursor: String? = null,
    val serverTime: String,
)

interface EconomyMarketRepository {
    suspend fun market(sessionHash: ByteArray, cursor: String? = null, limit: Int = 30): EconomyMarketView
    suspend fun command(sessionHash: ByteArray, command: EconomyCommand): EconomyResult
}

internal data class EconomyMarketCursor(val createdAt: Instant, val id: UUID)

/** Pure validation shared by the SQL boundary and inexpensive unit tests. */
object EconomyMarketRules {
    const val MAX_LISTINGS = 10
    const val MAX_QUANTITY = 99L
    const val MAX_PRICE_MULTIPLIER = 5L
    const val MAX_PAGE_SIZE = 50

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
            if (command.totalPrice !in command.quantity..1_000_000_000L)
                throw AuthFailure("ECONOMY_MARKET_PRICE", "Укажите цену всей партии в монетах", 400)
        }
    }

    fun validatePrice(quantity: Long, totalPrice: Long, baseSellPrice: Long, multiplier: Long = MAX_PRICE_MULTIPLIER) {
        // Catalog prices are bounded independently; division avoids overflow even for a corrupt catalog.
        if (quantity !in 1L..MAX_QUANTITY || baseSellPrice <= 0L || multiplier !in 1L..MAX_PRICE_MULTIPLIER ||
            totalPrice !in quantity..1_000_000_000L || (totalPrice - 1L) / quantity / multiplier >= baseSellPrice) {
            throw AuthFailure("ECONOMY_MARKET_PRICE", "Цена партии не может превышать пятикратную цену рынка", 400)
        }
    }

    internal fun cursor(value: String?): EconomyMarketCursor? {
        if (value == null) return null
        if (value.isBlank() || value.length > 160)
            throw AuthFailure("INVALID_ECONOMY_QUERY", "Некорректная страница рынка", 400)
        return runCatching {
            val parts = String(Base64.getUrlDecoder().decode(value), Charsets.UTF_8).split('|')
            require(parts.size == 2)
            EconomyMarketCursor(Instant.parse(parts[0]), requireNotNull(parseCanonicalUuidV4(parts[1])))
        }.getOrElse { throw AuthFailure("INVALID_ECONOMY_QUERY", "Некорректная страница рынка", 400) }
    }

    internal fun cursor(listing: EconomyMarketListing): String = Base64.getUrlEncoder().withoutPadding()
        .encodeToString("${listing.createdAt}|${listing.id}".toByteArray(Charsets.UTF_8))
}
