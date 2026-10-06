package ru.zhiv.game

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable private data class AchievementCatalog(val version: Int, val targets: Map<String, List<Long>>, val biomes: Map<String, List<String>>,
    val legacyRecipeIds: List<String> = emptyList())

object GameRewards {
    val items = linkedMapOf("flower" to 3L, "leaf_bed" to 7L, "keepsakes" to 14L, "leaf_garland" to 30L)
    private val catalog = Json.decodeFromString<AchievementCatalog>(checkNotNull(GameRewards::class.java
        .getResourceAsStream("/world/achievements-catalog.json")).bufferedReader().use { it.readText() })
    val tiers = catalog.targets
    val achievements = tiers.mapValues { (_, targets) -> targets.last() }
    val biomes = catalog.biomes
    val legacyRecipeIds = catalog.legacyRecipeIds.toSet()
    init { require(catalog.version == 5 && tiers.size == 15 && tiers.values.all { targets ->
        targets.isNotEmpty() && targets.size <= 4 && targets.first() > 0 && targets.zipWithNext().all { (a, b) -> a < b }
    }) }
}
