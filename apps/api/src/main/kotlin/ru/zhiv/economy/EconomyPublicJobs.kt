package ru.zhiv.economy

/** Keep the saved draw private until claim: previewing species and cancelling
 * would otherwise let players probe specializations against the same seed. */
object EconomyPublicJobs {
    fun project(job: EconomyJob): EconomyJob {
        val fishing = job.fishing ?: return job
        val fishIds = (EconomyRules.catalog.fishing?.fish?.map { it.itemId } ?: listOf("fish")).toSet() + fishing.fishId
        val rewards = job.rewards.filterKeys { it !in fishIds }.toMutableMap()
        val fishCount = job.rewards.filterKeys { it in fishIds }.values.sum()
        if (fishCount > 0L) rewards["fish"] = fishCount
        return job.copy(rewards = rewards, fishing = fishing.copy(fishId = "fish"))
    }
}
