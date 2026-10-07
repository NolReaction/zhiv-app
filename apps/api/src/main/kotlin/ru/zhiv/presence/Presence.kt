package ru.zhiv.presence

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID

const val PRESENCE_IDLE_SECONDS = 300L
const val PRESENCE_LEASE_SECONDS = 90L
const val PRESENCE_WATCH_MILLIS = 20 * 60 * 60 * 1000L
const val PRESENCE_HEADER = "X-Game-Presence"

@Serializable
data class PresenceRequest(val kind: String, val presenceId: String, val sequence: Long, val active: Boolean)

@Serializable
data class PresenceView(
    val presenceId: String,
    val status: String,
    val serverNow: String,
    val idleExpiresAt: String,
    val leaseExpiresAt: String,
    val onlineTodaySeconds: Long,
)

interface PresenceRepository {
    suspend fun update(sessionHash: ByteArray, request: PresenceRequest): PresenceView
    suspend fun requireActive(sessionHash: ByteArray, presenceId: UUID)
}

fun validatePresenceRequest(request: PresenceRequest): UUID {
    val id = parseCanonicalUuidV4(request.presenceId)
    if (id == null || request.kind !in setOf("resume", "heartbeat", "suspend") ||
        request.sequence !in 0L until 9_007_199_254_740_991L ||
        (request.kind == "resume" && (request.sequence != 0L || !request.active)) ||
        (request.kind != "resume" && request.sequence == 0L) || (request.kind == "suspend" && request.active)) {
        throw AuthFailure("INVALID_PRESENCE", "Некорректный запрос игровой активности", 400)
    }
    return id
}

internal fun presenceStatus(status: String, lastSeen: Instant, lastActive: Instant, now: Instant): String = when {
    status != "active" -> status
    !now.isBefore(lastActive.plusSeconds(PRESENCE_IDLE_SECONDS)) -> "idle"
    !now.isBefore(lastSeen.plusSeconds(PRESENCE_LEASE_SECONDS)) -> "disconnected"
    else -> "active"
}

/** The caller has already removed overlap with all previously credited intervals. */
internal fun presenceDaySlices(from: Instant, until: Instant): List<Pair<LocalDate, Long>> {
    var start = from.toEpochMilli()
    val end = until.toEpochMilli()
    return buildList {
        while (start < end) {
            val day = Instant.ofEpochMilli(start).atOffset(ZoneOffset.UTC).toLocalDate()
            val nextDay = day.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli()
            val stop = minOf(nextDay, end)
            add(day to (stop - start))
            start = stop
        }
    }
}
