package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.sqrt

private const val MAX_PLAYER_PROGRESS = 1_000_000_000_000L
private const val DISPLAY_PEARL_UNITS = 2L
@Serializable data class EconomyPlayerLastAward(val xp: Long, val source: String, val at: String) {
    init { require(xp in 0..MAX_PLAYER_PROGRESS && source in setOf("construction", "production", "exploration", "order", "ship")); Instant.parse(at) }
}
@Serializable data class EconomyCooperationSeason(val id: String = "", val points: Long = 0, val awardedMilestones: List<Long> = emptyList()) {
    init { require(id.isEmpty() || id.matches(Regex("[0-9]{4}-[0-9]{2}"))); require(points in 0..MAX_PLAYER_PROGRESS && awardedMilestones.size <= 10 && awardedMilestones.all { it > 0 }) }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyPlayerProgress(
    val version: Int = 1, val xp: Long = 0, val workSeconds: Long = 0,
    val awardedLevels: List<Int> = emptyList(), val badges: List<String> = emptyList(), val pendingPearls: Long = 0,
    val season: EconomyCooperationSeason = EconomyCooperationSeason(),
    @EncodeDefault(EncodeDefault.Mode.NEVER) val lastAward: EconomyPlayerLastAward? = null,
) {
    init {
        require(version == 1 && xp in 0..MAX_PLAYER_PROGRESS && workSeconds in 0..MAX_PLAYER_PROGRESS && pendingPearls in 0..MAX_PLAYER_PROGRESS)
        require(awardedLevels.size <= 100 && awardedLevels.all { it in 1..100 })
        require(badges.size <= 1200 && badges.all { it.length <= 60 })
    }
}
@Serializable private data class PlayerLevelReward(val level: Int, val rewardPearls: Long)
@Serializable private data class CooperationMilestone(val points: Long, val rewardPearls: Long, val badge: String, val title: String)
@Serializable private data class CooperationBonuses(
    val orderPoints: Long = 0, val weeklyStagePoints: Long = 0, val shipCargoPoints: Long = 0, val shipVoyagePoints: Long = 0,
)
@Serializable private data class CooperationMonth(val month: Int, val title: String, val description: String, val bonuses: CooperationBonuses)
@Serializable private data class CooperationCatalog(
    val orderPoints: Long, val weeklyStagePoints: Long, val shipCargoPoints: Long, val shipVoyagePoints: Long,
    val months: List<CooperationMonth>, val milestones: List<CooperationMilestone>,
)
@Serializable private data class PlayerProgressionCatalog(
    val version: Int, val maxLevel: Int, val levelXpFactor: Long, val workSecondsPerXp: Long,
    val constructionXpPerLevel: Long, val firstRecipeXp: Long, val firstExplorationXp: Long,
    val orderXp: Long, val weeklyStageXp: Long, val stageOrderXp: Long, val shipCargoXp: Long, val shipVoyageXp: Long,
    val levelTitles: List<String>, val levelRewards: List<PlayerLevelReward>, val season: CooperationCatalog,
)
/** Uses the same completed-action rewards and UTC season catalogue as the local implementation. */
object EconomyPlayerProgression {
    private val config: PlayerProgressionCatalog = economyJson.decodeFromString(
        checkNotNull(EconomyPlayerProgression::class.java.getResourceAsStream("/world/player-progression-catalog.json"))
            .bufferedReader().use { it.readText() })
    init {
        require(config.version == 1 && config.maxLevel == 100 && config.levelXpFactor > 0 && config.workSecondsPerXp > 0)
        require(config.levelRewards.map { it.level }.distinct().size == config.levelRewards.size && config.levelRewards.all { it.level in 1..100 && it.rewardPearls >= 0 })
        require(config.season.months.map { it.month } == (1..12).toList())
        require(config.season.months.all { it.title.isNotBlank() && it.description.isNotBlank() &&
            it.bonuses.orderPoints in 0..5 && it.bonuses.weeklyStagePoints in 0..10 &&
            it.bonuses.shipCargoPoints in 0..5 && it.bonuses.shipVoyagePoints in 0..15 })
        require(config.season.milestones.all { it.points > 0 && it.rewardPearls >= 0 } &&
            config.season.milestones.zipWithNext().all { (a, b) -> a.points < b.points })
    }
    private fun add(a: Long, b: Long): Long = minOf(MAX_PLAYER_PROGRESS, a + maxOf(0, b))
    fun level(xp: Long): Int = (sqrt(maxOf(0, xp).toDouble() / config.levelXpFactor).toInt() + 1).coerceIn(1, config.maxLevel)
    private fun seasonId(now: Instant): String = now.atZone(ZoneOffset.UTC).let { "%04d-%02d".format(java.util.Locale.ROOT, it.year, it.monthValue) }
    private fun quantity(job: EconomyJob, recipe: EconomyRecipe): Long = recipe.rewards.filterValues { it > 0 }
        .minOfOrNull { (id, count) -> (job.rewards[id] ?: 0L) / count } ?: 0L

    /** Execute once inside the successful command's existing database transaction. */
    fun award(before: EconomyState, state: EconomyState, command: EconomyCommand, now: Instant): EconomyState {
        val original = state.progression.player
        var player = original ?: EconomyPlayerProgress()
        val id = seasonId(now)
        val bonuses = config.season.months[now.atZone(ZoneOffset.UTC).monthValue - 1].bonuses
        if (player.season.id != id) player = player.copy(season = EconomyCooperationSeason(id))
        var xp = 0L; var seconds = 0L; var points = 0L; var source = "production"
        val recipes = mutableSetOf<String>()
        if (command.action in setOf("claim_job", "claim_production", "claim_garden_collection")) before.jobs.forEach { job ->
            val removed = state.jobs.none { it.id == job.id }
            if (job.kind == "construction" && removed && (state.buildings[job.targetId] ?: 0) > (before.buildings[job.targetId] ?: 0)) {
                xp += config.constructionXpPerLevel * (job.targetLevel ?: 1); source = "construction"
            } else if (job.kind == "production" && removed) {
                val recipe = EconomyRules.catalog.recipes.find { it.id == job.recipeId } ?: return@forEach
                seconds += recipe.seconds * quantity(job, recipe)
                if ((before.progression.recipes[recipe.id] ?: 0) == 0L) recipes.add(recipe.id)
                source = "production"
            } else if (job.kind == "exploration") {
                val route = EconomyRules.catalog.explorations.find { it.id == job.targetId } ?: return@forEach
                val completed = maxOf(0, (state.progression.routes[job.targetId] ?: 0) - (before.progression.routes[job.targetId] ?: 0))
                if (completed == 0L) return@forEach
                seconds += route.seconds * completed
                if ((before.progression.routes[route.id] ?: 0) == 0L) xp += config.firstExplorationXp
                source = "exploration"
            }
        }
        xp += recipes.size * config.firstRecipeXp
        if (command.action == "complete_resident_order") {
            val weekly = command.targetId.startsWith("weekly1_")
            xp += if (weekly) config.weeklyStageXp else if (command.targetId.startsWith("stage")) config.stageOrderXp else config.orderXp
            points += if (weekly) config.season.weeklyStagePoints + bonuses.weeklyStagePoints else config.season.orderPoints + bonuses.orderPoints
            source = "order"
        }
        if (command.action in setOf("load_ship_cargo", "complete_ship_order", "claim_ship_voyage")) {
            val completed = maxOf(0, state.ship.completedVoyages - before.ship.completedVoyages)
            val cargo = before.ship.voyage?.orders?.count { order -> order.deliveredAt == null &&
                (completed > 0 || state.ship.voyage?.orders?.any { it.id == order.id && it.deliveredAt != null } == true) } ?: 0
            xp += cargo * config.shipCargoXp + completed * config.shipVoyageXp
            points += cargo * (config.season.shipCargoPoints + bonuses.shipCargoPoints) + completed * (config.season.shipVoyagePoints + bonuses.shipVoyagePoints)
            source = "ship"
        }
        val work = add(player.workSeconds, seconds)
        xp += work / config.workSecondsPerXp - player.workSeconds / config.workSecondsPerXp
        player = player.copy(xp = add(player.xp, xp), workSeconds = work,
            lastAward = if (xp > 0) EconomyPlayerLastAward(xp, source, now.toString()) else player.lastAward,
            season = player.season.copy(points = add(player.season.points, points)))
        val levels = player.awardedLevels.toMutableSet(); val milestones = player.season.awardedMilestones.toMutableSet()
        val badges = player.badges.toMutableSet(); var pending = player.pendingPearls
        config.levelRewards.forEach { reward -> if (level(player.xp) >= reward.level && levels.add(reward.level))
            pending = add(pending, reward.rewardPearls * DISPLAY_PEARL_UNITS) }
        config.season.milestones.forEach { reward -> if (player.season.points >= reward.points && milestones.add(reward.points)) {
            // Permanent history is also a receipt if an older monthly snapshot is restored.
            if (badges.add("$id:${reward.badge}")) pending = add(pending, reward.rewardPearls * DISPLAY_PEARL_UNITS)
        } }
        val delivered = minOf(pending, maxOf(0, ECONOMY_MAX_PEARLS - state.wallet.pearls))
        player = player.copy(awardedLevels = levels.toList(), badges = badges.toList().takeLast(1200), pendingPearls = pending - delivered,
            season = player.season.copy(awardedMilestones = milestones.toList()))
        return if (xp > 0 || points > 0 || delivered > 0 || original != null) state.copy(
            wallet = state.wallet.copy(pearls = state.wallet.pearls + delivered), progression = state.progression.copy(player = player)) else state
    }

    /** Merging identities never duplicates one-time progression rewards. */
    fun merge(first: EconomyPlayerProgress?, second: EconomyPlayerProgress?): EconomyPlayerProgress? {
        if (first == null && second == null) return null
        val a = first ?: EconomyPlayerProgress(); val b = second ?: EconomyPlayerProgress()
        val selected = if (a.xp >= b.xp) a else b
        val season = when {
            a.season.id > b.season.id -> a.season
            a.season.id < b.season.id -> b.season
            else -> EconomyCooperationSeason(a.season.id, maxOf(a.season.points, b.season.points),
                (a.season.awardedMilestones + b.season.awardedMilestones).distinct().sorted())
        }
        return selected.copy(workSeconds = maxOf(a.workSeconds, b.workSeconds),
            awardedLevels = (a.awardedLevels + b.awardedLevels).distinct().sorted(), badges = (a.badges + b.badges).distinct().sorted().takeLast(1200),
            pendingPearls = add(a.pendingPearls, b.pendingPearls), season = season)
    }
}
