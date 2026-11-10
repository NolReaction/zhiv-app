package ru.zhiv.economy

/** Cookbook familiarity records actual contact, independently of market obtainability. */
object EconomyFamiliarItems {
    fun project(state: EconomyState, legacyHistory: Set<String> = emptySet(),
        catalog: EconomyCatalog = EconomyRules.catalog): List<String> {
        val familiar = state.familiarItems.orEmpty().toMutableSet()
        familiar += state.inventory.filterValues { it > 0L }.keys
        familiar += EconomyFishStock.normalized(state, catalog).orEmpty().filterValues { it > 0L }.keys
        familiar += state.fishing.catches.filterValues { it > 0L }.keys
        state.fishing.escrow.orEmpty().values.forEach { familiar += it.filterValues { amount -> amount > 0L }.keys }
        if (state.familiarItems == null) {
            state.progression.recipes.filterValues { it > 0L }.keys.forEach { id ->
                catalog.recipes.find { it.id == id }?.let { recipe ->
                    familiar += recipe.cost.items.filterValues { it > 0L }.keys
                    familiar += recipe.rewards.filterValues { it > 0L }.keys
                }
            }
            state.progression.routes.filterValues { it > 0L }.keys.filterNot { it in catalog.fishing?.routeIds.orEmpty() }.forEach { id ->
                catalog.explorations.find { it.id == id }?.let { route ->
                    familiar += route.rewards.filterValues { it > 0L }.keys
                    familiar += route.loot.orEmpty().filter { it.min > 0L }.map { it.itemId }
                }
            }
            familiar += legacyHistory
        }
        return canonical(familiar, catalog)
    }

    fun persist(state: EconomyState, legacyHistory: Set<String> = emptySet(),
        catalog: EconomyCatalog = EconomyRules.catalog): EconomyState =
        state.copy(familiarItems = project(state, legacyHistory, catalog))

    /** A precise fish teaches its own identity and its class, never every class member. */
    fun canonical(items: Collection<String>, catalog: EconomyCatalog = EconomyRules.catalog): List<String> {
        val known = catalog.items.map { it.id }.toSet()
        return items.flatMap { listOf(it, EconomyFishInventory.itemId(it, catalog)) }.filter { it in known }.distinct().sorted()
    }
}
