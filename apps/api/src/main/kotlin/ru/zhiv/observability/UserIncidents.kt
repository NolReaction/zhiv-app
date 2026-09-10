package ru.zhiv.observability

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.install
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import ru.zhiv.admin.AdminRepository
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

@Serializable
data class ClientIncident(val eventId: String, val operation: String, val code: String, val occurredAt: String,
    val requestId: String? = null, val httpStatus: Int? = null, val pendingTaps: Int = 0, val occurrences: Int = 1, val ownerPublicId: String? = null)
@Serializable
data class UserIncident(val id: Long, val publicId: String, val displayName: String, val source: String,
    val operation: String, val code: String, val occurredAt: String, val receivedAt: String,
    val requestId: String?, val httpStatus: Int?, val pendingTaps: Int, val occurrences: Int)
@Serializable
data class IncidentPage(val serverTime: String, val total: Long, val offset: Int, val limit: Int, val events: List<UserIncident>, val totalOccurrences: Long, val affectedUsers: Long)

val CLIENT_INCIDENT_CODES = setOf("NETWORK_ERROR", "TIMEOUT", "RATE_LIMITED", "SERVER_ERROR", "SYNC_RECOVERED",
    "RECEIPT_INVALID", "QUEUE_FULL", "STORAGE_FAILED", "GAME_ACTIVE_ELSEWHERE", "GAME_SESSION_EXPIRED",
    "GAME_QUEUE_EXPIRED", "GAME_TAP_RATE", "GAME_PERMIT_CLOSED", "GAME_SESSION_GONE", "GAME_SEQUENCE_CONFLICT", "GAME_SESSION_CONFLICT", "GAME_PACING",
    "UNAUTHORIZED", "GAME_OWNER_CHANGED", "SYNC_ERROR", "PAGE_ERROR", "UNHANDLED_REJECTION", "OFFLINE", "WORLD_MAP_FAILED", "WORLD_MAP_TIMEOUT", "WORLD_CHARACTER_FAILED", "WORLD_CHARACTER_TIMEOUT")
private val CLIENT_OPERATIONS = setOf("game.progress", "game.session", "game.batch", "game.storage", "check-in", "world", "page")

/** No browser-supplied identity, free-form message, URL, stack or credentials are stored. */
class UserIncidentRepository(private val source: DataSource) {
    private data class Repeats(var at: Long, var count: Int)
    private val repeats = object : LinkedHashMap<String, Repeats>(128, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Repeats>?): Boolean = size > 4096
    }
    private val slots = java.util.concurrent.Semaphore(2)
    private var minute = 0L
    private var minuteWrites = 0
    private fun serverCount(hash: ByteArray, input: ClientIncident): Int = synchronized(repeats) {
        val now = System.currentTimeMillis()
        if (now / 60000 != minute) { minute = now / 60000; minuteWrites = 0 }
        val key = java.util.Base64.getEncoder().encodeToString(hash) + ":" + input.operation + ":" + input.code
        val previous = repeats[key]
        if (previous != null && now - previous.at < 60000) { previous.count = minOf(100000, previous.count + 1); return@synchronized 0 }
        if (minuteWrites >= 120) return@synchronized 0
        minuteWrites++
        val count = (previous?.count ?: 0) + 1
        repeats[key] = Repeats(now, 0)
        minOf(100000, count)
    }
    suspend fun record(hash: ByteArray, input: ClientIncident, server: Boolean = false) = withContext(Dispatchers.IO) {
        if (!slots.tryAcquire()) {
            if (server) return@withContext
            throw AuthFailure("DATABASE_BUSY", "Повторите отправку события позже", 503)
        }
        try {
        val occurrences = if (server) serverCount(hash, input) else input.occurrences
        if (occurrences == 0) return@withContext
        val id = parseCanonicalUuidV4(input.eventId) ?: invalid()
        val requestId = input.requestId?.let { parseCanonicalUuidV4(it) ?: invalid() }
        val occurred = runCatching { Instant.parse(input.occurredAt) }.getOrNull() ?: invalid()
        if (!server && input.ownerPublicId == null) invalid()
        if (!server && (input.code !in CLIENT_INCIDENT_CODES || input.operation !in CLIENT_OPERATIONS)) invalid()
        if (input.operation.length > 100 || input.code.length > 64 || input.pendingTaps !in 0..100000 || input.occurrences !in 1..100000 || input.httpStatus?.let { it !in 100..599 } == true) invalid()
        val now = Instant.now()
        if (occurred.isBefore(now.minusSeconds(7 * 86400)) || occurred.isAfter(now.plusSeconds(300))) invalid()
        source.connection.use { c ->
            c.autoCommit = false
            try {
            c.prepareStatement("SELECT u.public_id FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.deleted_at IS NULL AND u.banned_at IS NULL").use { s ->
                s.queryTimeout = 2; s.setBytes(1, hash)
                s.executeQuery().use { r ->
                    if (!r.next()) throw AuthFailure("UNAUTHORIZED", "Войдите в профиль", 401)
                    if (input.ownerPublicId != null && input.ownerPublicId != r.getString(1)) throw AuthFailure("GAME_OWNER_CHANGED", "Открыт другой профиль", 409)
                }
            }
            c.prepareStatement("""
                INSERT INTO user_incidents(user_id,event_id,source,operation,code,occurred_at,request_id,http_status,pending_taps,occurrences)
                SELECT u.id,?,?,?,?,?,?,?,?,? FROM app_sessions s JOIN app_users u ON u.id=s.user_id
                WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.deleted_at IS NULL AND u.banned_at IS NULL AND (?::text IS NULL OR u.public_id=?)
                ON CONFLICT(user_id,event_id) DO NOTHING
            """.trimIndent()).use { s ->
                s.queryTimeout = 2
                listOf(id, if (server) "server" else "client", input.operation, input.code, occurred.atOffset(ZoneOffset.UTC), requestId,
                    input.httpStatus, input.pendingTaps, occurrences, hash, input.ownerPublicId, input.ownerPublicId).forEachIndexed { i, value -> s.setObject(i + 1, value) }
                s.executeUpdate()
            }
            // Bounded incremental retention cleanup; no unbounded delete in request processing.
            c.prepareStatement("DELETE FROM user_incidents WHERE id IN (SELECT id FROM user_incidents WHERE received_at < clock_timestamp() - interval '30 days' ORDER BY received_at LIMIT 200)").use { s -> s.queryTimeout = 2; s.executeUpdate() }
            c.commit()
            } catch (error: Exception) { c.rollback(); throw error }
        }
        } finally { slots.release() }
    }
    suspend fun list(range: Int, query: String, offset: Int, limit: Int, sourceFilter: String = "", codeFilter: String = ""): IncidentPage = withContext(Dispatchers.IO) {
        if (range !in setOf(60,360,1440,10080,43200) || query.length > 100 || query.any(Char::isISOControl) || offset !in 0..100000 || limit !in 1..100
            || sourceFilter !in setOf("", "client", "server") || (codeFilter.isNotEmpty() && !Regex("^[A-Z][A-Z0-9_]{0,63}$").matches(codeFilter))) invalid()
        val now = Instant.now()
        source.connection.use { c ->
            c.autoCommit = false
            c.transactionIsolation = java.sql.Connection.TRANSACTION_REPEATABLE_READ
            c.isReadOnly = true
            try {
                val filter = "FROM user_incidents i JOIN app_users u ON u.id=i.user_id WHERE i.received_at >= ? AND i.received_at <= ? AND (?='' OR u.public_id=? OR position(lower(?) in lower(u.display_name))>0) AND (?='' OR i.source=?) AND (?='' OR i.code=?)"
                fun java.sql.PreparedStatement.parameters() {
                    listOf(now.minusSeconds(range.toLong()*60).atOffset(ZoneOffset.UTC), now.atOffset(ZoneOffset.UTC), query, query.uppercase(), query,
                        sourceFilter, sourceFilter, codeFilter, codeFilter).forEachIndexed { i, value -> setObject(i+1,value) }
                    queryTimeout = 3
                }
                val summary = c.prepareStatement("SELECT count(*), coalesce(sum(i.occurrences),0), count(DISTINCT i.user_id) $filter").use { s ->
                    s.parameters(); s.executeQuery().use { r -> r.next(); Triple(r.getLong(1),r.getLong(2),r.getLong(3)) }
                }
                val rows = c.prepareStatement("SELECT i.*,u.public_id,u.display_name $filter ORDER BY i.received_at DESC,i.id DESC OFFSET ? LIMIT ?").use { s ->
                    s.parameters(); s.setInt(10, offset); s.setInt(11, limit)
                    s.executeQuery().use { r -> buildList { while (r.next()) add(UserIncident(r.getLong("id"), r.getString("public_id"), r.getString("display_name"),
                        r.getString("source"), r.getString("operation"), r.getString("code"), r.getObject("occurred_at", OffsetDateTime::class.java).toInstant().toString(),
                        r.getObject("received_at", OffsetDateTime::class.java).toInstant().toString(), r.getObject("request_id")?.toString(), r.getObject("http_status") as? Int,
                        r.getInt("pending_taps"), r.getInt("occurrences"))) } }
                }
                c.commit()
                IncidentPage(now.toString(), summary.first, offset, limit, rows, summary.second, summary.third)
            } catch (error: Exception) { c.rollback(); throw error }
        }
    }
    private fun invalid(): Nothing = throw AuthFailure("INVALID_INCIDENT", "Некорректное событие", 400)
}

fun Route.userIncidentRoutes(repository: UserIncidentRepository, admin: AdminRepository?, config: AppConfig, codec: TokenCodec) {
    route("/api/v1/client-incidents") {
        install(RequestBodyLimit) { bodyLimit { 2048 } }
        rateLimit(RateLimitName("client-incidents")) {
            post {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                if (!call.isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
                val raw = call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль", 401)
                repository.record(codec.hash(raw), call.receive<ClientIncident>())
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
    if (admin != null) rateLimit(RateLimitName("admin-read")) {
        get("/api/v1/admin/incidents") {
            call.response.header("X-Robots-Tag", "noindex, nofollow")
            call.response.header(HttpHeaders.CacheControl, "no-store")
            val raw = call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль", 401)
            admin.access(codec.hash(raw))
            fun param(name: String, fallback: String) = call.request.queryParameters.getAll(name)?.singleOrNull() ?: if (call.request.queryParameters[name] == null) fallback else "!"
            call.respond(repository.list(param("rangeMinutes", "1440").toIntOrNull() ?: 0, param("q", "").trim(), param("offset", "0").toIntOrNull() ?: -1, param("limit", "25").toIntOrNull() ?: 0, param("source", ""), param("code", "")))
        }
    }
}
