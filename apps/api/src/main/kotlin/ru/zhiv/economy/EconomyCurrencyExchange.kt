package ru.zhiv.economy

import kotlinx.serialization.Serializable
import java.text.NumberFormat
import java.util.Locale

@Serializable data class EconomyCurrencyExchangeOffer(
    val id: String, val name: String, val pearls: Long, val coins: Long, val bonusPercent: Int,
) {
    init {
        require(id.length <= 80 && Regex("^gold_[a-z]+_v[1-9][0-9]*$").matches(id))
        require(name.length in 1..100)
        require(pearls in 1L..ECONOMY_MAX_PEARLS && pearls % 2L == 0L)
        require(coins in 1L..ECONOMY_MAX_BALANCE && bonusPercent in 0..20)
        // Stored pearl units are halves of displayed pearls. Base rate: 50 coins per displayed pearl.
        require(coins * 100L == pearls * 25L * (100L + bonusPercent))
    }
}

@Serializable data class EconomyCurrencyExchangeCatalog(val version: Int, val offers: List<EconomyCurrencyExchangeOffer>) {
    init {
        require(version == 1 && offers.size in 1..10)
        require(offers.map { it.id }.distinct().size == offers.size)
    }
}

/** One-way wallet exchange through the normal authenticated economy transaction and receipt.
 * A published ID freezes price AND payout; changing either requires a new versioned offer ID. */
object EconomyCurrencyExchange {
    val config: EconomyCurrencyExchangeCatalog by lazy {
        economyJson.decodeFromString<EconomyCurrencyExchangeCatalog>(checkNotNull(
            EconomyCurrencyExchange::class.java.getResourceAsStream("/world/currency-exchange-catalog.json")
        ).bufferedReader().use { it.readText() })
    }

    fun exchange(state: EconomyState, command: EconomyCommand): Pair<EconomyState, String> {
        if (command.quantity != 1L || command.fishSelection != null || command.voyageId != null || command.orderId != null || command.itemId != null)
            invalidEconomy()
        val offer = config.offers.find { it.id == command.targetId }
            ?: economyFailure("ECONOMY_EXCHANGE_CHANGED", "Предложение обмена изменилось. Откройте магазин заново")
        if (command.totalPrice != offer.pearls)
            economyFailure("ECONOMY_EXCHANGE_PRICE_CHANGED", "Цена обмена изменилась. Проверьте предложение")
        if (state.wallet.pearls < offer.pearls) economyFailure("ECONOMY_PEARLS", "Не хватает жемчуга")
        if (state.wallet.coins > ECONOMY_MAX_BALANCE - offer.coins) economyFailure("ECONOMY_CAPACITY", "Кошелёк заполнен")
        val next = state.copy(wallet = state.wallet.copy(coins = state.wallet.coins + offer.coins, pearls = state.wallet.pearls - offer.pearls))
        val amount = NumberFormat.getIntegerInstance(Locale.forLanguageTag("ru-RU")).format(offer.coins)
        return next to "Обмен выполнен. Получено $amount монет"
    }
}
