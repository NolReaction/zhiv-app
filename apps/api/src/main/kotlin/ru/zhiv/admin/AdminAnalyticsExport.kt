package ru.zhiv.admin

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parsePublicId
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Base64
import java.util.UUID

private fun invalidExport(): Nothing = throw AuthFailure("INVALID_ADMIN_QUERY", "Проверьте параметры выгрузки", 400)
private val exportJson = Json { encodeDefaults = true; ignoreUnknownKeys = false }
private const val maxSafeExportCount = 9_007_199_254_740_991L

/** Export pages deliberately do not inherit the journal's OFFSET ceiling. */
data class AdminAnalyticsExportQuery(
    val query: AdminAnalyticsQuery = AdminAnalyticsQuery(), val kind: String = "", val resource: String = "",
    val direction: String = "all", val allTime: Boolean = false, val cursor: String? = null, val limit: Int = 1000,
) {
    internal fun resolve(now: Instant): ResolvedAdminAnalyticsExport {
        if (limit !in 1..1000) invalidExport()
        val previous = cursor?.let(::decodeAdminAnalyticsExportCursor)
        val snapshot = previous?.let { parseExportTime(it.snapshotAt) } ?: now
        if (snapshot > now) invalidExport()
        val base = AdminAnalyticsEventsQuery(if (allTime) query.copy(from = null, to = null) else query,
            kind, resource, direction).resolve(snapshot)
        val window = if (allTime) {
            val exact = parsePublicId(base.q) ?: invalidExport()
            val first = LocalDate.of(1, 1, 1)
            base.copy(from = first, to = snapshot.atOffset(ZoneOffset.UTC).toLocalDate(),
                startAt = first.atStartOfDay().toInstant(ZoneOffset.UTC), endAt = snapshot, q = exact)
        } else base
        val context = exportContext(window, this)
        if (previous != null && (previous.context != context || previous.total !in 0..maxSafeExportCount
                || parseExportTime(previous.createdAt) < window.startAt || parseExportTime(previous.createdAt) >= window.endAt)) invalidExport()
        return ResolvedAdminAnalyticsExport(window, snapshot, previous, context)
    }
}

internal data class ResolvedAdminAnalyticsExport(val window: AdminAnalyticsWindow, val snapshotAt: Instant,
    val previous: AdminAnalyticsExportCursor?, val context: String)

@Serializable internal data class AdminAnalyticsExportCursor(
    val version: Int = 1, val snapshotAt: String, val context: String, val total: Long,
    val createdAt: String, val userId: String, val sourceKey: String,
)

internal fun encodeAdminAnalyticsExportCursor(cursor: AdminAnalyticsExportCursor): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(exportJson.encodeToString(cursor).toByteArray(Charsets.UTF_8))

private fun decodeAdminAnalyticsExportCursor(value: String): AdminAnalyticsExportCursor {
    if (value.length !in 1..4096 || !value.all { it.isLetterOrDigit() && it.code < 128 || it == '-' || it == '_' }) invalidExport()
    val cursor = try {
        val bytes = Base64.getUrlDecoder().decode(value)
        val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        exportJson.decodeFromString<AdminAnalyticsExportCursor>(text)
    } catch (_: Exception) { invalidExport() }
    if (cursor.version != 1 || !cursor.context.matches(Regex("[a-f0-9]{64}")) || cursor.userId.length != 36
        || cursor.sourceKey.length !in 1..512 || cursor.sourceKey.any(Char::isISOControl)) invalidExport()
    val id = try { UUID.fromString(cursor.userId) } catch (_: Exception) { invalidExport() }
    if (id.toString() != cursor.userId) invalidExport()
    parseExportTime(cursor.createdAt); parseExportTime(cursor.snapshotAt)
    return cursor
}

private fun parseExportTime(value: String): Instant {
    if (value.length !in 1..40) invalidExport()
    return try { Instant.parse(value) } catch (_: Exception) { invalidExport() }
}

private fun exportContext(window: AdminAnalyticsWindow, query: AdminAnalyticsExportQuery): String {
    val values = listOf(window.from.toString(), window.to.toString(), window.startAt.toString(), window.endAt.toString(),
        window.q, window.scope, query.kind, query.resource, query.direction, query.allTime.toString())
    return MessageDigest.getInstance("SHA-256").digest(exportJson.encodeToString(values).toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
}

@Serializable data class AdminAnalyticsEventsExport(
    val serverTime: String, val from: String, val to: String, val startAt: String, val endAt: String, val q: String, val scope: String,
    val kind: String, val resource: String, val direction: String, val allTime: Boolean, val snapshotAt: String,
    val limit: Int, val total: Long, val events: List<AdminAnalyticsEvent>, val nextCursor: String?,
)
