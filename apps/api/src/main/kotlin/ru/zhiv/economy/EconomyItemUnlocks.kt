package ru.zhiv.economy

/** Knowledge survives spent inventory and temporary loss of a source. Gifts are not knowledge for new players. */
object EconomyItemUnlocks {
    fun project(state: EconomyState, legacyHistory: Set<String> = emptySet(),
        catalog: EconomyCatalog = EconomyRules.catalog): List<String> {
        val known = catalog.items.map { it.id }.toSet()
        val discovered = state.unlockedItems.toMutableSet()
        discovered += EconomyFood.obtainableOrderItems(state, catalog)
        state.progression.recipes.filterValues { it > 0 }.keys.forEach { id ->
            catalog.recipes.find { it.id == id }?.rewards?.filterValues { it > 0 }?.keys?.let { discovered += it }
        }
        state.progression.routes.filterValues { it > 0 }.keys.forEach { id ->
            catalog.explorations.find { it.id == id }?.rewards?.filterValues { it > 0 }?.keys?.let { discovered += it }
        }
        discovered += state.fishing.catches.filterValues { it > 0 }.keys
        if (state.itemUnlockVersion == 0) {
            discovered += state.inventory.filterValues { it > 0 }.keys
            discovered += legacyHistory
        }
        return canonical(discovered, known, catalog)
    }

    fun persist(state: EconomyState, legacyHistory: Set<String> = emptySet(),
        catalog: EconomyCatalog = EconomyRules.catalog): EconomyState =
        state.copy(unlockedItems = project(state, legacyHistory, catalog), itemUnlockVersion = 1)

    /** Delivery trusts the paid job snapshot even when its source was retired or relocked. */
    fun delivered(state: EconomyState, rewards: Map<String, Long>, catalog: EconomyCatalog = EconomyRules.catalog): EconomyState =
        state.copy(unlockedItems = canonical(state.unlockedItems + rewards.filterValues { it > 0 }.keys,
            catalog.items.map { it.id }.toSet(), catalog))

    private fun canonical(items: Collection<String>, known: Set<String>, catalog: EconomyCatalog): List<String> =
        items.map { EconomyFishInventory.itemId(it, catalog) }.filter { it in known }.distinct().sorted()
}
