package ru.zhiv.economy

import java.time.Instant

/** Hide an unfinished draw. Authoritative server time reveals the saved completed
 * catch, without changing the delivery or drawing another fish. */
object EconomyPublicJobs {
    fun project(savedJob: EconomyJob, now: Instant = Instant.now()): EconomyJob {
        // A finished expedition still has no revealed bonus until a successful claim.
        val job = savedJob.copy(expeditionFinds = null)
        val fishing = job.fishing ?: return job
        val finishesAt = runCatching { Instant.parse(job.finishesAt) }.getOrNull()
        if (finishesAt != null && !now.isBefore(finishesAt)) return job.copy(fishing = fishing.copy(catchRevealed = true))
        val fishIds = (EconomyRules.catalog.fishing?.fish?.map { it.itemId } ?: listOf("fish")).toSet() + (EconomyRules.catalog.fishing?.classes?.map { it.itemId } ?: emptyList()) + fishing.fishId
        val rewards = job.rewards.filterKeys { it !in fishIds }.toMutableMap()
        val fishCount = job.rewards.filterKeys { it in fishIds }.values.sum()
        if (fishCount > 0L) rewards["fish"] = fishCount
        return job.copy(rewards = rewards, fishing = fishing.copy(fishId = "fish", catchRevealed = null))
    }
}
