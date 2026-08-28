package ru.zhiv.identity

import java.time.OffsetDateTime
import java.util.UUID

data class UserSnapshot(
    val id: UUID,
    val publicId: String,
    val displayName: String,
    val lastCheckInAt: OffsetDateTime?,
    val checkInCount: Long,
    val serverTime: OffsetDateTime,
)

interface IdentityRepository {
    suspend fun bootstrap(
        displayName: String,
        bootstrapKeyHash: ByteArray,
        sessionTokenHash: ByteArray,
        sessionLifetimeDays: Long,
    ): UserSnapshot

    suspend fun findBySession(sessionTokenHash: ByteArray): UserSnapshot?
}

class BootstrapKeyExpiredException : RuntimeException("Bootstrap idempotency key expired")
