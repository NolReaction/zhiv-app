package ru.zhiv.admin

import kotlinx.serialization.Serializable
import ru.zhiv.economy.EconomyJob
import ru.zhiv.economy.EconomyStorage
import ru.zhiv.economy.EconomyView
import java.time.Instant

@Serializable data class AdminEconomySummary(
    val players: Long, val initializedPlayers: Long, val uninitializedPlayers: Long,
    val coins: Long, val pearls: Long, val runningJobs: Long, val readyJobs: Long,
    val storageBlockedPlayers: Long, val overflowPlayers: Long, val updatedLast24Hours: Long,
)
@Serializable data class AdminEconomyPlayer(
    val publicId: String, val displayName: String, val initialized: Boolean,
    val updatedAt: String?, val revision: Long?, val coins: Long?, val pearls: Long?,
    val homeLevel: Int?, val completedExplorations: Long?, val storage: EconomyStorage?,
    val runningJobs: Long, val readyJobs: Long, val awaitingCollectionJobs: Long, val blockedReadyJobs: Long,
)
@Serializable data class AdminEconomy(
    val serverTime: String, val total: Long, val offset: Int, val limit: Int,
    val summary: AdminEconomySummary, val players: List<AdminEconomyPlayer>,
)
@Serializable data class AdminEconomyJobStatus(val jobId: String, val status: String, val storageBlocked: Boolean)
@Serializable data class AdminEconomyLedger(
    val kind: String, val coins: Long, val pearls: Long, val items: Map<String, Long>, val createdAt: String,
)
@Serializable data class AdminEconomyDetail(
    val publicId: String, val displayName: String, val serverTime: String, val updatedAt: String?,
    val economy: EconomyView?, val jobStatuses: List<AdminEconomyJobStatus>, val ledger: List<AdminEconomyLedger>,
)

/** Read-only observations use the same deadlines as claim_job, including berry collection. */
object AdminEconomyObservations {
    fun jobStatus(job: EconomyJob, storage: EconomyStorage, now: Instant): AdminEconomyJobStatus {
        val status = when {
            now.isBefore(Instant.parse(job.finishesAt)) -> "running"
            job.collection != null && job.collection.startedAt == null -> "awaiting_collection"
            job.collection?.finishesAt != null && now.isBefore(Instant.parse(job.collection.finishesAt)) -> "collecting"
            else -> "ready"
        }
        return AdminEconomyJobStatus(job.id, status,
            status == "ready" && job.rewards.values.sum() > storage.available)
    }
}
