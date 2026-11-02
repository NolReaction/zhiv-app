package ru.zhiv.economy

/** Existing lifetime counters are credited only by successful delivery. Stock is never proof of mastery. */
object EconomyRecipeUnlocks {
    fun personallyCaughtFish(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): Long =
        catalog.fishing?.fish.orEmpty().fold(0L) { total, fish ->
            minOf(ECONOMY_MAX_ITEMS, total + (state.fishing.catches[fish.itemId] ?: 0L))
        }

    fun met(state: EconomyState, recipe: EconomyRecipe, catalog: EconomyCatalog = EconomyRules.catalog): Boolean =
        (recipe.experiment == null && (state.progression.recipes[recipe.id] ?: 0L) > 0L) ||
            recipe.requiredRecipes.all { (id, amount) -> (state.progression.recipes[id] ?: 0L) >= amount } &&
            recipe.requiredExplorations.all { (id, amount) -> (state.progression.routes[id] ?: 0L) >= amount } &&
            (recipe.requiredFishCaught == 0L || personallyCaughtFish(state, catalog) >= recipe.requiredFishCaught)
}
