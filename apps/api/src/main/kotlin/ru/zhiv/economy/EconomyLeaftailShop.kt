package ru.zhiv.economy

import java.time.Instant
import ru.zhiv.world.WorldRules

/** Account stock has one UTC-day fence. Reading never grants or consumes inventory. */
object EconomyLeaftailShops {
    fun cycle(now: Instant, spec: EconomyLeaftailShopConfig): Long = Math.floorDiv(now.epochSecond, spec.refreshSeconds)

    fun normalized(saved: EconomyLeaftailShopState, now: Instant, spec: EconomyLeaftailShopConfig): EconomyLeaftailShopState {
        val current = cycle(now, spec)
        return if (saved.cycle >= current) saved else EconomyLeaftailShopState(cycle = current)
    }

    /** Matches the browser's unsigned 32-bit stock hash, including UTF-16 chars. */
    private fun deliveryHash(value: String): Long {
        var hash = 2166136261L.toInt()
        for (character in value) hash = (hash xor character.code) * 16777619
        hash = (hash xor (hash ushr 16)) * 0x7feb352d
        hash = (hash xor (hash ushr 15)) * 0x846ca68b.toInt()
        return (hash xor (hash ushr 16)).toLong() and 0xffffffffL
    }

    /** Identity is the authenticated account, not client entropy. Neither opening
     * the shop nor buying an offer rerolls the other finds in this saved cycle. */
    fun offers(catalog: EconomyCatalog, cycle: Long, ownerPublicId: String): List<EconomyLeaftailOffer> {
        val spec = catalog.leaftailShop ?: return emptyList()
        val offers = spec.offers + spec.travelOffers
        val specialItems = catalog.items.filter { it.category == "special" }.map { it.id }.toSet()
        val key = "leaftail-find-v1:$ownerPublicId:$cycle"
        val chosen = offers.filter { ownerPublicId.isNotEmpty() && it.kind == "item" && it.itemId in specialItems }
            .sortedWith(compareBy<EconomyLeaftailOffer> { deliveryHash("$key:${it.id}") }.thenBy { it.id })
            .take(1 + (deliveryHash("$key:count") % 2).toInt()).map { it.id }.toSet()
        return offers.filter { it.kind != "item" || it.itemId !in specialItems || it.id in chosen }
    }

    /** Merging accounts cannot replenish either account's consumed daily offers. */
    fun merge(a: EconomyLeaftailShopState, b: EconomyLeaftailShopState): EconomyLeaftailShopState {
        if (a.cycle != b.cycle) return if (a.cycle > b.cycle) a else b
        return a.copy(purchased = (a.purchased.keys + b.purchased.keys).associateWith {
            maxOf(a.purchased[it] ?: 0, b.purchased[it] ?: 0)
        })
    }

    /** The source is part of the server contract, never inferred from a client label. */
    fun validOffer(catalog: EconomyCatalog, offer: EconomyLeaftailOffer): Boolean {
        if (offer.kind == "item") return catalog.items.any { item -> item.id == offer.itemId &&
            if (item.category == "special") !item.tradable && offer.quantity == 1L
            else item.id in setOf("wood", "stone", "fiber") && item.tradable && offer.priceCoins == 2L * item.baseSellPrice * offer.quantity }
        if (offer.kind == "wardrobe") return offer.quantity == 1L && WorldRules.catalog.items.any {
            it.id == offer.itemId && it.slot in setOf("head", "neck", "palette") && !it.starter && it.purchase == null && it.sparks == 0L }
        // Explicit travelOffers membership chooses the merchant; default gear
        // shop controls Pleska's rotation and may also supply this caravan.
        val rod = catalog.fishing?.rods?.find { offer.kind == "rod" && it.id == offer.itemId }
        val hook = catalog.fishing?.hooks?.find { offer.kind == "hook" && it.id == offer.itemId }
        val bait = catalog.fishing?.baits?.find { offer.kind == "bait" && it.itemId == offer.itemId }
        val price = rod?.price ?: hook?.price ?: bait?.price ?: return false
        return offer.priceCoins == price * offer.quantity && (bait != null || offer.quantity == 1L)
    }

    fun buy(state: EconomyState, command: EconomyCommand, now: Instant, reservedItems: Map<String, Long>): Pair<EconomyState, String> {
        val catalog = EconomyRules.catalog
        val spec = catalog.leaftailShop
            ?: economyFailure("ECONOMY_LEAFTAIL_UNAVAILABLE", "Лавка Листохвоста пока недоступна")
        if (command.quantity != 1L) invalidEconomy()
        if ((state.buildings["home"] ?: 1) < spec.requiredHomeLevel)
            economyFailure("ECONOMY_HOME_REQUIRED", "Сначала улучшите дом до уровня ${spec.requiredHomeLevel}")
        val stock = normalized(state.leaftailShop, now, spec)
        // JdbcEconomyRepository verifies the command owner against the session
        // before this transition, so direct requests cannot select another stock.
        val offer = offers(catalog, stock.cycle, command.ownerPublicId).find { command.targetId == "${stock.cycle}:${it.id}" }
            ?: economyFailure("ECONOMY_LEAFTAIL_SHOP_CHANGED", "Поставка обновилась. Проверьте товары Листохвоста")
        if (!validOffer(catalog, offer)) economyFailure("ECONOMY_LEAFTAIL_SHOP_CHANGED", "Этот товар пока недоступен")
        val rod = catalog.fishing?.rods?.find { offer.kind == "rod" && it.id == offer.itemId }
        val hook = catalog.fishing?.hooks?.find { offer.kind == "hook" && it.id == offer.itemId }
        val bait = catalog.fishing?.baits?.find { offer.kind == "bait" && it.itemId == offer.itemId }
        val requiredHome = maxOf(spec.requiredHomeLevel, offer.requiredHomeLevel,
            rod?.requiredHomeLevel ?: hook?.requiredHomeLevel ?: bait?.requiredHomeLevel ?: 1)
        if ((state.buildings["home"] ?: 1) < requiredHome)
            economyFailure("ECONOMY_HOME_REQUIRED", "Сначала улучшите дом до уровня $requiredHome")
        if (command.totalPrice != offer.priceCoins)
            economyFailure("ECONOMY_LEAFTAIL_PRICE_CHANGED", "Цена изменилась. Проверьте стоимость товара")
        if ((stock.purchased[offer.id] ?: 0) >= offer.stock)
            economyFailure("ECONOMY_LEAFTAIL_STOCK", "Сегодня этот товар уже куплен. Дождитесь новой поставки")
        if (offer.kind == "wardrobe" && offer.itemId in state.wardrobe)
            economyFailure("ECONOMY_WARDROBE_OWNED", "Эта вещь уже есть в гардеробе")
        if (rod != null && rod.id in state.fishing.ownedRods || hook != null && hook.id in state.fishing.ownedHooks)
            economyFailure("ECONOMY_FISHING_OWNED", "Эта снасть уже есть в коллекции")
        if (state.wallet.coins < offer.priceCoins) economyFailure("ECONOMY_RESOURCES", "Не хватает монет")
        val inventoryGrant = offer.kind == "item" || offer.kind == "bait"
        val inventory = if (inventoryGrant) EconomyRules.addItems(state.inventory, mapOf(offer.itemId to offer.quantity)) else state.inventory
        val next = state.copy(inventory = inventory,
            wardrobe = if (offer.kind == "wardrobe") (state.wardrobe + offer.itemId).distinct().sorted() else state.wardrobe,
            fishing = if (rod != null) state.fishing.copy(ownedRods = state.fishing.ownedRods + rod.id)
                else if (hook != null) state.fishing.copy(ownedHooks = state.fishing.ownedHooks + hook.id) else state.fishing,
            wallet = state.wallet.copy(coins = state.wallet.coins - offer.priceCoins),
            leaftailShop = stock.copy(purchased = stock.purchased + (offer.id to ((stock.purchased[offer.id] ?: 0) + 1))))
        if (inventoryGrant) {
            EconomyRules.addItems(inventory, reservedItems)
            EconomyRules.assertStorageTransition(state, next, reservedItems)
        }
        return next to when (offer.kind) {
            "wardrobe" -> "Покупка у Листохвоста добавлена в гардероб"
            "rod" -> "Удочка у Листохвоста добавлена в коллекцию"
            "hook" -> "Крючок у Листохвоста добавлен в коллекцию"
            else -> "Покупка у Листохвоста отправлена в кладовую"
        }
    }
}
