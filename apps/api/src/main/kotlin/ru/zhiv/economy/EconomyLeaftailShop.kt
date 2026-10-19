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

    /** Prices are stored wallet units. Legacy offers retain their complete bundle. */
    data class DailyOffer(val id: String, val itemId: String, val currency: String, val unitPrice: Long,
        val stock: Int, val quantity: Long, val kind: String, val requiredHomeLevel: Int) {
        val priceCoins: Long get() = if (currency == "coins") unitPrice else 0L
        val pricePearls: Long get() = if (currency == "pearls") unitPrice else 0L
    }

    fun isV2(spec: EconomyLeaftailShopConfig): Boolean = spec.supplyOffers.isNotEmpty() || spec.pearlOffers.isNotEmpty()
    fun targetId(spec: EconomyLeaftailShopConfig, cycle: Long, id: String): String =
        "${if (isV2(spec)) "v2:" else ""}$cycle:$id"

    private fun requiredHome(catalog: EconomyCatalog, kind: String, itemId: String, required: Int): Int {
        val gear = when (kind) {
            "rod" -> catalog.fishing?.rods?.find { it.id == itemId }?.requiredHomeLevel
            "hook" -> catalog.fishing?.hooks?.find { it.id == itemId }?.requiredHomeLevel
            "bait" -> catalog.fishing?.baits?.find { it.itemId == itemId }?.requiredHomeLevel
            else -> null
        } ?: 1
        return maxOf(catalog.leaftailShop?.requiredHomeLevel ?: 1, required, gear)
    }

    private fun legacyOffer(catalog: EconomyCatalog, offer: EconomyLeaftailOffer, units: Boolean): DailyOffer {
        val unit = units && offer.kind in setOf("item", "bait")
        return DailyOffer(offer.id, offer.itemId, "coins", if (unit) offer.priceCoins / offer.quantity else offer.priceCoins,
            if (unit) (offer.stock * offer.quantity).toInt() else offer.stock, if (unit) 1 else offer.quantity,
            offer.kind, requiredHome(catalog, offer.kind, offer.itemId, offer.requiredHomeLevel))
    }

    private fun section(catalog: EconomyCatalog, offer: DailyOffer): String = when (offer.kind) {
        "wardrobe", "rod", "hook", "bait" -> offer.kind
        else -> if (catalog.items.any { it.id == offer.itemId && it.category == "special" }) "finds" else "supplies"
    }

    /** Authenticated identity fixes each section's ring. A new day advances it;
     * opening, ownership, purchasing and request entropy cannot reroll the shelf. */
    fun offers(catalog: EconomyCatalog, cycle: Long, ownerPublicId: String, homeLevel: Int = 5): List<DailyOffer> {
        val spec = catalog.leaftailShop ?: return emptyList()
        if (!isV2(spec)) {
            val raw = spec.offers + spec.travelOffers
            val special = catalog.items.filter { it.category == "special" }.map { it.id }.toSet()
            val key = "leaftail-find-v1:$ownerPublicId:$cycle"
            val chosen = raw.filter { ownerPublicId.isNotEmpty() && it.kind == "item" && it.itemId in special }
                .sortedWith(compareBy<EconomyLeaftailOffer> { deliveryHash("$key:${it.id}") }.thenBy { it.id })
                .take(1 + (deliveryHash("$key:count") % 2).toInt()).map { it.id }.toSet()
            return raw.filter { it.kind != "item" || it.itemId !in special || it.id in chosen }.map { legacyOffer(catalog, it, false) }
        }
        if (ownerPublicId.isEmpty()) return emptyList()
        val supplies = if (spec.supplyOffers.isNotEmpty()) spec.supplyOffers.map {
            DailyOffer(it.id, it.itemId, "coins", it.unitPriceCoins, it.stock, 1, "item",
                requiredHome(catalog, "item", it.itemId, it.requiredHomeLevel))
        } else spec.offers.map { legacyOffer(catalog, it, true) }
        val pool = (spec.travelOffers.map { legacyOffer(catalog, it, true) } + supplies + spec.pearlOffers.map {
            DailyOffer(it.id, it.itemId, "pearls", it.pricePearls, it.stock, 1, "item",
                requiredHome(catalog, "item", it.itemId, it.requiredHomeLevel))
        }).filter { it.requiredHomeLevel <= homeLevel }
        val selected = mutableSetOf<String>()
        for ((department, size) in listOf("wardrobe" to 2, "rod" to 1, "hook" to 1, "bait" to 1, "supplies" to 3,
            "finds" to 1 + (deliveryHash("leaftail-stock-v2:$ownerPublicId:$cycle:finds-count") % 2).toInt())) {
            val ring = pool.filter { section(catalog, it) == department }
                .sortedWith(compareBy<DailyOffer> { deliveryHash("leaftail-stock-v2:$ownerPublicId:$department:${it.id}") }.thenBy { it.id })
            if (ring.isEmpty()) continue
            val stride = if (department == "wardrobe") 2 else if (department == "supplies") 3 else 1
            val offset = (Math.floorMod(cycle, ring.size.toLong()) * stride % ring.size).toInt()
            repeat(minOf(size, ring.size)) { index -> selected += ring[(offset + index) % ring.size].id }
        }
        return pool.filter { it.id in selected }
    }

    /** Merging accounts cannot replenish either account's consumed daily offers. */
    fun merge(a: EconomyLeaftailShopState, b: EconomyLeaftailShopState): EconomyLeaftailShopState {
        if (a.cycle != b.cycle) return if (a.cycle > b.cycle) a else b
        return a.copy(purchased = (a.purchased.keys + b.purchased.keys).associateWith {
            minOf(100, (a.purchased[it] ?: 0) + (b.purchased[it] ?: 0))
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

    /** V2 sources cannot silently reinterpret legacy coin offers as pearl purchases. */
    fun validCatalog(catalog: EconomyCatalog, spec: EconomyLeaftailShopConfig): Boolean {
        if (!(spec.offers + spec.travelOffers).all { validOffer(catalog, it) }) return false
        if (spec.supplyOffers.any { offer -> catalog.items.none { item -> item.id == offer.itemId && item.tradable &&
                item.category in setOf("material", "crafted", "provisions", "produce") && offer.unitPriceCoins >= 2L * item.baseSellPrice } }) return false
        if (spec.pearlOffers.any { offer -> catalog.items.none { it.id == offer.itemId && it.category == "special" && !it.tradable } }) return false
        if (isV2(spec)) {
            val converted = (if (spec.supplyOffers.isEmpty()) spec.offers else emptyList()) + spec.travelOffers.filter { it.kind == "bait" }
            if (converted.any { it.priceCoins % it.quantity != 0L || it.stock * it.quantity > 100L }) return false
            if (spec.supplyOffers.isEmpty() && spec.offers.any { offer -> catalog.items.any { it.id == offer.itemId && it.category == "special" } }) return false
        }
        return true
    }

    fun buy(state: EconomyState, command: EconomyCommand, now: Instant, reservedItems: Map<String, Long>): Pair<EconomyState, String> {
        val catalog = EconomyRules.catalog
        val spec = catalog.leaftailShop
            ?: economyFailure("ECONOMY_LEAFTAIL_UNAVAILABLE", "Лавка Листохвоста пока недоступна")
        val v2 = isV2(spec)
        if (command.quantity !in 1L..20L || !v2 && command.quantity != 1L) invalidEconomy()
        val home = state.buildings["home"] ?: 1
        if (home < spec.requiredHomeLevel)
            economyFailure("ECONOMY_HOME_REQUIRED", "Сначала улучшите дом до уровня ${spec.requiredHomeLevel}")
        val stock = normalized(state.leaftailShop, now, spec)
        // The session adapter verifies the owner. Distinct V2 targets make old
        // quotes fail closed after a catalog update, even at an equal amount.
        val offer = offers(catalog, stock.cycle, command.ownerPublicId, home)
            .find { command.targetId == targetId(spec, stock.cycle, it.id) }
            ?: economyFailure("ECONOMY_LEAFTAIL_SHOP_CHANGED", "Поставка обновилась. Проверьте товары Листохвоста")
        val rod = catalog.fishing?.rods?.find { offer.kind == "rod" && it.id == offer.itemId }
        val hook = catalog.fishing?.hooks?.find { offer.kind == "hook" && it.id == offer.itemId }
        if (home < offer.requiredHomeLevel)
            economyFailure("ECONOMY_HOME_REQUIRED", "Сначала улучшите дом до уровня ${offer.requiredHomeLevel}")
        if (offer.currency == "pearls" || offer.kind in setOf("wardrobe", "rod", "hook")) {
            if (command.quantity != 1L) invalidEconomy()
        }
        if (offer.unitPrice > ECONOMY_MAX_BALANCE / command.quantity) invalidEconomy()
        val price = offer.unitPrice * command.quantity
        if (command.totalPrice != price)
            economyFailure("ECONOMY_LEAFTAIL_PRICE_CHANGED", "Цена изменилась. Проверьте стоимость товара")
        val purchased = stock.purchased[offer.id] ?: 0
        if (command.quantity > offer.stock - purchased)
            economyFailure("ECONOMY_LEAFTAIL_STOCK", "Сегодня столько товара не осталось. Дождитесь новой поставки")
        if (offer.kind == "wardrobe" && offer.itemId in state.wardrobe)
            economyFailure("ECONOMY_WARDROBE_OWNED", "Эта вещь уже есть в гардеробе")
        if (rod != null && rod.id in state.fishing.ownedRods || hook != null && hook.id in state.fishing.ownedHooks)
            economyFailure("ECONOMY_FISHING_OWNED", "Эта снасть уже есть в коллекции")
        val balance = if (offer.currency == "pearls") state.wallet.pearls else state.wallet.coins
        if (balance < price) economyFailure(if (offer.currency == "pearls") "ECONOMY_PEARLS" else "ECONOMY_RESOURCES",
            if (offer.currency == "pearls") "Не хватает жемчужин" else "Не хватает монет")
        val inventoryGrant = offer.kind == "item" || offer.kind == "bait"
        val quantity = offer.quantity * command.quantity
        val inventory = if (inventoryGrant) EconomyRules.addItems(state.inventory, mapOf(offer.itemId to quantity)) else state.inventory
        val next = state.copy(inventory = inventory,
            wardrobe = if (offer.kind == "wardrobe") (state.wardrobe + offer.itemId).distinct().sorted() else state.wardrobe,
            fishing = if (rod != null) state.fishing.copy(ownedRods = state.fishing.ownedRods + rod.id)
                else if (hook != null) state.fishing.copy(ownedHooks = state.fishing.ownedHooks + hook.id) else state.fishing,
            wallet = if (offer.currency == "pearls") state.wallet.copy(pearls = balance - price) else state.wallet.copy(coins = balance - price),
            leaftailShop = stock.copy(purchased = stock.purchased + (offer.id to (purchased + command.quantity.toInt()))))
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
