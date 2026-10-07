package ru.zhiv.game

import ru.zhiv.economy.EconomyState
import ru.zhiv.economy.EconomyRules
import ru.zhiv.economy.EconomyCollectionProgress

/** Completed-job counters and personal catches, rather than purchasable inventory. */
internal fun economyAchievementProgress(state: EconomyState?, confirmedSale: Boolean = false,
    inheritedFinds: List<String> = emptyList()): Map<String, Long> {
    val routes = state?.progression?.routes.orEmpty()
    return linkedMapOf(
        "first_path" to (state?.completedExplorations ?: 0L),
        "familiar_trails" to GameRewards.biomes.values.count { ids -> ids.any { (routes[it] ?: 0L) > 0L } }.toLong(),
        "explorer" to (state?.completedExplorations ?: 0L),
        "master_recipes" to (EconomyRules.catalog.recipes.map { it.id }.toSet() + GameRewards.legacyRecipeIds)
            .count { (state?.progression?.recipes?.get(it) ?: 0L) > 0L }.toLong(),
        "home_builder" to (state?.buildings?.get("home") ?: 1).toLong(),
        "river_atlas" to EconomyRules.catalog.fishing?.fish.orEmpty().count { (state?.fishing?.catches?.get(it.itemId) ?: 0L) > 0L }.toLong(),
        "first_sale" to if (confirmedSale) 1L else 0L,
        "lucky_find" to if (state != null && EconomyCollectionProgress.personallyFound(state.progression.collections, inheritedFinds)) 1L else 0L,
    )
}

internal fun achievementWithTiers(id: String, progress: Long, dates: Map<Int, String>): GameAchievement {
    val targets = GameRewards.tiers.getValue(id)
    val earnedFloor = targets.filterIndexed { index, _ -> dates.containsKey(index + 1) }.lastOrNull() ?: 0L
    val tiers = targets.mapIndexed { index, target ->
        val date = dates[index + 1]
        GameAchievementTier(index + 1, if (date != null) target else maxOf(progress, earnedFloor).coerceIn(0L, target), target, date)
    }
    val current = tiers.firstOrNull { it.unlockedAt == null } ?: tiers.last()
    return GameAchievement(id, current.progress, current.target, tiers.first().unlockedAt, tiers)
}
