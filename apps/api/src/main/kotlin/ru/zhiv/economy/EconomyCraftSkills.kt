package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import java.security.SecureRandom
import java.time.Instant

private const val MAX_SKILL_SECONDS = 31_536_000L
@Serializable data class EconomySkillLevel(val requiredSeconds: Long, val cookingBonusBps: Int, val travelSpeedBps: Int) {
    init { require(requiredSeconds in 0..MAX_SKILL_SECONDS && cookingBonusBps in 0..1000 && travelSpeedBps in 0..500) }
}
@Serializable data class EconomySkillsCatalog(val version: Int = 1, val levels: List<EconomySkillLevel>) {
    init { require(version == 1 && levels.size == 10 && levels.first().requiredSeconds == 0L)
        require(levels.zipWithNext().all { (a,b) -> b.requiredSeconds > a.requiredSeconds && b.cookingBonusBps >= a.cookingBonusBps && b.travelSpeedBps >= a.travelSpeedBps }) }
}
@Serializable data class EconomyCookingResult(val jobId: String, val recipeId: String, val successful: Boolean, val at: String) {
    init { require(jobId.isNotBlank() && recipeId.isNotBlank()); Instant.parse(at) }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyCraftSkills(val version: Int = 1, val cookingSeconds: Long = 0, val travelSeconds: Long = 0,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val lastCooking: EconomyCookingResult? = null) {
    init { require(version == 1 && cookingSeconds in 0..MAX_SKILL_SECONDS && travelSeconds in 0..MAX_SKILL_SECONDS) }
}
@Serializable data class EconomyCookingExperiment(val title: String, val hint: String, val successBps: Int,
    val requiredCookingLevel: Int, val failureRewards: Map<String, Long>) {
    init { require(title.isNotBlank() && title.length <= 80 && hint.isNotBlank() && hint.length <= 240)
        require(successBps in 5000..9500 && requiredCookingLevel in 1..10 && failureRewards.size == 1 && failureRewards.values.single() == 1L) }
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyCookingAttempt(val successChanceBps: Int, val workSeconds: Long,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val successful: Boolean? = null) {
    init { require(successChanceBps in 1..10000 && workSeconds in 1..MAX_SKILL_SECONDS) }
}

object EconomySkills {
    private val entropy = SecureRandom()
    fun level(state: EconomyState, skill: String, catalog: EconomyCatalog = EconomyRules.catalog): Int {
        val seconds = if (skill == "cooking") state.progression.skills?.cookingSeconds ?: 0 else state.progression.skills?.travelSeconds ?: 0
        return (catalog.skills?.levels?.indexOfLast { seconds >= it.requiredSeconds } ?: 0).coerceAtLeast(0) + 1
    }
    fun bonus(state: EconomyState, skill: String, catalog: EconomyCatalog = EconomyRules.catalog): Int {
        val row = catalog.skills?.levels?.get(level(state, skill, catalog) - 1) ?: return 0
        return if (skill == "cooking") row.cookingBonusBps else row.travelSpeedBps
    }
    fun canPractice(state: EconomyState, recipe: EconomyRecipe) = recipe.experiment?.let { level(state, "cooking") >= it.requiredCookingLevel } ?: true
    fun chance(state: EconomyState, recipe: EconomyRecipe): Int = recipe.experiment?.let { minOf(9500, it.successBps + bonus(state, "cooking")) } ?: 10000
    fun prepare(state: EconomyState, recipe: EconomyRecipe, draw: (Int) -> Int = entropy::nextInt): EconomyCookingAttempt? {
        if (recipe.experiment == null) return null
        val ticket = draw(10000); require(ticket in 0..9999)
        val chance = chance(state, recipe)
        return EconomyCookingAttempt(chance, recipe.seconds, ticket < chance)
    }
    fun merge(a: EconomyCraftSkills?, b: EconomyCraftSkills?): EconomyCraftSkills? = if (a == null && b == null) null else
        EconomyCraftSkills(cookingSeconds = maxOf(a?.cookingSeconds ?: 0, b?.cookingSeconds ?: 0), travelSeconds = maxOf(a?.travelSeconds ?: 0, b?.travelSeconds ?: 0))
    fun award(before: EconomyState, state: EconomyState, command: EconomyCommand, now: Instant): EconomyState {
        if (command.action !in setOf("claim_job", "claim_production", "claim_garden_collection")) return state
        var skills = state.progression.skills ?: EconomyCraftSkills()
        var trained = false
        before.jobs.filter { job -> state.jobs.none { it.id == job.id } }.forEach { job ->
            val cooking = job.kind == "production" && job.targetId == "dryer"
            val travel = job.kind == "exploration" && job.actorId != "miner" && !job.targetId.startsWith("quarry_")
            if (!cooking && !travel) return@forEach
            val recipe = if (cooking) EconomyRules.catalog.recipes.find { it.id == job.recipeId } else null
            val legacyBatches = recipe?.rewards?.filterValues { it > 0 }?.map { (id, amount) -> (job.rewards[id] ?: 0) / amount }?.minOrNull()?.coerceAtLeast(1) ?: 1
            val seconds = job.skillWorkSeconds ?: job.cooking?.workSeconds ?: if (recipe != null) recipe.seconds * legacyBatches else
                EconomyRules.catalog.explorations.find { it.id == job.targetId }?.seconds ?: 0
            if (seconds <= 0) return@forEach
            skills = if (cooking) skills.copy(cookingSeconds = minOf(MAX_SKILL_SECONDS, skills.cookingSeconds + seconds))
                else skills.copy(travelSeconds = minOf(MAX_SKILL_SECONDS, skills.travelSeconds + seconds))
            if (job.cooking?.successful != null && job.recipeId != null)
                skills = skills.copy(lastCooking = EconomyCookingResult(job.id, job.recipeId, job.cooking.successful, now.toString()))
            trained = true
        }
        return if (trained) state.copy(progression = state.progression.copy(skills = skills)) else state
    }
}
