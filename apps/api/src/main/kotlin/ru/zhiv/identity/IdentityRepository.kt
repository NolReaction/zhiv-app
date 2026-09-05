package ru.zhiv.identity

import ru.zhiv.checkins.DailyStreakSnapshot
import java.time.OffsetDateTime
import java.util.UUID

data class UserSnapshot(
    val id: UUID,
    val publicId: String,
    val displayName: String,
    val lastCheckInAt: OffsetDateTime?,
    val checkInCount: Long,
    val streak: DailyStreakSnapshot,
    val displayNameChangedAt: OffsetDateTime?,
    val displayNameChangeAvailableAt: OffsetDateTime?,
    val serverTime: OffsetDateTime,
    val statusText: String? = null,
    val statusUpdatedAt: OffsetDateTime? = null,
)

sealed interface DisplayNameUpdateResult {
    data class Success(val user: UserSnapshot) : DisplayNameUpdateResult

    data class Cooldown(
        val availableAt: OffsetDateTime,
        val serverTime: OffsetDateTime,
    ) : DisplayNameUpdateResult

    data object Unauthorized : DisplayNameUpdateResult
    data object IdempotencyConflict : DisplayNameUpdateResult
}

interface IdentityRepository {
    suspend fun updateStatus(sessionTokenHash: ByteArray, text: String, idempotencyKey: UUID): DisplayNameUpdateResult =
        throw UnsupportedOperationException("Status writes not implemented")

    suspend fun bootstrap(
        displayName: String,
        bootstrapKeyHash: ByteArray,
        sessionTokenHash: ByteArray,
        sessionLifetimeDays: Long,
    ): UserSnapshot

    suspend fun findBySession(sessionTokenHash: ByteArray): UserSnapshot?

    suspend fun updateDisplayName(
        sessionTokenHash: ByteArray,
        displayName: String,
        idempotencyKey: UUID,
    ): DisplayNameUpdateResult
}

class BootstrapKeyExpiredException : RuntimeException("Bootstrap idempotency key expired")
