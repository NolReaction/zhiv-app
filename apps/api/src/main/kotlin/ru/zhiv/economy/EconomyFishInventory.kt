package ru.zhiv.economy

/** Species remain optional ownership metadata; rarity classes are the spendable inventory.
 * Saved job promises and ledger receipts are deliberately left unchanged. */
object EconomyFishInventory {
    fun itemId(id: String, catalog: EconomyCatalog = EconomyRules.catalog): String {
        val fishing = catalog.fishing ?: return id
        val fish = fishing.fish.find { it.itemId == id } ?: return id
        return fishing.classes.find { it.rarity == fish.rarity }?.itemId ?: id
    }

    fun items(items: Map<String, Long>, catalog: EconomyCatalog = EconomyRules.catalog): Map<String, Long> {
        val result = linkedMapOf<String, Long>()
        for ((id, quantity) in items) {
            val canonical = itemId(id, catalog)
            val current = result[canonical] ?: 0L
            if (quantity < 0L || quantity > ECONOMY_MAX_ITEMS - current)
                economyFailure("ECONOMY_CAPACITY", "Запас этого предмета достиг предела. Сначала освободите место.")
            result[canonical] = current + quantity
        }
        return result
    }

    fun state(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): EconomyState {
        val stock = state.fishing.stock?.toMutableMap()
        val legacy = catalog.fishing?.fish.orEmpty().mapNotNull { fish ->
            state.inventory[fish.itemId]?.takeIf { it > 0L }?.let { fish.itemId to it }
        }.toMap()
        // Literal old stock is ownership proof; a class count or catch book is not.
        val known = if (stock != null || legacy.isNotEmpty()) stock.orEmpty().toMutableMap().apply {
            legacy.forEach { (id, amount) ->
                val held = this[id]?.takeIf { it in 1L..ECONOMY_MAX_ITEMS } ?: 0L
                this[id] = minOf(ECONOMY_MAX_ITEMS, held + minOf(ECONOMY_MAX_ITEMS, amount))
            }
        } else null
        val canonical = state.copy(
            inventory = items(state.inventory, catalog),
            fishing = state.fishing.copy(stock = known),
            fishingShop = state.fishingShop?.let { shop -> shop.copy(offers = shop.offers.map { offer ->
                if (offer.kind == "fish") offer.copy(itemId = itemId(offer.itemId, catalog)) else offer
            }) },
            residentOrders = state.residentOrders.copy(slots = state.residentOrders.slots.map { slot ->
                slot.copy(terms = slot.terms?.let { it.copy(items = items(it.items, catalog)) })
            }),
        )
        return canonical.copy(fishing = canonical.fishing.copy(stock = EconomyFishStock.normalized(canonical, catalog)))
    }
}
