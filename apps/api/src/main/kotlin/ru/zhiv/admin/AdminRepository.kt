package ru.zhiv.admin

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
)
@Serializable
data class AdminAudit(val serverTime: String, val total: Long, val offset: Int, val limit: Int, val events: List<AdminAuditEvent>)

interface AdminRepository {
    suspend fun access(sessionHash: ByteArray): AdminAccess
    suspend fun overview(sessionHash: ByteArray, days: Int): AdminOverview
    suspend fun users(sessionHash: ByteArray, query: String, sort: String, offset: Int, limit: Int): AdminUsers
    suspend fun revokeSessions(sessionHash: ByteArray, targetPublicId: String, requestId: UUID, confirmationPublicId: String, reason: String): AdminRevokeReceipt
    suspend fun audit(sessionHash: ByteArray, offset: Int, limit: Int): AdminAudit
}
