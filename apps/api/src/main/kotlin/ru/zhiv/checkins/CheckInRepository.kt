package ru.zhiv.checkins

import java.time.OffsetDateTime
import java.util.UUID

data class DailyStreakSnapshot(
    val currentDays: Long,
    val longestDays: Long,
    val isActive: Boolean,
    val renewBy: OffsetDateTime?,
)

sealed interface CheckInResult {
    data object Unauthorized : CheckInResult

    data class Accepted(
        val eventId: UUID,
        val checkedAt: OffsetDateTime,
        val checkInCount: Long,
        val streak: DailyStreakSnapshot,
        val serverTime: OffsetDateTime,
        val nextAllowedAt: OffsetDateTime,
        val replayed: Boolean,
    ) : CheckInResult

    data class Cooldown(
        val checkedAt: OffsetDateTime,
        val streak: DailyStreakSnapshot,
        val serverTime: OffsetDateTime,
        val nextAllowedAt: OffsetDateTime,
    ) : CheckInResult
}

interface CheckInRepository {
    suspend fun record(sessionTokenHash: ByteArray, idempotencyKey: UUID): CheckInResult
}
