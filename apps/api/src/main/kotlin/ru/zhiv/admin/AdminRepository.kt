package ru.zhiv.admin

import ru.zhiv.identity.PlayerTag
import kotlinx.serialization.Serializable
import java.util.UUID

/** Public IDs select already-authenticated accounts; they are never bearer credentials. */
data class AdminConfig(val allowedPublicIds: Set<String> = emptySet())

@Serializable
data class AdminAccess(val publicId: String, val displayName: String, val serverTime: String)
@Serializable
data class AdminTotals(val users: Long, val checkIns: Long, val connections: Long, val groups: Long, val lifetimeTaps: Long)
@Serializable
data class AdminActiveUsers(val last24Hours: Long, val last7Days: Long, val last30Days: Long)
@Serializable
data class AdminRetentionRate(val eligible: Long, val returned: Long, val rate: Double?)
@Serializable
data class AdminRetention(val day1: AdminRetentionRate, val day7: AdminRetentionRate)
@Serializable
data class AdminDaily(val date: String, val registrations: Long, val activeUsers: Long, val checkIns: Long)
@Serializable
data class AdminGame(val month: String, val taps: Long, val bestSeries: Long, val participants: Long, val achievements: Long)
@Serializable
data class AdminServices(val databaseReady: Boolean, val databaseBytes: Long, val databaseConnections: Long, val activeSessions: Long)
@Serializable
data class AdminOverview(
    val serverTime: String, val days: Int, val totals: AdminTotals, val active: AdminActiveUsers,
    val newUsersPeriod: Long, val checkInsPeriod: Long, val retention: AdminRetention,
    val daily: List<AdminDaily>, val game: AdminGame, val services: AdminServices,
)
@Serializable
data class AdminUser(
    val publicId: String, val displayName: String, val createdAt: String, val lastCheckInAt: String?,
    val checkInCount: Long, val friendCount: Long, val lifetimeTaps: Long, val bestSeries: Long,
    val monthlyTaps: Long, val leaderboardOptIn: Boolean, val activeSessions: Long,
    val loginMethods: List<String>, val isAdmin: Boolean,
    val tag: PlayerTag? = null, val bannedAt: String? = null, val watchlisted: Boolean = false,
    val tapSignalAt: String? = null,
)
@Serializable
data class AdminUsers(val serverTime: String, val total: Long, val offset: Int, val limit: Int, val users: List<AdminUser>)
@Serializable
data class AdminRevokeRequest(val requestId: String, val confirmationPublicId: String, val reason: String)
@Serializable
data class AdminRevokeReceipt(val requestId: String, val affectedSessions: Int, val createdAt: String)
@Serializable
data class AdminAuditEvent(
    val requestId: String, val actorPublicId: String, val targetPublicId: String, val action: String,
    val reason: String, val affectedSessions: Int, val createdAt: String,
    val rewardId: String? = null, val granted: Boolean? = null,
    val details: String? = null,
)
@Serializable
data class AdminAudit(val serverTime: String, val total: Long, val offset: Int, val limit: Int, val events: List<AdminAuditEvent>)

@Serializable
data class AdminRewards(val publicId: String, val items: List<String>, val achievements: List<String>, val serverTime: String)
@Serializable
data class AdminGrantRequest(val requestId: String, val confirmationPublicId: String, val kind: String, val rewardId: String, val reason: String)
@Serializable
data class AdminGrantReceipt(val requestId: String, val kind: String, val rewardId: String, val granted: Boolean, val createdAt: String)

interface AdminRepository {
    suspend fun player(sessionHash: ByteArray, targetPublicId: String): AdminPlayer = throw UnsupportedOperationException()
    suspend fun managePlayer(sessionHash: ByteArray, targetPublicId: String, requestId: UUID, request: AdminPlayerCommand): AdminPlayerReceipt = throw UnsupportedOperationException()
    suspend fun tapActivity(sessionHash: ByteArray, targetPublicId: String): AdminTapActivity = throw UnsupportedOperationException()
    suspend fun rewards(sessionHash: ByteArray, targetPublicId: String): AdminRewards
    suspend fun grantReward(sessionHash: ByteArray, targetPublicId: String, requestId: UUID, request: AdminGrantRequest): AdminGrantReceipt
    suspend fun access(sessionHash: ByteArray): AdminAccess
    suspend fun overview(sessionHash: ByteArray, days: Int): AdminOverview
    suspend fun users(sessionHash: ByteArray, query: String, sort: String, offset: Int, limit: Int): AdminUsers
    suspend fun revokeSessions(sessionHash: ByteArray, targetPublicId: String, requestId: UUID, confirmationPublicId: String, reason: String): AdminRevokeReceipt
    suspend fun audit(sessionHash: ByteArray, offset: Int, limit: Int): AdminAudit
}
