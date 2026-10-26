package ru.zhiv.economy

/** Deterministic sink for duplicate relics. The usual command transaction owns
 * revision, replay protection and the ledger; no random roll or clock changes. */
object EconomyLeaftailRelics {
    fun exchange(state: EconomyState, command: EconomyCommand, reservedItems: Map<String, Long>): Pair<EconomyState, String> {
        val catalog = EconomyRules.catalog
        val shop = catalog.leaftailShop
            ?: economyFailure("ECONOMY_LEAFTAIL_UNAVAILABLE", "Листохвост пока не обменивает реликвии")
        val config = shop.relicExchange
            ?: economyFailure("ECONOMY_LEAFTAIL_UNAVAILABLE", "Листохвост пока не обменивает реликвии")
        if (command.quantity != 1L || command.fishSelection != null) invalidEconomy()
        val parts = command.targetId.split(':')
        val items = catalog.rareDrops?.itemIds.orEmpty().filter { id -> catalog.items.any { it.id == id && it.category == "special" && !it.tradable } }
        if (parts.size != 2 || parts[0] == parts[1] || parts.any { it !in items }) invalidEconomy()
        val (from, to) = parts
        val requiredHome = maxOf(shop.requiredHomeLevel, config.requiredHomeLevel)
        if ((state.buildings["home"] ?: 1) < requiredHome)
            economyFailure("ECONOMY_HOME_REQUIRED", "Сначала улучшите дом до уровня $requiredHome")
        if (command.totalPrice != config.priceCoins)
            economyFailure("ECONOMY_LEAFTAIL_PRICE_CHANGED", "Цена обмена изменилась. Проверьте предложение Листохвоста")
        val spent = EconomyRules.spend(state, EconomyCost(coins = config.priceCoins, items = mapOf(from to config.quantity)))
        val next = spent.copy(inventory = EconomyRules.addItems(spent.inventory, mapOf(to to 1L)))
        EconomyRules.addItems(next.inventory, reservedItems)
        EconomyRules.assertStorageTransition(state, next, reservedItems)
        return next to "Реликвии обменены. Находка отправлена в кладовую"
    }
}
