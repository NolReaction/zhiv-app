package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.admin.AdminConfig
import ru.zhiv.auth.AuthFailure
import ru.zhiv.feedback.*
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

/** The database transaction serializes submissions across devices, tabs and API replicas. */
class JdbcFeedbackRepository(private val source: DataSource, private val adminConfig: AdminConfig) : FeedbackRepository {
    private data class Actor(val id: UUID, val publicId: String)
    private fun fail(code: String, message: String, status: Int): Nothing = throw AuthFailure(code, message, status)
    private fun conflict(): Nothing = fail("FEEDBACK_REQUEST_CONFLICT", "Повторный запрос содержит другие данные", 409)
    private fun Connection.update(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { statement ->
        values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeUpdate()
    }
    private fun <T> Connection.rows(sql: String, vararg values: Any?, map: (ResultSet) -> T): List<T> = prepareStatement(sql).use { statement ->
        values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeQuery().use { result -> buildList { while (result.next()) add(map(result)) } }
    }
    private fun <T> Connection.one(sql: String, vararg values: Any?, map: (ResultSet) -> T): T? = rows(sql, *values, map = map).firstOrNull()
    private suspend fun <T> transaction(block: (Connection) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { connection ->
            connection.autoCommit = false
            try {
                connection.update("SET LOCAL statement_timeout = '8s'")
                connection.update("SET LOCAL lock_timeout = '5s'")
                val result = block(connection)
                connection.commit()
                result
            } catch (error: Exception) { connection.rollback(); throw error }
        }
    }
    private fun actor(connection: Connection, hash: ByteArray): Actor = connection.one("""
        SELECT u.id, u.public_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND u.deleted_at IS NULL AND u.banned_at IS NULL
          AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    """.trimIndent(), hash) { Actor(it.getObject(1, UUID::class.java), it.getString(2)) }
        ?: fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    private fun lockActor(connection: Connection, hash: ByteArray): Actor {
        val first = actor(connection, hash)
        connection.one("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", first.id) { true }
        // Account merge/deletion uses this same parent-before-child lock order.
        return actor(connection, hash).also { if (it.id != first.id) fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401) }
    }
    private fun requireOwner(actor: Actor, expected: String) {
        if (actor.publicId != expected) fail("FEEDBACK_ACCOUNT_CHANGED", "Открыт другой профиль. Обновите страницу перед отправкой сообщения.", 409)
    }
    private fun adminActor(connection: Connection, hash: ByteArray, lock: Boolean = false): Actor {
        val actor = if (lock) lockActor(connection, hash) else actor(connection, hash)
        if (actor.publicId !in adminConfig.allowedPublicIds) fail("ADMIN_FORBIDDEN", "Нет доступа к панели управления", 403)
        return actor
    }
    private fun now(connection: Connection): OffsetDateTime = connection.one("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java) }!!
    private fun nextAllowed(connection: Connection, owner: UUID): OffsetDateTime? = connection.one(
        "SELECT created_at + interval '24 hours' FROM player_feedback WHERE user_id=? ORDER BY created_at DESC LIMIT 1", owner,
    ) { it.getObject(1, OffsetDateTime::class.java) }

    override suspend fun availability(sessionHash: ByteArray, expectedOwnerPublicId: String): FeedbackAvailability = transaction { connection ->
        val owner = actor(connection, sessionHash)
        requireOwner(owner, expectedOwnerPublicId)
        val now = now(connection)
        val next = nextAllowed(connection, owner.id)?.takeIf { it.isAfter(now) }
        FeedbackAvailability(now.toInstant().toString(), next == null, next?.toInstant()?.toString())
    }

    override suspend fun submit(sessionHash: ByteArray, expectedOwnerPublicId: String, clientRequestId: UUID, category: String, message: String): FeedbackReceipt = transaction { connection ->
        val owner = lockActor(connection, sessionHash)
        requireOwner(owner, expectedOwnerPublicId)
        val text = validatedFeedbackMessage(category, message)
        if (clientRequestId.version() != 4 || clientRequestId.variant() != 2) fail("INVALID_FEEDBACK", "Некорректный идентификатор запроса", 400)
        fun replay(): FeedbackReceipt? = connection.one("SELECT * FROM player_feedback WHERE client_request_id=?", clientRequestId) { row ->
            // Never disclose another account's receipt when request IDs collide.
            if (row.getObject("user_id", UUID::class.java) != owner.id || row.getString("category") != category || row.getString("message") != text) conflict()
            val created = row.getObject("created_at", OffsetDateTime::class.java)
            val next = nextAllowed(connection, owner.id) ?: created.plusHours(24)
            FeedbackReceipt(row.getString("id"), clientRequestId.toString(), created.toInstant().toString(), next.toInstant().toString(), true)
        }
        replay()?.let { return@transaction it }
        val now = now(connection)
        nextAllowed(connection, owner.id)?.takeIf { it.isAfter(now) }?.let { throw FeedbackCooldown(it, now) }
        val id = connection.one("""
            INSERT INTO player_feedback(user_id,client_request_id,category,message,created_at,updated_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(client_request_id) DO NOTHING RETURNING id
        """.trimIndent(), owner.id, clientRequestId, category, text, now, now) { it.getString(1) }
            ?: return@transaction (replay() ?: conflict())
        FeedbackReceipt(id, clientRequestId.toString(), now.toInstant().toString(), now.plusHours(24).toInstant().toString(), false)
    }

    private fun ResultSet.item() = AdminFeedbackItem(
        getString("id"), getString("category"), getString("message"), getString("status"),
        getObject("created_at", OffsetDateTime::class.java).toInstant().toString(),
        getObject("updated_at", OffsetDateTime::class.java).toInstant().toString(),
        getString("public_id"), getString("display_name"),
    )
    private fun item(connection: Connection, id: UUID): AdminFeedbackItem = connection.one("""
        SELECT f.*, u.public_id, u.display_name FROM player_feedback f JOIN app_users u ON u.id=f.user_id WHERE f.id=?
    """.trimIndent(), id) { it.item() } ?: fail("FEEDBACK_NOT_FOUND", "Сообщение не найдено", 404)

    override suspend fun list(sessionHash: ByteArray, status: String, category: String, offset: Int, limit: Int): AdminFeedbackPage = transaction { connection ->
        adminActor(connection, sessionHash)
        if ((status != "all" && status !in FEEDBACK_STATUSES) || (category != "all" && category !in FEEDBACK_CATEGORIES) || offset !in 0..100_000 || limit !in 1..100) {
            fail("INVALID_ADMIN_QUERY", "Проверьте параметры поиска", 400)
        }
        val where = "(?='all' OR f.status=?) AND (?='all' OR f.category=?)"
        val total = connection.one("SELECT count(*) FROM player_feedback f WHERE $where", status, status, category, category) { it.getLong(1) }!!
        val items = connection.rows("""
            SELECT f.*, u.public_id, u.display_name FROM player_feedback f JOIN app_users u ON u.id=f.user_id
            WHERE $where ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?
        """.trimIndent(), status, status, category, category, limit, offset) { it.item() }
        AdminFeedbackPage(now(connection).toInstant().toString(), total, offset, limit, items)
    }

    override suspend fun changeStatus(sessionHash: ByteArray, id: UUID, requestId: UUID, status: String): AdminFeedbackItem = transaction { connection ->
        val actor = adminActor(connection, sessionHash, lock = true)
        if (status !in FEEDBACK_STATUSES || requestId.version() != 4 || requestId.variant() != 2) fail("INVALID_FEEDBACK", "Некорректный статус сообщения", 400)
        connection.one("SELECT id FROM player_feedback WHERE id=? FOR UPDATE", id) { true }
            ?: fail("FEEDBACK_NOT_FOUND", "Сообщение не найдено", 404)
        val inserted = connection.update("""
            INSERT INTO player_feedback_actions(request_id,feedback_id,actor_user_id,status) VALUES (?,?,?,?)
            ON CONFLICT(request_id) DO NOTHING
        """.trimIndent(), requestId, id, actor.id, status)
        if (inserted == 0) {
            connection.one("SELECT * FROM player_feedback_actions WHERE request_id=?", requestId) { row ->
                if (row.getObject("actor_user_id", UUID::class.java) != actor.id || row.getObject("feedback_id", UUID::class.java) != id || row.getString("status") != status) conflict()
            } ?: conflict()
        } else connection.update("UPDATE player_feedback SET status=?, updated_at=clock_timestamp() WHERE id=?", status, id)
        item(connection, id)
    }
}
