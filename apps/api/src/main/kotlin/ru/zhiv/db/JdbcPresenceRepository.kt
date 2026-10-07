package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.auth.AuthFailure
import ru.zhiv.presence.*
import java.sql.Connection
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

/** Server-observed presence, never client-supplied elapsed time. Account-first
 * locking is shared with auth, moderation and account lifecycle operations. */
class JdbcPresenceRepository(
    private val source: DataSource,
    private val clock: (() -> Instant)? = null,
) : PresenceRepository {
    private data class Actor(val user: UUID, val session: UUID)
    private data class Client(
        val id: UUID, val user: UUID, val session: UUID, val seen: Instant, val active: Instant,
        val status: String, val sequence: Long, val kind: String, val input: Boolean,
    )

    private fun actor(c: Connection, hash: ByteArray): Actor = c.economyRows("""
        SELECT u.id,s.id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            AND u.deleted_at IS NULL AND u.banned_at IS NULL
    """, hash) { Actor(it.getObject(1, UUID::class.java), it.getObject(2, UUID::class.java)) }.singleOrNull()
        ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)

    private suspend fun <T> transaction(hash: ByteArray, block: (Connection, Actor, Instant) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit = false
            try {
                val first = actor(c, hash)
                c.economyUpdate("SET LOCAL lock_timeout = '5s'")
                c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", first.user) { true }
                val current = actor(c, hash)
                val now = clock?.invoke() ?: c.economyRows("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java).toInstant() }.single()
                val value = block(c, current, now)
                c.commit()
                value
            } catch (error: Exception) { c.rollback(); throw error }
        }
    }

    private fun client(c: Connection, id: UUID): Client? = c.economyRows("SELECT * FROM game_presence_clients WHERE presence_id=?", id) {
        Client(id, it.getObject("user_id", UUID::class.java), it.getObject("auth_session_id", UUID::class.java),
            it.getObject("last_seen_at", OffsetDateTime::class.java).toInstant(), it.getObject("last_active_at", OffsetDateTime::class.java).toInstant(),
            it.getString("status"), it.getLong("sequence"), it.getString("last_kind"), it.getBoolean("last_active"))
    }.singleOrNull()

    private fun response(c: Connection, row: Client, now: Instant): PresenceView {
        val millis = c.economyRows("SELECT online_millis FROM game_presence_daily WHERE user_id=? AND day=?", row.user,
            now.atOffset(ZoneOffset.UTC).toLocalDate()) { it.getLong(1) }.singleOrNull() ?: 0L
        return PresenceView(row.id.toString(), presenceStatus(row.status, row.seen, row.active, now), now.toString(),
            row.active.plusSeconds(PRESENCE_IDLE_SECONDS).toString(), row.seen.plusSeconds(PRESENCE_LEASE_SECONDS).toString(), millis / 1000)
    }

    /** Only credit intervals confirmed at both ends within the live lease. No
     * future tail is pre-paid and a disconnected gap is never caught up. */
    private fun credit(c: Connection, row: Client, now: Instant) {
        if (now.isBefore(row.seen) || !now.isBefore(row.seen.plusSeconds(PRESENCE_LEASE_SECONDS))) return
        val until = minOf(now, row.active.plusSeconds(PRESENCE_IDLE_SECONDS))
        if (!row.seen.isBefore(until)) return
        // Keep the preceding lease window, not just a high-water mark: a tab
        // that started earlier can confirm a previously uncovered prefix later.
        // Older ranges cannot overlap any future accepted heartbeat interval.
        val uncovered = c.economyRows("""
            SELECT lower(span),upper(span) FROM unnest(
                tstzmultirange(tstzrange(?::timestamptz,?::timestamptz,'[)')) -
                coalesce((SELECT credited_spans FROM game_presence_accounts WHERE user_id=?),'{}'::tstzmultirange)
            ) AS span
        """, row.seen.atOffset(ZoneOffset.UTC), until.atOffset(ZoneOffset.UTC), row.user) {
            it.getObject(1, OffsetDateTime::class.java).toInstant() to it.getObject(2, OffsetDateTime::class.java).toInstant()
        }
        for ((day, millis) in uncovered.flatMap { (from, to) -> presenceDaySlices(from, to) }) {
            val newlyFlagged = c.economyRows("""
                INSERT INTO game_presence_daily(user_id,day,online_millis) VALUES (?,?,?)
                ON CONFLICT(user_id,day) DO UPDATE SET online_millis=least(86400000,game_presence_daily.online_millis+EXCLUDED.online_millis)
                RETURNING online_millis,flagged_at
            """, row.user, day, millis) { it.getLong(1) > PRESENCE_WATCH_MILLIS && it.getObject(2) == null }.single()
            if (newlyFlagged) {
                c.economyUpdate("UPDATE game_presence_daily SET flagged_at=? WHERE user_id=? AND day=? AND flagged_at IS NULL", now.atOffset(ZoneOffset.UTC), row.user, day)
                c.economyUpdate("UPDATE app_users SET tap_watchlisted=true WHERE id=?", row.user)
            }
        }
        c.economyUpdate("""INSERT INTO game_presence_accounts(user_id,credited_until,credited_spans)
            VALUES (?,?,tstzmultirange(tstzrange(?::timestamptz,?::timestamptz,'[)')))
            ON CONFLICT(user_id) DO UPDATE SET
                credited_until=greatest(game_presence_accounts.credited_until,EXCLUDED.credited_until),
                credited_spans=(game_presence_accounts.credited_spans + EXCLUDED.credited_spans) *
                    tstzmultirange(tstzrange(?::timestamptz,NULL,'[)'))""",
            row.user, now.atOffset(ZoneOffset.UTC), row.seen.atOffset(ZoneOffset.UTC), until.atOffset(ZoneOffset.UTC),
            now.minusSeconds(PRESENCE_LEASE_SECONDS).atOffset(ZoneOffset.UTC))

    }

    override suspend fun update(sessionHash: ByteArray, request: PresenceRequest): PresenceView {
        val id = validatePresenceRequest(request)
        return transaction(sessionHash) { c, actor, now ->
            var row = client(c, id)
            if (row == null) {
                if (request.kind != "resume") throw AuthFailure("GAME_SESSION_INACTIVE", "Вернитесь в игру, чтобы продолжить", 409)
                val recent = c.economyRows("SELECT count(*) FROM game_presence_clients WHERE user_id=? AND created_at>?", actor.user,
                    now.minusSeconds(3600).atOffset(ZoneOffset.UTC)) { it.getLong(1) }.single()
                if (recent >= 120) throw AuthFailure("PRESENCE_RATE_LIMITED", "Слишком частые подключения. Подождите немного", 429)
                c.economyUpdate("""INSERT INTO game_presence_clients(presence_id,user_id,auth_session_id,created_at,last_seen_at,last_active_at)
                    VALUES (?,?,?,?,?,?)""", id, actor.user, actor.session, now.atOffset(ZoneOffset.UTC), now.atOffset(ZoneOffset.UTC), now.atOffset(ZoneOffset.UTC))
                row = checkNotNull(client(c, id))
            } else {
                if (row.user != actor.user || row.session != actor.session) throw AuthFailure("PRESENCE_CONFLICT", "Открыт другой игровой сеанс", 409)
                val status = presenceStatus(row.status, row.seen, row.active, now)
                // Resolve expiry BEFORE replay handling: an old resume is never a new lease.
                if (status != "active") {
                    if (row.status == "active" && request.sequence > row.sequence && request.kind != "resume") credit(c, row, now)
                    if (row.status != status) c.economyUpdate("UPDATE game_presence_clients SET status=? WHERE presence_id=?", status, id)
                    return@transaction response(c, row.copy(status = status), now)
                }
                if (request.sequence == row.sequence && (request.kind != row.kind || request.active != row.input))
                    throw AuthFailure("PRESENCE_CONFLICT", "Изменились данные повторного запроса активности", 409)
                if (request.sequence <= row.sequence) return@transaction response(c, row, now)
                if (request.kind == "resume") return@transaction response(c, row, now)
                credit(c, row, now)
                val active = if (request.active) now else row.active
                val nextStatus = if (request.kind == "suspend") "suspended" else "active"
                c.economyUpdate("""UPDATE game_presence_clients SET sequence=?,last_kind=?,last_active=?,last_seen_at=?,last_active_at=?,status=?
                    WHERE presence_id=?""", request.sequence, request.kind, request.active, now.atOffset(ZoneOffset.UTC),
                    active.atOffset(ZoneOffset.UTC), nextStatus, id)
                row = row.copy(seen = now, active = active, status = nextStatus, sequence = request.sequence, kind = request.kind, input = request.active)
            }
            response(c, row, now)
        }
    }

    override suspend fun requireActive(sessionHash: ByteArray, presenceId: UUID) = transaction(sessionHash) { c, actor, now ->
        val row = client(c, presenceId)
        if (row == null || row.user != actor.user || row.session != actor.session ||
            presenceStatus(row.status, row.seen, row.active, now) != "active") {
            throw AuthFailure("GAME_SESSION_INACTIVE", "Вы отошли. Вернитесь в игру, чтобы продолжить", 409)
        }
    }
}

/** Merging identities must not add overlapping daily time. Without historical
 * intervals the conservative lower bound is max, never sum. Existing flags and
 * watch status survive; both accounts' live capabilities are suspended. */
internal fun mergeGamePresence(c: Connection, target: UUID, source: UUID) {
    c.economyUpdate("""INSERT INTO game_presence_daily(user_id,day,online_millis,flagged_at)
        SELECT ?,day,online_millis,flagged_at FROM game_presence_daily WHERE user_id=?
        ON CONFLICT(user_id,day) DO UPDATE SET
            online_millis=greatest(game_presence_daily.online_millis,EXCLUDED.online_millis),
            flagged_at=least(game_presence_daily.flagged_at,EXCLUDED.flagged_at)""", target, source)
    c.economyUpdate("UPDATE game_presence_clients SET status='suspended' WHERE user_id IN (?,?)", target, source)
    c.economyUpdate("DELETE FROM game_presence_daily WHERE user_id=?", source)
    c.economyUpdate("DELETE FROM game_presence_accounts WHERE user_id IN (?,?)", target, source)
}
