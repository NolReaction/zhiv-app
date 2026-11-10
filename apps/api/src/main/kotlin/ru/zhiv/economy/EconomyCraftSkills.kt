package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import java.security.SecureRandom
import java.time.Instant

private const val MAX_SKILL_SECONDS = 31_536_000L
@Serializable data class EconomySkillLevel(val requiredSeconds: Long, val cookingBonusBps: Int, val travelSpeedBps: Int, val workSpeedBps: Int = 0) {
    init { require(requiredSeconds in 0..MAX_SKILL_SECONDS && cookingBonusBps in 0..1000 && travelSpeedBps in 0..500 && workSpeedBps in 0..300) }
}
@Serializable data class EconomySkillsCatalog(val version: Int = 1, val levels: List<EconomySkillLevel>, val buildingPracticeDivisor: Int = 1) {
    init { require(buildingPracticeDivisor in 1..8)
        require(version == 1 && levels.size == 10 && levels.first().requiredSeconds == 0L)
        require(levels.zipWithNext().all { (a,b) -> b.requiredSeconds > a.requiredSeconds && b.cookingBonusBps >= a.cookingBonusBps && b.travelSpeedBps >= a.travelSpeedBps && b.workSpeedBps >= a.workSpeedBps }) }
}
@Serializable data class EconomyCookingResult(val jobId: String, val recipeId: String, val successful: Boolean, val at: String) {
    init { require(jobId.isNotBlank() && recipeId.isNotBlank()); Instant.parse(at) }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyCraftSkills(val version: Int = 1, val cookingSeconds: Long = 0, val travelSeconds: Long = 0,
    val fishingSeconds: Long = 0, val craftingSeconds: Long = 0, val smeltingSeconds: Long = 0, val gatheringSeconds: Long = 0, val forestrySeconds: Long = 0, val miningSeconds: Long = 0, val buildingSeconds: Long = 0,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val buildingHistoryVersion: Int? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val lastCooking: EconomyCookingResult? = null) {
    init { require(buildingHistoryVersion == null || buildingHistoryVersion == 1)
        require(version == 1 && cookingSeconds in 0..MAX_SKILL_SECONDS && travelSeconds in 0..MAX_SKILL_SECONDS &&
        fishingSeconds in 0..MAX_SKILL_SECONDS && craftingSeconds in 0..MAX_SKILL_SECONDS && smeltingSeconds in 0..MAX_SKILL_SECONDS && gatheringSeconds in 0..MAX_SKILL_SECONDS && forestrySeconds in 0..MAX_SKILL_SECONDS && miningSeconds in 0..MAX_SKILL_SECONDS && buildingSeconds in 0..MAX_SKILL_SECONDS) }
}
@Serializable data class EconomyCookingExperiment(val title: String, val hint: String, val successBps: Int,
    val requiredCookingLevel: Int, val failureRewards: Map<String, Long>, val initialFire: Boolean = false) {
    init { require(title.isNotBlank() && title.length <= 80 && hint.isNotBlank() && hint.length <= 240)
        require(successBps in 5000..9500 && requiredCookingLevel in 1..10 && failureRewards.size <= 1 && failureRewards.values.all { it == 1L }) }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyCookingAttempt(val successChanceBps: Int, val workSeconds: Long,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val successful: Boolean? = null) {
    init { require(successChanceBps in 1..10000 && workSeconds in 1..MAX_SKILL_SECONDS) }
}

object EconomySkills {
    val ids = listOf("cooking", "travel", "fishing", "crafting", "smelting", "gathering", "forestry", "mining", "building")
    private val entropy = SecureRandom()
    fun initial() = EconomyCraftSkills(buildingHistoryVersion = 1)
    /** Pure projection; only owned levels establish old completed work, never pending jobs. */
    fun normalized(state: EconomyState, catalog: EconomyCatalog = EconomyRules.catalog): EconomyState {
        val saved = state.progression.skills ?: EconomyCraftSkills()
        if (saved.buildingHistoryVersion == 1) return state
        val historical = catalog.buildings.sumOf { building -> building.levels.filter { level ->
            level.level <= (state.buildings[building.id] ?: 0) && !(level.level == 1 &&
                (building.id in setOf("home", "garden", "warehouse") || building.id == "workshop" && state.workshopStarterClaimed))
        }.sumOf { it.seconds } }
        val skills = saved.copy(buildingHistoryVersion = 1, buildingSeconds = minOf(MAX_SKILL_SECONDS, maxOf(saved.buildingSeconds, historical)))
        return state.copy(progression = state.progression.copy(skills = skills))
    }
    fun seconds(skills: EconomyCraftSkills?, skill: String): Long = when (skill) {
        "cooking" -> skills?.cookingSeconds ?: 0
        "travel" -> skills?.travelSeconds ?: 0
        "fishing" -> skills?.fishingSeconds ?: 0
        "crafting" -> skills?.craftingSeconds ?: 0
        "smelting" -> skills?.smeltingSeconds ?: 0
        "gathering" -> skills?.gatheringSeconds ?: 0
        "forestry" -> skills?.forestrySeconds ?: 0
        "mining" -> skills?.miningSeconds ?: 0
        "building" -> skills?.buildingSeconds ?: 0
        else -> error("Unknown craft skill: $skill")
    }
    private fun withSeconds(skills: EconomyCraftSkills, skill: String, seconds: Long) = when (skill) {
        "cooking" -> skills.copy(cookingSeconds = seconds)
        "travel" -> skills.copy(travelSeconds = seconds)
        "fishing" -> skills.copy(fishingSeconds = seconds)
        "crafting" -> skills.copy(craftingSeconds = seconds)
        "smelting" -> skills.copy(smeltingSeconds = seconds)
        "gathering" -> skills.copy(gatheringSeconds = seconds)
        "forestry" -> skills.copy(forestrySeconds = seconds)
        "mining" -> skills.copy(miningSeconds = seconds)
        "building" -> skills.copy(buildingSeconds = seconds)
        else -> error("Unknown craft skill: $skill")
    }
    fun level(state: EconomyState, skill: String, catalog: EconomyCatalog = EconomyRules.catalog): Int {
        val seconds = seconds(if (skill == "building") normalized(state, catalog).progression.skills else state.progression.skills, skill)
        val divisor = if (skill == "building") catalog.skills?.buildingPracticeDivisor ?: 1 else 1
        return (catalog.skills?.levels?.indexOfLast { seconds >= (it.requiredSeconds + divisor - 1) / divisor } ?: 0).coerceAtLeast(0) + 1
    }
    fun bonus(state: EconomyState, skill: String, catalog: EconomyCatalog = EconomyRules.catalog): Int {
        val row = catalog.skills?.levels?.get(level(state, skill, catalog) - 1) ?: return 0
        return if (skill == "cooking") row.cookingBonusBps else if (skill == "travel") row.travelSpeedBps else row.workSpeedBps
    }
    fun canPractice(state: EconomyState, recipe: EconomyRecipe) = recipe.experiment?.let { level(state, "cooking") >= it.requiredCookingLevel } ?: true
    fun chance(state: EconomyState, recipe: EconomyRecipe): Int = recipe.experiment?.let { minOf(9500, it.successBps + bonus(state, "cooking")) } ?: 10000
    fun prepare(state: EconomyState, recipe: EconomyRecipe, draw: (Int) -> Int = entropy::nextInt): EconomyCookingAttempt? {
        if (recipe.experiment == null) return null
        val ticket = draw(10000); require(ticket in 0..9999)
        val chance = chance(state, recipe)
        return EconomyCookingAttempt(chance, recipe.seconds, ticket < chance)
    }
    fun production(buildingId: String): String? = when (buildingId) {
        "dryer" -> "cooking"; "workshop" -> "crafting"; "kiln" -> "smelting"; "garden" -> "gathering"; "woodlot" -> "forestry"; else -> null
    }
    fun exploration(route: EconomyExploration, catalog: EconomyCatalog = EconomyRules.catalog): String =
        if (route.activity == "mining" || route.id.startsWith("quarry_")) "mining" else if (catalog.fishing?.routeIds?.contains(route.id) == true) "fishing" else "travel"
    fun workDuration(state: EconomyState, skill: String?, seconds: Long): Long {
        val speed = if (skill == null || skill == "cooking") 0 else bonus(state, skill)
        return (seconds * 10000L + 10000 + speed - 1) / (10000 + speed)
    }
    fun merge(a: EconomyCraftSkills?, b: EconomyCraftSkills?): EconomyCraftSkills? = if (a == null && b == null) null else
        ids.fold(EconomyCraftSkills(buildingHistoryVersion = if ((a == null || a.buildingHistoryVersion == 1) && (b == null || b.buildingHistoryVersion == 1)) 1 else null)) { skills, id -> withSeconds(skills, id, maxOf(seconds(a, id), seconds(b, id))) }

    fun award(before: EconomyState, state: EconomyState, command: EconomyCommand, now: Instant): EconomyState {
        if (command.action in setOf("claim_boat", "sell_boat_catch")) {
            val work = EconomyBoats.claimPracticeSeconds(before.boat, state.boat, command.action)
            val skills = state.progression.skills ?: EconomyCraftSkills()
            return if (work <= 0L) state else state.copy(progression = state.progression.copy(skills = skills.copy(
                fishingSeconds = minOf(MAX_SKILL_SECONDS, skills.fishingSeconds + work))))
        }
        if (command.action !in setOf("claim_job", "claim_production", "claim_garden_collection", "claim_mining_batch", "speedup_construction")) return state
        var skills = state.progression.skills ?: EconomyCraftSkills()
        var trained = false
        before.jobs.forEach { job ->
            if (command.action == "speedup_construction" && job.kind != "construction") return@forEach
            val remaining = state.jobs.find { it.id == job.id }
            val units = job.miningBatch?.let { (remaining?.miningBatch?.claimed ?: it.quantity) - it.claimed } ?: if (remaining == null) 1 else 0
            if (units <= 0) return@forEach
            val recipe = if (job.kind == "production") EconomyRules.catalog.recipes.find { it.id == job.recipeId } else null
            val route = if (job.kind == "exploration") EconomyRules.catalog.explorations.find { it.id == job.targetId } else null
            val skill = if (job.kind == "construction") "building" else recipe?.let { production(it.buildingId) } ?: route?.let { exploration(it) } ?: return@forEach
            val legacyBatches = recipe?.rewards?.filterValues { it > 0 }?.map { (id, amount) -> (job.rewards[id] ?: 0) / amount }?.minOrNull()?.coerceAtLeast(1) ?: 1
            val construction = if (job.kind == "construction") EconomyRules.catalog.buildings.find { it.id == job.targetId }?.levels?.find { it.level == job.targetLevel } else null
            val legacyTutorial = recipe != null && java.time.Duration.between(Instant.parse(job.startedAt), Instant.parse(job.finishesAt)).toMillis() < 1000 ||
                construction != null && job.cost.coins == 0L && job.cost.items.isEmpty()
            val work = (job.skillWorkSeconds ?: job.cooking?.workSeconds ?: if (legacyTutorial) 0 else if (recipe != null) recipe.seconds * legacyBatches else route?.seconds ?: construction?.seconds ?: 0) * units
            if (work <= 0) return@forEach
            skills = withSeconds(skills, skill, minOf(MAX_SKILL_SECONDS, seconds(skills, skill) + work))
            if (job.cooking?.successful != null && job.recipeId != null)
                skills = skills.copy(lastCooking = EconomyCookingResult(job.id, job.recipeId, job.cooking.successful, now.toString()))
            trained = true
        }
        return if (trained) state.copy(progression = state.progression.copy(skills = skills)) else state
    }
}
