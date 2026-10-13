package ru.zhiv.economy

/** Species identify collection records and saved catches; only rarity classes are spendable stock.
 * Saved job promises, market escrow and ledger receipts are deliberately left unchanged. */
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

    fun state(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): EconomyState = state.copy(
        inventory = items(state.inventory, catalog),
        fishingShop = state.fishingShop?.let { shop -> shop.copy(offers = shop.offers.map { offer ->
            if (offer.kind == "fish") offer.copy(itemId = itemId(offer.itemId, catalog)) else offer
        }) },
        residentOrders = state.residentOrders.copy(slots = state.residentOrders.slots.map { slot ->
            slot.copy(terms = slot.terms?.let { it.copy(items = items(it.items, catalog)) })
        }),
    )
}
