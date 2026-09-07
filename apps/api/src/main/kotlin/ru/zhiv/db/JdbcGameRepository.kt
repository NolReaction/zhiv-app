package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.auth.AuthFailure
import ru.zhiv.game.*
import java.sql.Connection
import java.sql.ResultSet
import java.time.Duration
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource
import kotlin.math.floor

/** Competitive progress is derived only from bounded batches received by this server.
 * The shared per-user bucket survives new sessions, device changes and API restarts. */
class JdbcGameRepository(private val source: DataSource) : GameRepository {
    companion object {
        const val MAX_BATCH_TAPS = 60
        const val BUCKET_CAPACITY = 60.0
        const val TAPS_PER_SECOND = 12.0
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    }
    private fun fail(code: String, message: String, status: Int = 409): Nothing = throw AuthFailure(code, message, status)
    private fun Connection.update(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { s ->
        values.forEachIndexed { i, v -> s.setObject(i + 1, v) }; s.executeUpdate()
    }
    private fun <T> Connection.rows(sql: String, vararg values: Any?, map: (ResultSet) -> T): List<T> = prepareStatement(sql).use { s ->
        values.forEachIndexed { i, v -> s.setObject(i + 1, v) }
        s.executeQuery().use { r -> buildList { while (r.next()) add(map(r)) } }
    }
    private fun <T> Connection.one(sql: String, vararg values: Any?, map: (ResultSet) -> T): T? = rows(sql, *values, map = map).firstOrNull()
    private suspend fun <T> tx(block: (Connection) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit = false
            try { val result = block(c); c.commit(); result } catch (e: Exception) { c.rollback(); throw e }
        }
    }
    private data class Actor(val id: UUID, val authSessionId: UUID, val publicId: String)
    private fun actor(c: Connection, hash: ByteArray): Actor = c.one("""
        SELECT u.id, s.id AS session_id, u.public_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND u.deleted_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    """.trimIndent(), hash) { Actor(it.getObject(1, UUID::class.java), it.getObject(2, UUID::class.java), it.getString(3)) }
        ?: fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    private fun lockActor(c: Connection, hash: ByteArray): Actor {
        val first = actor(c, hash)
        c.update("SET LOCAL lock_timeout = '5s'")
        c.one("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", first.id) { true }
        // Same user-before-child lock order as check-ins, merge and deletion.
        return actor(c, hash)
    }
    private fun requireOwner(actor: Actor, expected: String) {
        if (actor.publicId != expected) fail("GAME_OWNER_CHANGED", "Открыт другой профиль. Обновите игровой прогресс.")
    }
    private fun now(c: Connection): OffsetDateTime = c.one("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java) }!!
    private fun month(now: OffsetDateTime): LocalDate = now.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate().withDayOfMonth(1)
    private fun ensureProfile(c: Connection, actor: Actor) {
        c.update("INSERT INTO game_profiles(user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING", actor.id)
    }
    private fun progress(c: Connection, actor: Actor, instant: OffsetDateTime): GameProgress = c.one("""
        SELECT COALESCE(p.lifetime_taps,0), COALESCE(p.best_series,0), COALESCE(m.taps,0),
               COALESCE(p.leaderboard_opt_in,false), COALESCE(p.visibility_version,0)
        FROM app_users u LEFT JOIN game_profiles p ON p.user_id=u.id
        LEFT JOIN game_monthly_scores m ON m.user_id=u.id AND m.month=? WHERE u.id=?
    """.trimIndent(), month(instant), actor.id) {
        GameProgress(actor.publicId, it.getLong(1), it.getLong(2), month(instant).toString().take(7), it.getLong(3), it.getBoolean(4), it.getLong(5), instant.toInstant().toString())
    }!!
    override suspend fun progress(sessionHash: ByteArray): GameProgress = tx { c ->
        val actor = lockActor(c, sessionHash)
        progress(c, actor, now(c))
    }
    private data class PlaySession(
        val id: UUID, val authSession: UUID, val month: LocalDate, val expires: OffsetDateTime,
        val sequence: Long, val taps: Int, val accepted: Int, val lastRunId: UUID?,
        val lastBatch: OffsetDateTime?, val runId: UUID?, val runUpdatedAt: OffsetDateTime?, val runTaps: Long,
    )
    private fun sessionRow(r: ResultSet) = PlaySession(
        r.getObject("id", UUID::class.java), r.getObject("auth_session_id", UUID::class.java),
        r.getObject("month", LocalDate::class.java), r.getObject("expires_at", OffsetDateTime::class.java),
        r.getLong("last_sequence"), r.getInt("last_tap_count"), r.getInt("last_accepted"),
        r.getObject("last_run_id", UUID::class.java), r.getObject("last_batch_at", OffsetDateTime::class.java),
        r.getObject("run_id", UUID::class.java), r.getObject("run_updated_at", OffsetDateTime::class.java), r.getLong("run_taps"),
    )
    override suspend fun openSession(sessionHash: ByteArray, requestId: UUID, ownerPublicId: String): GameSessionResponse = tx { c ->
        val actor = lockActor(c, sessionHash)
        requireOwner(actor, ownerPublicId)
        val instant = now(c)
        ensureProfile(c, actor)
        val existing = c.one("SELECT * FROM game_sessions WHERE user_id=? AND request_id=?", actor.id, requestId, map = ::sessionRow)
        if (existing != null) {
            if (existing.authSession != actor.authSessionId) fail("GAME_SESSION_CONFLICT", "Запрос уже использован в другом сеансе")
            if (!existing.expires.isAfter(instant)) fail("GAME_SESSION_EXPIRED", "Начните новую игровую сессию")
            return@tx GameSessionResponse(existing.id.toString(), existing.sequence + 1, existing.expires.toInstant().toString(), progress(c, actor, instant))
        }
        // Receipts remain available for a day after expiry. Old sessions never accept new batches.
        c.update("DELETE FROM game_sessions WHERE user_id=? AND expires_at < ?::timestamptz - interval '1 day'", actor.id, instant)
        val active = c.one("SELECT count(*) FROM game_sessions WHERE user_id=? AND expires_at>?", actor.id, instant) { it.getInt(1) }!!
        if (active >= 8) fail("GAME_SESSION_LIMIT", "Слишком много игровых окон. Закройте лишние и попробуйте позже.", 429)
        val scoreMonth = month(instant)
        val endOfMonth = scoreMonth.plusMonths(1).atStartOfDay().atOffset(ZoneOffset.UTC)
        val expires = minOf(instant.plusMinutes(15), endOfMonth)
        val id = c.one("""
            INSERT INTO game_sessions(user_id,auth_session_id,request_id,month,created_at,expires_at)
            VALUES (?,?,?,?,?,?) RETURNING id
        """.trimIndent(), actor.id, actor.authSessionId, requestId, scoreMonth, instant, expires) { it.getObject(1, UUID::class.java) }!!
        GameSessionResponse(id.toString(), 1, expires.toInstant().toString(), progress(c, actor, instant))
    }
    override suspend fun submitBatch(sessionHash: ByteArray, sessionId: UUID, sequence: Long, tapCount: Int, runId: UUID): GameBatchResponse = tx { c ->
        if (sequence !in 1L until MAX_SAFE_INTEGER || tapCount !in 1..MAX_BATCH_TAPS) fail("INVALID_GAME_BATCH", "Некорректный игровой пакет", 400)
        val actor = lockActor(c, sessionHash)
        val game = c.one("SELECT * FROM game_sessions WHERE id=? AND user_id=? FOR UPDATE", sessionId, actor.id, map = ::sessionRow)
            ?: fail("GAME_SESSION_EXPIRED", "Начните новую игровую сессию")
        if (game.authSession != actor.authSessionId) fail("GAME_SESSION_CONFLICT", "Игровая сессия открыта на другом устройстве")
        val instant = now(c)
        if (sequence == game.sequence) {
            if (tapCount != game.taps || runId != game.lastRunId) fail("GAME_SEQUENCE_CONFLICT", "Игровой пакет уже использован")
            return@tx GameBatchResponse(sessionId.toString(), sequence, game.accepted, tapCount - game.accepted, true, progress(c, actor, instant))
        }
        if (sequence != game.sequence + 1) fail("GAME_SEQUENCE_CONFLICT", "Нарушен порядок игровых пакетов")
        if (!game.expires.isAfter(instant) || game.month != month(instant)) fail("GAME_SESSION_EXPIRED", "Начните новую игровую сессию")
        data class Budget(val tokens: Double, val updated: OffsetDateTime, val lifetime: Long)
        val bucket = c.one("SELECT bucket_tokens,bucket_updated_at,lifetime_taps FROM game_profiles WHERE user_id=? FOR UPDATE", actor.id) {
            Budget(it.getDouble(1), it.getObject(2, OffsetDateTime::class.java), it.getLong(3))
        } ?: error("Game session without profile")
        val elapsed = Duration.between(bucket.updated, instant).toNanos().coerceAtLeast(0).toDouble() / 1_000_000_000.0
        val available = minOf(BUCKET_CAPACITY, bucket.tokens + elapsed * TAPS_PER_SECOND)
        val accepted = minOf(tapCount, floor(available).toInt(), (MAX_SAFE_INTEGER - bucket.lifetime).coerceAtMost(MAX_BATCH_TAPS.toLong()).toInt())
        // Transport-session renewal must not split an uninterrupted run. Inherit at
        // most one expired predecessor from this authenticated device, never an active
        // parallel session. The user lock serializes this one-use continuation claim.
        val predecessor = if (accepted > 0 && game.runId == null) c.one("""
            SELECT * FROM game_sessions WHERE user_id=? AND auth_session_id=? AND id<>?
                AND expires_at<=? AND run_id=? AND NOT continuation_claimed
                AND run_updated_at BETWEEN ?::timestamptz - interval '12 seconds' AND ?
            ORDER BY run_updated_at DESC,expires_at DESC,id DESC LIMIT 1 FOR UPDATE
        """.trimIndent(), actor.id, actor.authSessionId, sessionId, instant, runId, instant, instant, map = ::sessionRow) else null
        val priorRun = predecessor ?: game
        val continuing = gameRunContinues(priorRun.runId, runId, priorRun.runUpdatedAt, instant)
        val runTaps = if (accepted == 0) game.runTaps else if (continuing) minOf(MAX_SAFE_INTEGER, priorRun.runTaps + accepted) else accepted.toLong()
        if (predecessor != null) c.update("UPDATE game_sessions SET continuation_claimed=true WHERE id=?", predecessor.id)
        c.update("""
            UPDATE game_profiles SET lifetime_taps=lifetime_taps+?,best_series=GREATEST(best_series,?),
                bucket_tokens=?,bucket_updated_at=GREATEST(bucket_updated_at,?),updated_at=? WHERE user_id=?
        """.trimIndent(), accepted, runTaps, available - accepted, instant, instant, actor.id)
        if (accepted > 0) c.update("""
            INSERT INTO game_monthly_scores(user_id,month,taps,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(user_id,month) DO UPDATE SET taps=LEAST(9007199254740991,game_monthly_scores.taps+EXCLUDED.taps),updated_at=EXCLUDED.updated_at
        """.trimIndent(), actor.id, game.month, accepted, instant)
        c.update("""
            UPDATE game_sessions SET last_sequence=?,last_tap_count=?,last_accepted=?,last_run_id=?,last_batch_at=?,run_taps=?,run_id=?,run_updated_at=? WHERE id=?
        """.trimIndent(), sequence, tapCount, accepted, runId, instant, runTaps, if (accepted > 0) runId else game.runId, if (accepted > 0) instant else game.runUpdatedAt, sessionId)
        GameBatchResponse(sessionId.toString(), sequence, accepted, tapCount - accepted, false, progress(c, actor, instant))
    }
    override suspend fun setVisibility(sessionHash: ByteArray, visible: Boolean, expectedVersion: Long, ownerPublicId: String): GameProgress = tx { c ->
        if (expectedVersion !in 0L until MAX_SAFE_INTEGER) fail("INVALID_GAME_VISIBILITY", "Некорректная версия настроек", 400)
        val actor = lockActor(c, sessionHash)
        requireOwner(actor, ownerPublicId)
        ensureProfile(c, actor)
        val current = progress(c, actor, now(c))
        if (current.visibilityVersion != expectedVersion) {
            if (current.visibilityVersion == expectedVersion + 1 && current.leaderboardOptIn == visible) return@tx current
            fail("GAME_VISIBILITY_CONFLICT", "Настройка рейтинга уже изменилась. Обновите её.")
        }
        c.update("UPDATE game_profiles SET leaderboard_opt_in=?,visibility_version=visibility_version+1,updated_at=clock_timestamp() WHERE user_id=?", visible, actor.id)
        progress(c, actor, now(c))
    }
    override suspend fun leaderboard(sessionHash: ByteArray): GameLeaderboard = tx { c ->
        val actor = lockActor(c, sessionHash)
        val instant = now(c)
        val current = progress(c, actor, instant)
        val ranked = c.rows("""
            WITH ranking AS (
                SELECT row_number() OVER (ORDER BY m.taps DESC,m.updated_at,m.user_id) AS place,
                       u.display_name,m.taps,u.id=? AS is_me
                FROM game_monthly_scores m JOIN game_profiles p ON p.user_id=m.user_id
                JOIN app_users u ON u.id=m.user_id
                WHERE m.month=? AND m.taps>0 AND p.leaderboard_opt_in AND u.deleted_at IS NULL
            ) SELECT place,display_name,taps,is_me FROM ranking WHERE place<=100 OR is_me ORDER BY place
        """.trimIndent(), actor.id, month(instant)) { GameLeaderboardEntry(it.getLong(1), it.getString(2), it.getLong(3), it.getBoolean(4)) }
        GameLeaderboard(actor.publicId, current.month, current.serverTime, ranked.filter { it.rank <= 100 }, ranked.firstOrNull { it.isMe }?.rank, current.monthlyTaps, current.leaderboardOptIn)
    }
}

internal fun gameRunContinues(previousRunId: UUID?, runId: UUID, previousAt: OffsetDateTime?, now: OffsetDateTime): Boolean =
    previousRunId == runId && previousAt != null && Duration.between(previousAt, now).toMillis() in 0L..12_000L
