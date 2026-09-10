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
        const val TAPS_PER_SECOND = 30.0
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
        WHERE s.token_hash=? AND u.deleted_at IS NULL AND u.banned_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
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
        GameProgress(actor.publicId, it.getLong(1), it.getLong(2), month(instant).toString().take(7), it.getLong(3), it.getBoolean(4), it.getLong(5), instant.toInstant().toString(),
            c.rows("SELECT item_id FROM game_items WHERE user_id=? ORDER BY item_id", actor.id) { item -> item.getString(1) })
    }!!
    override suspend fun progress(sessionHash: ByteArray): GameProgress = tx { c ->
        val actor = lockActor(c, sessionHash)
        val instant = now(c)
        recordMergedAchievements(c, actor.id, instant)
        progress(c, actor, instant)
    }
    private data class PlaySession(
        val eventTokens: Double, val eventUpdated: OffsetDateTime?,
        val created: OffsetDateTime, val closed: OffsetDateTime?, val tapTimes: List<Long>?, val rejectionCode: String?,
        val id: UUID, val authSession: UUID, val month: LocalDate, val expires: OffsetDateTime,
        val sequence: Long, val taps: Int, val accepted: Int, val lastRunId: UUID?,
        val lastBatch: OffsetDateTime?, val runId: UUID?, val runUpdatedAt: OffsetDateTime?, val runTaps: Long,
    )
    private fun sessionRow(r: ResultSet) = PlaySession(
        r.getDouble("event_tokens"), r.getObject("event_updated_at", OffsetDateTime::class.java),
        r.getObject("created_at", OffsetDateTime::class.java), r.getObject("closed_at", OffsetDateTime::class.java),
        (r.getArray("last_tap_times")?.array as? Array<*>)?.map { (it as Number).toLong() }, r.getString("last_rejection_code"),
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
            if (instant.isAfter(existing.expires.plusDays(2))) fail("GAME_QUEUE_EXPIRED", "Срок подтверждения этой очереди истёк", 410)
            return@tx GameSessionResponse(existing.id.toString(), existing.sequence + 1, existing.expires.toInstant().toString(), progress(c, actor, instant), existing.created.toInstant().toString(), existing.closed?.toInstant()?.toString())
        }
        // Retain receipts for two days; timed queues may deliver taps recorded during the permit.
        c.update("DELETE FROM game_sessions WHERE user_id=? AND expires_at < ?::timestamptz - interval '2 days'", actor.id, instant)
        val writer = c.one("SELECT writer_session_id,writer_until FROM game_profiles WHERE user_id=?", actor.id) {
            it.getObject(1, UUID::class.java) to it.getObject(2, OffsetDateTime::class.java)
        }!!
        if (writer.first != null && writer.second?.isAfter(instant) == true) fail("GAME_ACTIVE_ELSEWHERE", "Игра активна в другом окне или на другом устройстве")
        // Only a real takeover closes the old permit. Delayed pre-takeover taps remain deliverable.
        writer.first?.let { c.update("UPDATE game_sessions SET closed_at=COALESCE(closed_at,?) WHERE id=?", instant, it) }
        val scoreMonth = month(instant)
        val endOfMonth = scoreMonth.plusMonths(1).atStartOfDay().atOffset(ZoneOffset.UTC)
        val expires = minOf(instant.plusMinutes(15), endOfMonth)
        val id = c.one("""
            INSERT INTO game_sessions(user_id,auth_session_id,request_id,month,created_at,expires_at)
            VALUES (?,?,?,?,?,?) RETURNING id
        """.trimIndent(), actor.id, actor.authSessionId, requestId, scoreMonth, instant, expires) { it.getObject(1, UUID::class.java) }!!
        c.update("UPDATE game_profiles SET writer_session_id=?,writer_until=? WHERE user_id=?", id, minOf(instant.plusSeconds(30), expires), actor.id)
        GameSessionResponse(id.toString(), 1, expires.toInstant().toString(), progress(c, actor, instant), instant.toInstant().toString())
    }
    override suspend fun submitBatch(sessionHash: ByteArray, sessionId: UUID, sequence: Long, tapCount: Int, runId: UUID, tapTimes: List<Long>?): GameBatchResponse = tx { c ->
        if (sequence !in 1L until MAX_SAFE_INTEGER || tapCount !in 1..MAX_BATCH_TAPS) fail("INVALID_GAME_BATCH", "Некорректный игровой пакет", 400)
        if (tapTimes != null && (tapTimes.size != tapCount || tapTimes.any { it !in 0L..253_402_300_799_000L } || tapTimes.zipWithNext().any { it.first > it.second })) fail("INVALID_GAME_BATCH", "Некорректное время нажатий", 400)
        val actor = lockActor(c, sessionHash)
        val game = c.one("SELECT * FROM game_sessions WHERE id=? AND user_id=? FOR UPDATE", sessionId, actor.id, map = ::sessionRow)
            ?: fail("GAME_SESSION_GONE", "Игровая сессия больше недоступна", 410)
        if (game.authSession != actor.authSessionId) fail("GAME_SESSION_CONFLICT", "Игровая сессия открыта на другом устройстве")
        val instant = now(c)
        if (sequence == game.sequence) {
            if (tapCount != game.taps || runId != game.lastRunId || tapTimes != game.tapTimes) fail("GAME_SEQUENCE_CONFLICT", "Игровой пакет уже использован")
            return@tx GameBatchResponse(sessionId.toString(), sequence, game.accepted, tapCount - game.accepted, true, progress(c, actor, instant), if (game.runId == runId) game.runTaps else 0L, game.rejectionCode)
        }
        if (sequence != game.sequence + 1) fail("GAME_SEQUENCE_CONFLICT", "Нарушен порядок игровых пакетов")
        if (tapTimes == null && (!game.expires.isAfter(instant) || game.month != month(instant))) fail("GAME_SESSION_EXPIRED", "Начните новую игровую сессию")
        if (instant.isAfter(game.expires.plusDays(2))) fail("GAME_QUEUE_EXPIRED", "Срок подтверждения этой очереди истёк", 410)
        if (tapTimes == null && game.closed != null) fail("GAME_ACTIVE_ELSEWHERE", "Игра активна на другом устройстве")
        val writer = c.one("SELECT writer_session_id,writer_until FROM game_profiles WHERE user_id=?", actor.id) {
            it.getObject(1, UUID::class.java) to it.getObject(2, OffsetDateTime::class.java)
        }!!
        if (game.closed == null && writer.first != sessionId) {
            if (writer.first != null) fail("GAME_ACTIVE_ELSEWHERE", "Игра активна на другом устройстве")
            // First live write after an upgrade elects one old session, under the user lock.
            c.update("UPDATE game_sessions SET closed_at=COALESCE(closed_at,?) WHERE user_id=? AND id<>?", instant, actor.id, sessionId)
            c.update("UPDATE game_profiles SET writer_session_id=?,writer_until=? WHERE user_id=?", sessionId, minOf(instant.plusSeconds(30),game.expires), actor.id)
        }
        val cutoff = minOf(game.expires, game.closed ?: game.expires).toInstant().toEpochMilli()
        val nowMs = instant.toInstant().toEpochMilli()
        val createdMs = game.created.toInstant().toEpochMilli() + if (game.created.nano % 1_000_000 == 0) 0 else 1
        val earliest = game.eventUpdated?.toInstant()?.toEpochMilli() ?: createdMs
        var eventTokens = game.eventTokens
        var eventAt = earliest
        val validTimes = tapTimes?.map { if (game.sequence == 0L && it >= createdMs - 8_000) maxOf(createdMs, it) else it }
            ?.filter { it >= earliest && it < cutoff && it <= nowMs + 2_000 && nowMs - it <= 86_400_000 }
        // A closed permit cannot farm the same past instant with fresh sequences.
        val eligible = validTimes?.filter { at ->
            eventTokens = minOf(BUCKET_CAPACITY, eventTokens + (at - eventAt).coerceAtLeast(0) * TAPS_PER_SECOND / 1000)
            eventAt = maxOf(eventAt, at)
            if (eventTokens >= 1) { eventTokens -= 1; true } else false
        }
        val eligibleCount = eligible?.size ?: tapCount
        val eventStart = eligible?.firstOrNull()?.let { java.time.Instant.ofEpochMilli(it).atOffset(ZoneOffset.UTC) } ?: instant
        val eventEnd = eligible?.lastOrNull()?.let { java.time.Instant.ofEpochMilli(it).atOffset(ZoneOffset.UTC) } ?: instant
        val rejectionCode = if (validTimes != null && validTimes.size < tapCount) "GAME_PERMIT_CLOSED" else if (eligibleCount < tapCount) "GAME_TAP_RATE" else null
        if (game.closed == null && game.expires.isAfter(instant)) {
            c.update("UPDATE game_profiles SET writer_until=? WHERE user_id=? AND writer_session_id=?", minOf(instant.plusSeconds(30), game.expires), actor.id, sessionId)
        }
        data class Budget(val tokens: Double, val updated: OffsetDateTime, val lifetime: Long)
        val bucket = c.one("SELECT bucket_tokens,bucket_updated_at,lifetime_taps FROM game_profiles WHERE user_id=? FOR UPDATE", actor.id) {
            Budget(it.getDouble(1), it.getObject(2, OffsetDateTime::class.java), it.getLong(3))
        } ?: error("Game session without profile")
        val elapsed = Duration.between(bucket.updated, instant).toNanos().coerceAtLeast(0).toDouble() / 1_000_000_000.0
        val available = minOf(BUCKET_CAPACITY, bucket.tokens + elapsed * TAPS_PER_SECOND)
        if (tapTimes != null && eligibleCount > floor(available).toInt()) fail("GAME_PACING", "Очередь сохранена. Продолжаем отправку через несколько секунд", 429)
        val accepted = minOf(eligibleCount, floor(available).toInt(), (MAX_SAFE_INTEGER - bucket.lifetime).coerceAtMost(MAX_BATCH_TAPS.toLong()).toInt())
        // Transport-session renewal must not split an uninterrupted run. Inherit at
        // most one expired predecessor from this authenticated device, never an active
        // parallel session. The user lock serializes this one-use continuation claim.
        val predecessor = if (accepted > 0 && game.runId == null) c.one("""
            SELECT * FROM game_sessions WHERE user_id=? AND auth_session_id=? AND id<>?
                AND expires_at<=? AND run_id=? AND NOT continuation_claimed
                AND run_updated_at BETWEEN ?::timestamptz - interval '12 seconds' AND ?
            ORDER BY run_updated_at DESC,expires_at DESC,id DESC LIMIT 1 FOR UPDATE
        """.trimIndent(), actor.id, actor.authSessionId, sessionId, instant, runId, eventStart, eventStart, map = ::sessionRow) else null
        val priorRun = predecessor ?: game
        val continuing = gameRunContinues(priorRun.runId, runId, priorRun.runUpdatedAt, eventStart)
        var runTaps = if (accepted == 0) game.runTaps else if (continuing) minOf(MAX_SAFE_INTEGER, priorRun.runTaps + accepted) else accepted.toLong()
        var bestRun = runTaps
        if (eligible != null && accepted > 0) {
            runTaps = if (continuing) priorRun.runTaps else 0L
            var previousAt = if (continuing) priorRun.runUpdatedAt?.toInstant()?.toEpochMilli() else null
            bestRun = runTaps
            for (at in eligible.take(accepted)) {
                if (previousAt != null && at - previousAt > 12_000) runTaps = 0L
                runTaps = minOf(MAX_SAFE_INTEGER, runTaps + 1)
                bestRun = maxOf(bestRun, runTaps)
                previousAt = at
            }
        }
        if (predecessor != null) c.update("UPDATE game_sessions SET continuation_claimed=true WHERE id=?", predecessor.id)
        c.update("""
            UPDATE game_profiles SET lifetime_taps=lifetime_taps+?,best_series=GREATEST(best_series,?),
                bucket_tokens=?,bucket_updated_at=GREATEST(bucket_updated_at,?),updated_at=? WHERE user_id=?
        """.trimIndent(), accepted, bestRun, available - accepted, instant, instant, actor.id)
        if (bucket.lifetime < 1000 && bucket.lifetime + accepted >= 1000) {
            recordGameAchievement(c, actor.id, "thousand_taps", instant)
        }
        if (accepted > 0 && bestRun >= 10000) recordGameAchievement(c, actor.id, "ten_thousand_series", instant)
        if (accepted > 0) c.update("""
            INSERT INTO game_monthly_scores(user_id,month,taps,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(user_id,month) DO UPDATE SET taps=LEAST(9007199254740991,game_monthly_scores.taps+EXCLUDED.taps),updated_at=EXCLUDED.updated_at
        """.trimIndent(), actor.id, game.month, accepted, instant)
        c.update("""
            UPDATE game_sessions SET last_sequence=?,last_tap_count=?,last_accepted=?,last_run_id=?,last_batch_at=?,run_taps=?,run_id=?,run_updated_at=?,last_tap_times=?,last_rejection_code=?,event_tokens=?,event_updated_at=? WHERE id=?
        """.trimIndent(), sequence, tapCount, accepted, runId, instant, runTaps, if (accepted > 0) runId else game.runId, if (accepted > 0) eventEnd else game.runUpdatedAt, tapTimes?.let { c.createArrayOf("bigint", it.toTypedArray()) }, rejectionCode, eventTokens, if (validTimes?.isNotEmpty() == true) java.time.Instant.ofEpochMilli(eventAt).atOffset(ZoneOffset.UTC) else game.eventUpdated, sessionId)
        creditWorldTaps(c, actor.id, "tap:$sessionId:$sequence", accepted, instant)
        recordTapActivity(c, actor.id, instant, accepted, tapCount-accepted, eligible?.take(accepted),
            if(continuing) priorRun.runUpdatedAt?.toInstant()?.toEpochMilli() else null)
        GameBatchResponse(sessionId.toString(), sequence, accepted, tapCount - accepted, false, progress(c, actor, instant), if (accepted > 0 || game.runId == runId) runTaps else 0L, rejectionCode)
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
    override suspend fun leaderboard(sessionHash: ByteArray, scope: String, metric: String): GameLeaderboard = tx { c ->
        if (scope !in setOf("global", "friends")) fail("INVALID_GAME_SCOPE", "Выберите общий рейтинг или рейтинг друзей", 400)
        if (metric !in setOf("monthly_taps", "best_series")) fail("INVALID_GAME_METRIC", "Выберите вид рейтинга", 400)
        val actor = lockActor(c, sessionHash)
        val instant = now(c)
        val current = progress(c, actor, instant)
        val score = if (metric == "best_series") "p.best_series" else "COALESCE(m.taps,0)"
        val place = if (metric == "best_series") "rank() OVER (ORDER BY $score DESC)" else "row_number() OVER (ORDER BY $score DESC,m.updated_at,u.id)"
        val ranked = c.rows("""
            WITH eligible AS (
                SELECT $place AS place, row_number() OVER (ORDER BY $score DESC,${if (metric == "monthly_taps") "m.updated_at," else ""}u.id) AS position,
                       u.display_name,u.tag_text,u.tag_color,$score AS score,u.id=? AS is_me
                FROM game_profiles p JOIN app_users u ON u.id=p.user_id
                LEFT JOIN game_monthly_scores m ON m.user_id=u.id AND m.month=?
                WHERE $score>0 AND p.leaderboard_opt_in AND u.deleted_at IS NULL AND u.banned_at IS NULL
                  AND (?='global' OR u.id=? OR u.id IN (SELECT user_id FROM active_direct_friend_ids(?)))
            ) SELECT place,display_name,score,is_me,position,tag_text,tag_color FROM eligible WHERE position<=100 OR is_me ORDER BY position
        """.trimIndent(), actor.id, month(instant), scope, actor.id, actor.id) {
            it.getLong(5) to GameLeaderboardEntry(it.getLong(1), it.getString(2), it.getLong(3), it.getBoolean(4), tag=it.playerTag())
        }
        GameLeaderboard(actor.publicId, current.month, current.serverTime, ranked.filter { it.first <= 100 }.map { it.second },
            ranked.firstOrNull { it.second.isMe }?.second?.rank, current.monthlyTaps, current.leaderboardOptIn, scope, metric, current.bestSeries)
    }

    override suspend fun achievements(sessionHash: ByteArray): GameAchievements = tx { c ->
        val actor = lockActor(c, sessionHash)
        val instant = now(c)
        recordSecurityAchievements(c, actor.id)
        val awards = c.rows("""
            WITH targets(id,target,position) AS (VALUES
                ('seven_day_streak',7::bigint,1),('thousand_taps',1000::bigint,2),('five_friends',5::bigint,3),
                ('ten_thousand_series',10000::bigint,4),('linked_email',1::bigint,5),('saved_recovery_code',1::bigint,6))
            SELECT t.id,t.target,a.unlocked_at,
                   CASE WHEN a.unlocked_at IS NOT NULL THEN t.target ELSE LEAST(t.target,CASE t.id
                       WHEN 'ten_thousand_series' THEN COALESCE((SELECT best_series FROM game_profiles WHERE user_id=?),0)
                       WHEN 'seven_day_streak' THEN (SELECT longest_days FROM rolling_check_in_streak(?,?))
                       WHEN 'linked_email' THEN 0
                       WHEN 'saved_recovery_code' THEN 0
                       WHEN 'thousand_taps' THEN COALESCE((SELECT lifetime_taps FROM game_profiles WHERE user_id=?),0)
                       ELSE (SELECT count(*) FROM (SELECT user_id FROM active_direct_friend_ids(?) LIMIT 5) friends)
                   END) END AS progress
            FROM targets t LEFT JOIN game_achievements a ON a.user_id=? AND a.achievement_id=t.id
            ORDER BY t.position
        """.trimIndent(), actor.id, actor.id, instant, actor.id, actor.id, actor.id) {
            GameAchievement(it.getString("id"), it.getLong("progress"), it.getLong("target"),
                it.getObject("unlocked_at", OffsetDateTime::class.java)?.toInstant()?.toString())
        }
        // A previous API instance may have accepted progress after V21's backfill
        // during a rolling upgrade. Reconcile only verified server values, under
        // the same user lock as the qualifying writes; preserve any existing date.
        val reconciled = awards.map { award ->
            if (award.unlockedAt != null || award.progress < award.target) award else {
                recordGameAchievement(c, actor.id, award.id, instant)
                val unlockedAt = c.one("SELECT unlocked_at FROM game_achievements WHERE user_id=? AND achievement_id=?", actor.id, award.id) {
                    it.getObject(1, OffsetDateTime::class.java).toInstant().toString()
                } ?: error("Achievement reconciliation did not persist its award")
                award.copy(unlockedAt = unlockedAt)
            }
        }
        GameAchievements(actor.publicId, instant.toInstant().toString(), reconciled)
    }
}

internal fun gameRunContinues(previousRunId: UUID?, runId: UUID, previousAt: OffsetDateTime?, now: OffsetDateTime): Boolean =
    previousRunId == runId && previousAt != null && Duration.between(previousAt, now).toMillis() in 0L..12_000L
