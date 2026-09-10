package ru.zhiv.db

import ru.zhiv.identity.PlayerTag
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.admin.*
import ru.zhiv.world.*
import ru.zhiv.auth.AuthFailure
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

/** Every entry point authenticates a live session against the server-owned allowlist. */
class JdbcAdminRepository(private val source: DataSource, private val config: AdminConfig) : AdminRepository {
    private data class Actor(val id: UUID, val publicId: String, val displayName: String)
    private fun fail(code: String, message: String, status: Int): Nothing = throw AuthFailure(code, message, status)
    private fun invalid(): Nothing = fail("INVALID_ADMIN_QUERY", "Проверьте параметры запроса", 400)
    private fun Connection.update(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { s ->
        values.forEachIndexed { i, value -> s.setObject(i + 1, value) }; s.executeUpdate()
    }
    private fun <T> Connection.rows(sql: String, vararg values: Any?, map: (ResultSet) -> T): List<T> = prepareStatement(sql).use { s ->
        values.forEachIndexed { i, value -> s.setObject(i + 1, value) }
        s.executeQuery().use { r -> buildList { while (r.next()) add(map(r)) } }
    }
    private fun <T> Connection.one(sql: String, vararg values: Any?, map: (ResultSet) -> T): T? = rows(sql, *values, map = map).firstOrNull()
    private fun Connection.count(sql: String, vararg values: Any?): Long = one(sql, *values) { it.getLong(1) } ?: 0L
    private fun ResultSet.time(column: String): String? = getObject(column, OffsetDateTime::class.java)?.toInstant()?.toString()
    private suspend fun <T> tx(block: (Connection) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit = false
            try {
                c.update("SET LOCAL statement_timeout = '8s'")
                c.update("SET LOCAL lock_timeout = '3s'")
                val result = block(c)
                c.commit()
                result
            } catch (e: Exception) { c.rollback(); throw e }
        }
    }
    private fun actor(c: Connection, hash: ByteArray, lockSession: Boolean = false): Actor {
        val result = c.one("""
            SELECT u.id, u.public_id, u.display_name FROM app_sessions s JOIN app_users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.deleted_at IS NULL AND u.banned_at IS NULL
            ${if (lockSession) "FOR UPDATE OF s" else ""}
        """.trimIndent(), hash) { Actor(it.getObject(1, UUID::class.java), it.getString(2), it.getString(3)) }
            ?: fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
        if (result.publicId !in config.allowedPublicIds) fail("ADMIN_FORBIDDEN", "Нет доступа к панели управления", 403)
        return result
    }
    private fun now(c: Connection): OffsetDateTime = c.one("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java) }!!
    private fun pagination(offset: Int, limit: Int) { if (offset !in 0..100_000 || limit !in 1..100) invalid() }

    override suspend fun access(sessionHash: ByteArray): AdminAccess = tx { c ->
        val actor = actor(c, sessionHash)
        AdminAccess(actor.publicId, actor.displayName, now(c).toInstant().toString())
    }

    override suspend fun overview(sessionHash: ByteArray, days: Int): AdminOverview = tx { c ->
        actor(c, sessionHash)
        if (days !in setOf(7, 30, 90)) invalid()
        val now = now(c).withOffsetSameInstant(ZoneOffset.UTC)
        val today = now.toLocalDate()
        val firstDay = today.minusDays(days.toLong() - 1)
        val start = firstDay.atStartOfDay().atOffset(ZoneOffset.UTC)
        val month = today.withDayOfMonth(1)
        val totals = AdminTotals(
            users = c.count("SELECT count(*) FROM app_users WHERE deleted_at IS NULL"),
            checkIns = c.count("SELECT count(*) FROM check_ins WHERE checked_at<=?", now),
            connections = c.count("SELECT count(*) FROM circles WHERE kind='DIRECT' AND archived_at IS NULL"),
            groups = c.count("SELECT count(*) FROM circles WHERE kind='GROUP' AND archived_at IS NULL"),
            lifetimeTaps = c.count("SELECT COALESCE(sum(lifetime_taps),0) FROM game_profiles"),
        )
        val active = c.one("""
            SELECT count(DISTINCT user_id) FILTER (WHERE checked_at>=? - interval '24 hours'),
                   count(DISTINCT user_id) FILTER (WHERE checked_at>=? - interval '7 days'), count(DISTINCT user_id)
            FROM check_ins WHERE checked_at>=? - interval '30 days' AND checked_at<=?
        """.trimIndent(), now, now, now, now) { AdminActiveUsers(it.getLong(1), it.getLong(2), it.getLong(3)) }!!
        val daily = c.rows("""
            WITH days AS (SELECT ?::date + i AS day FROM generate_series(0, ?::integer - 1) i),
            registrations AS (
                SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
                FROM app_users WHERE created_at>=? AND created_at<=? GROUP BY 1
            ), activity AS (
                SELECT (checked_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n, count(DISTINCT user_id) AS users
                FROM check_ins WHERE checked_at>=? AND checked_at<=? GROUP BY 1
            )
            SELECT d.day, COALESCE(r.n,0), COALESCE(a.users,0), COALESCE(a.n,0)
            FROM days d LEFT JOIN registrations r ON r.day=d.day LEFT JOIN activity a ON a.day=d.day ORDER BY d.day
        """.trimIndent(), firstDay, days, start, now, start, now) { AdminDaily(it.getString(1), it.getLong(2), it.getLong(3), it.getLong(4)) }
        fun retention(distance: Int): AdminRetentionRate = c.one("""
            WITH cohort AS (
                SELECT id, (created_at AT TIME ZONE 'UTC')::date + ?::integer AS target_day
                FROM app_users WHERE created_at>=? AND (created_at AT TIME ZONE 'UTC')::date + ?::integer < ?::date
            ), returned AS (
                SELECT id, EXISTS(
                    SELECT 1 FROM check_ins ci WHERE ci.user_id=cohort.id
                      AND ci.checked_at >= (cohort.target_day::timestamp AT TIME ZONE 'UTC')
                      AND ci.checked_at < ((cohort.target_day+1)::timestamp AT TIME ZONE 'UTC')
                ) AS did_return FROM cohort
            ) SELECT count(*), count(*) FILTER (WHERE did_return) FROM returned
        """.trimIndent(), distance, start, distance, today) {
            val eligible = it.getLong(1); val returned = it.getLong(2)
            AdminRetentionRate(eligible, returned, if (eligible == 0L) null else returned.toDouble() * 100.0 / eligible)
        }!!
        val game = AdminGame(
            month = month.toString().take(7),
            taps = c.count("SELECT COALESCE(sum(taps),0) FROM game_monthly_scores WHERE month=?", month),
            bestSeries = c.count("SELECT COALESCE(max(best_series),0) FROM game_profiles"),
            participants = c.count("SELECT count(*) FROM game_monthly_scores WHERE month=? AND taps>0", month),
            achievements = c.count("SELECT count(*) FROM game_achievements"),
        )
        val services = AdminServices(
            databaseReady = true,
            databaseBytes = c.count("SELECT pg_database_size(current_database())"),
            databaseConnections = c.count("SELECT numbackends FROM pg_stat_database WHERE datname=current_database()"),
            activeSessions = c.count("""
                SELECT count(*) FROM app_sessions s JOIN app_users u ON u.id=s.user_id
                WHERE s.revoked_at IS NULL AND s.expires_at>? AND u.deleted_at IS NULL
            """.trimIndent(), now),
        )
        AdminOverview(now.toInstant().toString(), days, totals, active, daily.sumOf { it.registrations },
            daily.sumOf { it.checkIns }, AdminRetention(retention(1), retention(7)), daily, game, services)
    }

    override suspend fun users(sessionHash: ByteArray, query: String, sort: String, offset: Int, limit: Int): AdminUsers = tx { c ->
        actor(c, sessionHash)
        pagination(offset, limit)
        if (query.length > 100 || query.any(Char::isISOControl)) invalid()
        val order = when (sort) {
            "review" -> "u.tap_signal_at DESC NULLS LAST, u.tap_watchlisted DESC, u.created_at DESC, u.id"
            "created" -> "u.created_at DESC, u.id"
            "activity" -> "u.last_check_in_at DESC NULLS LAST, u.created_at DESC, u.id"
            "taps" -> "COALESCE(g.lifetime_taps,0) DESC, u.created_at DESC, u.id"
            else -> invalid()
        }
        val now = now(c).withOffsetSameInstant(ZoneOffset.UTC)
        val search = query.trim()
        val where = "u.deleted_at IS NULL AND (?='' OR position(lower(?) in lower(u.display_name))>0 OR position(upper(?) in u.public_id)>0)"
        val total = c.count("SELECT count(*) FROM app_users u WHERE $where", search, search, search)
        val users = c.rows("""
            WITH page AS (
                SELECT u.*, COALESCE(g.lifetime_taps,0) AS lifetime_taps, COALESCE(g.best_series,0) AS best_series,
                       COALESCE(g.leaderboard_opt_in,false) AS leaderboard_opt_in
                FROM app_users u LEFT JOIN game_profiles g ON g.user_id=u.id
                WHERE $where ORDER BY $order LIMIT ? OFFSET ?
            )
            SELECT p.*, summary.check_in_count,
                   (SELECT count(*) FROM active_direct_friend_ids(p.id)) AS friend_count,
                   COALESCE((SELECT taps FROM game_monthly_scores WHERE user_id=p.id AND month=?),0) AS monthly_taps,
                   (SELECT count(*) FROM app_sessions WHERE user_id=p.id AND revoked_at IS NULL AND expires_at>?) AS active_sessions,
                   ARRAY(SELECT provider FROM account_login_identities WHERE user_id=p.id ORDER BY provider) AS login_methods
            FROM page p CROSS JOIN LATERAL account_check_in_summary(p.id) summary
            ORDER BY ${order.replace("u.", "p.").replace("COALESCE(g.lifetime_taps,0)", "p.lifetime_taps")}
        """.trimIndent(), search, search, search, limit, offset, now.toLocalDate().withDayOfMonth(1), now) { r ->
            AdminUser(r.getString("public_id"), r.getString("display_name"), r.time("created_at")!!, r.time("last_check_in_at"),
                r.getLong("check_in_count"), r.getLong("friend_count"), r.getLong("lifetime_taps"), r.getLong("best_series"),
                r.getLong("monthly_taps"), r.getBoolean("leaderboard_opt_in"), r.getLong("active_sessions"),
                (r.getArray("login_methods").array as Array<*>).map { it.toString() }, r.getString("public_id") in config.allowedPublicIds,
                r.getString("tag_text")?.let { PlayerTag(it, r.getString("tag_color")) }, r.time("banned_at"), r.getBoolean("tap_watchlisted"), r.time("tap_signal_at"))
        }
        AdminUsers(now.toInstant().toString(), total, offset, limit, users)
    }

    override suspend fun revokeSessions(sessionHash: ByteArray, targetPublicId: String, requestId: UUID, confirmationPublicId: String, reason: String): AdminRevokeReceipt = tx { c ->
        val initial = actor(c, sessionHash)
        if (confirmationPublicId != targetPublicId || reason.length !in 8..240 || reason != reason.trim() || reason.any(Char::isISOControl) || requestId.version() != 4 || requestId.variant() != 2) invalid()
        if (targetPublicId in config.allowedPublicIds) fail("ADMIN_PROTECTED_ACCOUNT", "Сеансы администраторов нельзя завершать из панели", 409)
        // A request ID is global and immutable. Serialize unknown receipts before
        // locking users, so duplicate delivery can never revoke a later login.
        c.one("SELECT pg_advisory_xact_lock(?)", requestId.mostSignificantBits xor requestId.leastSignificantBits) { true }
        val previous = c.one("SELECT * FROM admin_actions WHERE request_id=?", requestId) { r ->
            AdminAuditEvent(r.getObject("request_id").toString(), r.getString("actor_public_id"), r.getString("target_public_id"),
                r.getString("action"), r.getString("reason"), r.getInt("affected_sessions"), r.time("created_at")!!,
                r.getString("reward_id"), r.getObject("granted") as Boolean?)
        }
        if (previous != null) {
            c.one("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", initial.id) { true }
            val current = actor(c, sessionHash, lockSession = true)
            if (current.publicId != previous.actorPublicId || targetPublicId != previous.targetPublicId || reason != previous.reason || previous.action != "revoke_sessions") {
                fail("ADMIN_REQUEST_CONFLICT", "Этот запрос уже использован с другими параметрами", 409)
            }
            return@tx AdminRevokeReceipt(previous.requestId, previous.affectedSessions, previous.createdAt)
        }
        val target = c.one("SELECT id FROM app_users WHERE public_id=? AND deleted_at IS NULL", targetPublicId) { it.getObject(1, UUID::class.java) }
            ?: fail("ADMIN_USER_NOT_FOUND", "Профиль не найден", 404)
        c.rows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE", initial.id, target) { it.getObject(1, UUID::class.java) }
        val current = actor(c, sessionHash, lockSession = true)
        if (current.id != initial.id) fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
        val stillPresent = c.one("SELECT public_id FROM app_users WHERE id=? AND deleted_at IS NULL", target) { it.getString(1) }
            ?: fail("ADMIN_USER_NOT_FOUND", "Профиль не найден", 404)
        if (stillPresent in config.allowedPublicIds || current.id == target) fail("ADMIN_PROTECTED_ACCOUNT", "Сеансы администраторов нельзя завершать из панели", 409)
        val affected = c.update("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE user_id=? AND revoked_at IS NULL AND expires_at>clock_timestamp()", target)
        c.one("""
            INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,action,reason,affected_sessions)
            VALUES (?,?,?,?,?,'revoke_sessions',?,?) RETURNING created_at
        """.trimIndent(), requestId, current.id, target, current.publicId, targetPublicId, reason, affected) {
            AdminRevokeReceipt(requestId.toString(), affected, it.time("created_at")!!)
        }!!
    }

    override suspend fun rewards(sessionHash: ByteArray, targetPublicId: String): AdminRewards = tx { c ->
        actor(c, sessionHash)
        val target = c.one("SELECT id FROM app_users WHERE public_id=? AND deleted_at IS NULL FOR NO KEY UPDATE", targetPublicId) { it.getObject(1, UUID::class.java) }
            ?: fail("ADMIN_USER_NOT_FOUND", "Профиль не найден", 404)
        actor(c, sessionHash)
        val instant = now(c)
        recordMergedAchievements(c,target,instant)
        AdminRewards(targetPublicId,
            c.rows("SELECT item_id FROM game_items WHERE user_id=? ORDER BY item_id",target) { it.getString(1) },
            c.rows("SELECT achievement_id FROM game_achievements WHERE user_id=? ORDER BY achievement_id",target) { it.getString(1) }
                .filter { it in ru.zhiv.game.GameRewards.achievements },
            instant.toInstant().toString())
    }

    override suspend fun grantReward(sessionHash: ByteArray, targetPublicId: String, requestId: UUID, request: AdminGrantRequest): AdminGrantReceipt = tx { c ->
        val initial = actor(c, sessionHash)
        val (confirmation,kind,rewardId,reason) = listOf(request.confirmationPublicId,request.kind,request.rewardId,request.reason)
        val catalog = when (kind) { "item" -> ru.zhiv.game.GameRewards.items; "achievement" -> ru.zhiv.game.GameRewards.achievements; else -> invalid() }
        if (confirmation != targetPublicId || request.requestId != requestId.toString()
            || reason.length !in 8..240 || reason != reason.trim() || reason.any(Char::isISOControl)
            || requestId.version() != 4 || requestId.variant() != 2) invalid()
        val action = "grant_$kind"
        c.one("SELECT pg_advisory_xact_lock(?)", requestId.mostSignificantBits xor requestId.leastSignificantBits) { true }
        val previous = c.one("SELECT * FROM admin_actions WHERE request_id=?",requestId) { r ->
            AdminAuditEvent(r.getObject("request_id").toString(),r.getString("actor_public_id"),r.getString("target_public_id"),
                r.getString("action"),r.getString("reason"),r.getInt("affected_sessions"),r.time("created_at")!!,
                r.getString("reward_id"),r.getObject("granted") as Boolean?)
        }
        if (previous != null) {
            c.one("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",initial.id) { true }
            val current = actor(c,sessionHash,lockSession=true)
            if (current.publicId != previous.actorPublicId || targetPublicId != previous.targetPublicId || action != previous.action
                || rewardId != previous.rewardId || reason != previous.reason) fail("ADMIN_REQUEST_CONFLICT","Этот запрос уже использован с другими параметрами",409)
            return@tx AdminGrantReceipt(requestId.toString(),kind,rewardId,checkNotNull(previous.granted),previous.createdAt)
        }
        if (rewardId !in catalog) invalid()
        val target = c.one("SELECT id FROM app_users WHERE public_id=? AND deleted_at IS NULL",targetPublicId) { it.getObject(1,UUID::class.java) }
            ?: fail("ADMIN_USER_NOT_FOUND","Профиль не найден",404)
        c.rows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE",initial.id,target) { it.getObject(1,UUID::class.java) }
        val current = actor(c,sessionHash,lockSession=true)
        if (current.id != initial.id) fail("UNAUTHORIZED","Войдите в профиль ещё раз",401)
        if (c.one("SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL",target) { true } != true)
            fail("ADMIN_USER_NOT_FOUND","Профиль не найден",404)
        val instant = now(c)
        recordMergedAchievements(c,target,instant)
        // Only the validated catalog selects the table. Counters and ranking consent stay authoritative.
        val table = if (kind == "item") "game_items" else "game_achievements"
        val column = if (kind == "item") "item_id" else "achievement_id"
        val granted = c.update("INSERT INTO $table(user_id,$column,unlocked_at) VALUES (?,?,?) ON CONFLICT DO NOTHING",target,rewardId,instant)>0
        c.one("""
            INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,action,reason,affected_sessions,reward_id,granted)
            VALUES (?,?,?,?,?,?,?,0,?,?) RETURNING created_at
        """.trimIndent(),requestId,current.id,target,current.publicId,targetPublicId,action,reason,rewardId,granted) {
            AdminGrantReceipt(requestId.toString(),kind,rewardId,granted,it.time("created_at")!!)
        }!!
    }

    override suspend fun audit(sessionHash: ByteArray, offset: Int, limit: Int): AdminAudit = tx { c ->
        actor(c, sessionHash); pagination(offset, limit)
        val now = now(c)
        val total = c.count("SELECT count(*) FROM admin_actions")
        val events = c.rows("SELECT * FROM admin_actions ORDER BY created_at DESC,request_id LIMIT ? OFFSET ?", limit, offset) { r ->
            AdminAuditEvent(r.getObject("request_id").toString(), r.getString("actor_public_id"), r.getString("target_public_id"),
                r.getString("action"), r.getString("reason"), r.getInt("affected_sessions"), r.time("created_at")!!,
                r.getString("reward_id"), r.getObject("granted") as Boolean?, r.getString("payload"))
        }
        AdminAudit(now.toInstant().toString(), total, offset, limit, events)
    }

    override suspend fun player(sessionHash: ByteArray, targetPublicId: String): AdminPlayer = tx { c ->
        actor(c, sessionHash)
        c.one("""SELECT u.*,w.state,w.revision,clock_timestamp() AS server_time FROM app_users u
            LEFT JOIN world_profiles w ON w.user_id=u.id WHERE u.public_id=? AND u.deleted_at IS NULL""", targetPublicId) { r ->
            AdminPlayer(targetPublicId, r.getString("display_name"),
                r.getString("tag_text")?.let { PlayerTag(it,r.getString("tag_color")) },r.time("banned_at"),
                r.getString("ban_reason"),r.getBoolean("tap_watchlisted"),
                r.getString("state")?.let { worldJson.decodeFromString<WorldState>(it) } ?: WorldState(),
                r.getLong("revision"),r.time("server_time")!!,r.time("tap_signal_at"))
        } ?: fail("ADMIN_USER_NOT_FOUND","Профиль не найден",404)
    }

    override suspend fun managePlayer(sessionHash: ByteArray, targetPublicId: String, requestId: UUID, request: AdminPlayerCommand): AdminPlayerReceipt = tx { c ->
        val initial = actor(c,sessionHash)
        if (!PlayerManagement.valid(request) || request.confirmationPublicId != targetPublicId || request.requestId != requestId.toString()
            || requestId.version()!=4 || requestId.variant()!=2) invalid()
        val payload = worldJson.encodeToString(request)
        c.one("SELECT pg_advisory_xact_lock(?)",requestId.mostSignificantBits xor requestId.leastSignificantBits) { true }
        val previous = c.one("SELECT *,payload=?::jsonb AS same_payload FROM admin_actions WHERE request_id=?",payload,requestId) { r ->
            Triple(r.getString("actor_public_id") == initial.publicId && r.getString("target_public_id")==targetPublicId && r.getBoolean("same_payload"),
                r.getString("action"),AdminPlayerReceipt(requestId.toString(),r.getString("action"),r.getBoolean("changed"),r.getInt("affected_sessions"),r.time("created_at")!!))
        }
        if (previous != null) {
            c.one("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",initial.id) { true }
            val current = actor(c,sessionHash,lockSession=true)
            if (current.id != initial.id || !previous.first || previous.second != request.action)
                fail("ADMIN_REQUEST_CONFLICT","Этот запрос уже использован с другими параметрами",409)
            return@tx previous.third
        }
        val target = c.one("SELECT id FROM app_users WHERE public_id=? AND deleted_at IS NULL",targetPublicId) { it.getObject(1,UUID::class.java) }
            ?: fail("ADMIN_USER_NOT_FOUND","Профиль не найден",404)
        c.rows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE",initial.id,target) { true }
        val current = actor(c,sessionHash,lockSession=true)
        if (current.id != initial.id) fail("UNAUTHORIZED","Войдите в профиль ещё раз",401)
        if (c.one("SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL",target) { true } != true)
            fail("ADMIN_USER_NOT_FOUND","Профиль не найден",404)
        if (request.action in setOf("ban","unban") && (targetPublicId in config.allowedPublicIds || target==current.id))
            fail("ADMIN_PROTECTED_ACCOUNT","Администраторов нельзя блокировать из панели",409)
        var affected = 0
        val changed = when(request.action) {
            "ban" -> {
                val updated = c.update("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason=? WHERE id=? AND banned_at IS NULL",request.reason,target)>0
                affected = c.update("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE user_id=? AND revoked_at IS NULL",target)
                c.update("UPDATE game_sessions SET closed_at=COALESCE(closed_at,clock_timestamp()) WHERE user_id=?",target)
                updated
            }
            "unban" -> c.update("UPDATE app_users SET banned_at=NULL,ban_reason=NULL WHERE id=? AND banned_at IS NOT NULL",target)>0
            "clear_signal" -> c.update("UPDATE app_users SET tap_signal_at=NULL WHERE id=? AND tap_signal_at IS NOT NULL",target)>0
            "watch", "unwatch" -> c.update("UPDATE app_users SET tap_watchlisted=? WHERE id=? AND tap_watchlisted<>?",request.action=="watch",target,request.action=="watch")>0
            "set_tag" -> c.update("""UPDATE app_users SET tag_text=?,tag_color=? WHERE id=?
                AND (tag_text IS DISTINCT FROM ?::text OR tag_color IS DISTINCT FROM ?::text)""",
                request.tag?.text,request.tag?.color,target,request.tag?.text,request.tag?.color)>0
            else -> {
                c.update("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb) ON CONFLICT DO NOTHING",target,worldJson.encodeToString(WorldState()))
                val before = c.one("SELECT state FROM world_profiles WHERE user_id=?",target) { worldJson.decodeFromString<WorldState>(it.getString(1)) }!!
                val after = when(request.action) {
                    "grant_resource" -> {
                        val r=before.resources
                        fun add(value: Long): Long {
                            if(value > 9_007_199_254_740_991L - request.amount) fail("ADMIN_RESOURCE_LIMIT","Достигнут предел ресурсов",409)
                            return value + request.amount
                        }
                        before.copy(resources=when(request.target) {
                            "sparks" -> r.copy(sparks=add(r.sparks))
                            "wood" -> r.copy(wood=add(r.wood))
                            else -> r.copy(stone=add(r.stone))
                        })
                    }
                    "grant_world_item" -> if(request.target in before.inventory) before else before.copy(inventory=(before.inventory+request.target).sorted())
                    "grant_find" -> {
                        val collection=if(request.target in before.collection) before.collection else (before.collection+request.target).sorted()
                        val completed=WorldRules.catalog.finds.all { it.id in collection }
                        before.copy(collection=collection,inventory=if(completed && "explorer_cap" !in before.inventory) (before.inventory+"explorer_cap").sorted() else before.inventory)
                    }
                    else -> invalid()
                }
                if(after!=before) {
                    c.update("UPDATE world_profiles SET state=?::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=?",worldJson.encodeToString(after),target)
                    c.update("INSERT INTO world_ledger(user_id,source_key,kind,sparks,wood,stone) VALUES (?,?,'admin_grant',?,?,?)",
                        target,"admin:$requestId",after.resources.sparks-before.resources.sparks,after.resources.wood-before.resources.wood,after.resources.stone-before.resources.stone)
                }
                after!=before
            }
        }
        c.one("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,action,reason,affected_sessions,payload,changed)
            VALUES (?,?,?,?,?,?,?,?,?::jsonb,?) RETURNING created_at""",
            requestId,current.id,target,current.publicId,targetPublicId,request.action,request.reason,affected,payload,changed) {
            AdminPlayerReceipt(requestId.toString(),request.action,changed,affected,it.time("created_at")!!)
        }!!
    }

    override suspend fun tapActivity(sessionHash: ByteArray, targetPublicId: String): AdminTapActivity = tx { c ->
        actor(c,sessionHash)
        val target=c.one("SELECT id,display_name,tap_watchlisted FROM app_users WHERE public_id=? AND deleted_at IS NULL",targetPublicId) {
            Triple(it.getObject(1,UUID::class.java),it.getString(2),it.getBoolean(3))
        } ?: fail("ADMIN_USER_NOT_FOUND","Профиль не найден",404)
        val instant=now(c).toInstant()
        val samples=c.rows("SELECT * FROM game_tap_activity_seconds WHERE user_id=? AND bucket_at>=? AND bucket_at<=? ORDER BY bucket_at",
            target.first,instant.minusSeconds(1860).atOffset(ZoneOffset.UTC),instant.atOffset(ZoneOffset.UTC)) { r ->
            TapActivitySample(r.getObject("bucket_at",OffsetDateTime::class.java).toEpochSecond(),r.getLong("received_taps"),r.getLong("rejected_taps"),
                r.getLong("event_taps"),r.getLong("delayed_taps"),r.getLong("legacy_taps"),r.getLong("interval_count"),r.getDouble("interval_sum_ms"),r.getDouble("interval_squared_sum_ms"))
        }
        TapActivityAnalyzer.analyze(targetPublicId,target.second,target.third,instant,samples)
    }
}
