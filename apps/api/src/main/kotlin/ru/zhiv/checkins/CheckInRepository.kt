package ru.zhiv.checkins

import java.time.OffsetDateTime
import java.util.UUID

sealed interface CheckInResult {
    data object Unauthorized : CheckInResult

    data class Accepted(
        val eventId: UUID,
        val checkedAt: OffsetDateTime,
        val checkInCount: Long,
        val serverTime: OffsetDateTime,
        val nextAllowedAt: OffsetDateTime,
        val replayed: Boolean,
    ) : CheckInResult

    data class Cooldown(
        val checkedAt: OffsetDateTime,
        val serverTime: OffsetDateTime,
        val nextAllowedAt: OffsetDateTime,
    ) : CheckInResult
}

interface CheckInRepository {
    suspend fun record(sessionTokenHash: ByteArray, idempotencyKey: UUID): CheckInResult
}
