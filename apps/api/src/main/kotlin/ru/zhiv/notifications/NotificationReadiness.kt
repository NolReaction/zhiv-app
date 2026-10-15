package ru.zhiv.notifications

import ru.zhiv.economy.EconomyJob
import ru.zhiv.economy.EconomyRules
import java.time.Instant

internal data class NotificationJobReadiness(
    val dueAt: Instant,
    val phase: String? = null,
    val blockedUntil: Instant? = null,
)

/** Mirrors the actor rules for start_collection without starting or claiming a
 * job. A returned trip no longer owns the berry collector; an unclaimed berry
 * collection and a legacy world journey still do. Cosmetic walks are irrelevant. */
internal fun notificationJobReadiness(
    job: EconomyJob,
    jobs: List<EconomyJob>,
    hasLegacyJourney: Boolean,
    now: Instant,
): NotificationJobReadiness {
    val finishesAt = Instant.parse(job.finishesAt)
    val collection = job.collection
    if (collection == null) return NotificationJobReadiness(finishesAt)
    collection.finishesAt?.let {
        return NotificationJobReadiness(maxOf(finishesAt, Instant.parse(it)), phase = "collected")
    }
    val actorFinishesAt = jobs.asSequence().filter {
        it.kind == "exploration" && !EconomyRules.isMinerJob(it) || it.kind == "production" && it.targetId == "quarry"
    }.map { Instant.parse(it.finishesAt) }.maxOrNull()
    val dueAt = maxOf(finishesAt, actorFinishesAt ?: finishesAt)
    val otherCollection = jobs.filter { it.id != job.id && it.collection?.startedAt != null }
    // A completed collection remains busy until claim. Recheck it periodically;
    // waiting neither reserves a push batch nor spends a transport attempt.
    val blockedUntil = if (hasLegacyJourney || otherCollection.isNotEmpty()) {
        maxOf(now.plusSeconds(300), otherCollection.mapNotNull { it.collection?.finishesAt }
            .map(Instant::parse).maxOrNull() ?: now)
    } else null
    return NotificationJobReadiness(dueAt, phase = "harvest", blockedUntil = blockedUntil)
}
