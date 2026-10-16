package ru.zhiv.economy

import java.time.Instant

/** Account stock has one UTC-day fence. Reading never grants or consumes inventory. */
object EconomyLeaftailShops {
    fun cycle(now: Instant, spec: EconomyLeaftailShopConfig): Long = Math.floorDiv(now.epochSecond, spec.refreshSeconds)

    fun normalized(saved: EconomyLeaftailShopState, now: Instant, spec: EconomyLeaftailShopConfig): EconomyLeaftailShopState {
        val current = cycle(now, spec)
        return if (saved.cycle >= current) saved else EconomyLeaftailShopState(cycle = current)
    }

    /** Merging accounts cannot replenish either account's consumed daily offers. */
    fun merge(a: EconomyLeaftailShopState, b: EconomyLeaftailShopState): EconomyLeaftailShopState {
        if (a.cycle != b.cycle) return if (a.cycle > b.cycle) a else b
        return a.copy(purchased = (a.purchased.keys + b.purchased.keys).associateWith {
            maxOf(a.purchased[it] ?: 0, b.purchased[it] ?: 0)
        })
    }

    fun buy(state: EconomyState, command: EconomyCommand, now: Instant, reservedItems: Map<String, Long>): Pair<EconomyState, String> {
        val spec = EconomyRules.catalog.leaftailShop
            ?: economyFailure("ECONOMY_LEAFTAIL_UNAVAILABLE", "Лавка Листохвоста пока недоступна")
        if (command.quantity != 1L) invalidEconomy()
        if ((state.buildings["home"] ?: 1) < spec.requiredHomeLevel)
            economyFailure("ECONOMY_HOME_REQUIRED", "Сначала улучшите дом до уровня ${spec.requiredHomeLevel}")
        val stock = normalized(state.leaftailShop, now, spec)
        val offer = spec.offers.find { command.targetId == "${stock.cycle}:${it.id}" }
            ?: economyFailure("ECONOMY_LEAFTAIL_SHOP_CHANGED", "Поставка обновилась. Проверьте товары Листохвоста")
        if (EconomyRules.catalog.items.none { it.id == offer.itemId && it.category == "special" && !it.tradable })
            economyFailure("ECONOMY_LEAFTAIL_SHOP_CHANGED", "Этот товар пока недоступен")
        if (command.totalPrice != offer.priceCoins)
            economyFailure("ECONOMY_LEAFTAIL_PRICE_CHANGED", "Цена изменилась. Проверьте стоимость товара")
        if ((stock.purchased[offer.id] ?: 0) >= offer.stock)
            economyFailure("ECONOMY_LEAFTAIL_STOCK", "Сегодня этот товар уже куплен. Дождитесь новой поставки")
        if (state.wallet.coins < offer.priceCoins)
            economyFailure("ECONOMY_RESOURCES", "Не хватает монет")
        val inventory = EconomyRules.addItems(state.inventory, mapOf(offer.itemId to 1L))
        EconomyRules.addItems(inventory, reservedItems)
        val next = state.copy(inventory = inventory,
            wallet = state.wallet.copy(coins = state.wallet.coins - offer.priceCoins),
            leaftailShop = stock.copy(purchased = stock.purchased + (offer.id to ((stock.purchased[offer.id] ?: 0) + 1))))
        EconomyRules.assertStorageTransition(state, next, reservedItems)
        return next to "Покупка у Листохвоста отправлена в кладовую"
    }
}
