package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.forest.*
import ru.zhiv.http.parsePublicId
import java.security.MessageDigest
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

private fun Connection.memoryUpdate(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { statement ->
    values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
    statement.executeUpdate()
}

private fun <T> Connection.memoryRows(sql: String, vararg values: Any?, read: (ResultSet) -> T): List<T> =
    prepareStatement(sql).use { statement ->
        values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeQuery().use { result -> buildList { while (result.next()) add(read(result)) } }
    }

private data class MemoryRow(
    val revision: Long,
    val snapshot: ForestMemoryPayload?,
    val updatedAt: OffsetDateTime?,
    val clientId: UUID?,
    val sessionHash: ByteArray?,
    val token: UUID?,
    val expiresAt: OffsetDateTime?,
    val sessionActive: Boolean,
) {
    fun active(now: OffsetDateTime): Boolean = sessionActive && expiresAt?.isAfter(now) == true
    fun owned(hash: ByteArray, client: UUID, now: OffsetDateTime): Boolean = active(now) && clientId == client &&
        sessionHash != null && MessageDigest.isEqual(sessionHash, hash)
}

private fun Connection.memoryRow(user: UUID): MemoryRow? = memoryRows("""
    SELECT m.*, EXISTS(SELECT 1 FROM app_sessions s WHERE s.user_id=m.user_id
        AND s.token_hash=m.lease_session_hash AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) AS session_active
    FROM forest_memory m WHERE m.user_id=?
""".trimIndent(), user) {
    MemoryRow(it.getLong("revision"), it.getString("snapshot")?.let { data -> forestMemoryJson.decodeFromString<ForestMemoryPayload>(data) },
        it.getObject("updated_at", OffsetDateTime::class.java), it.getObject("lease_client_id", UUID::class.java),
        it.getBytes("lease_session_hash"), it.getObject("lease_token", UUID::class.java),
        it.getObject("lease_expires_at", OffsetDateTime::class.java), it.getBoolean("session_active"))
}.firstOrNull()

/** Both accounts are already locked by the lifecycle transaction. Target memory wins;
 * an empty target adopts the source. Neither device keeps its old write capability. */
internal fun mergeForestMemory(connection: Connection, target: UUID, source: UUID) {
    val current = connection.memoryRow(target)
    val other = connection.memoryRow(source)
    if (current == null && other == null) return
    val selected = if (current?.snapshot != null) current else other ?: current!!
    val revision = minOf(FOREST_MEMORY_MAX_REVISION, maxOf(current?.revision ?: 0, other?.revision ?: 0) + 1)
    connection.memoryUpdate("""
        INSERT INTO forest_memory(user_id,revision,snapshot,updated_at) VALUES (?,?,?::jsonb,?)
        ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,snapshot=EXCLUDED.snapshot,updated_at=EXCLUDED.updated_at,
            lease_client_id=NULL,lease_session_hash=NULL,lease_token=NULL,lease_expires_at=NULL
    """.trimIndent(), target, revision, selected.snapshot?.let { forestMemoryJson.encodeToString(it) }, selected.updatedAt)
    // Source commands are bound to its retired public ID. Target receipts remain valid acknowledgements only.
}

class JdbcForestMemoryRepository(private val source: DataSource) : ForestMemoryRepository {
    private data class Actor(val id: UUID, val publicId: String)
    private data class Receipt(val signature: ByteArray, val sessionHash: ByteArray, val revision: Long)

    private fun fail(code: String, message: String): Nothing = throw AuthFailure(code, message, 409)
    private fun actor(connection: Connection, hash: ByteArray): Actor = connection.memoryRows("""
        SELECT u.id,u.public_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            AND u.deleted_at IS NULL AND u.banned_at IS NULL
    """.trimIndent(), hash) { Actor(it.getObject(1, UUID::class.java), it.getString(2)) }.firstOrNull()
        ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)

    private suspend fun <T> transaction(hash: ByteArray, owner: String, block: (Connection, Actor, OffsetDateTime) -> T): T =
        withContext(Dispatchers.IO) {
            source.connection.use { connection ->
                connection.autoCommit = false
                try {
                    val initial = actor(connection, hash)
                    connection.memoryUpdate("SET LOCAL lock_timeout = '5s'")
                    connection.memoryRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", initial.id) { true }
                    // Account removal, merge and session revocation take the same user lock.
                    val current = actor(connection, hash)
                    if (current.id != initial.id || current.publicId != owner)
                        fail("FOREST_MEMORY_ACCOUNT_CHANGED", "Открыт другой профиль. Обновите страницу.")
                    val now = connection.memoryRows("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java) }.single()
                    connection.memoryUpdate("INSERT INTO forest_memory(user_id) VALUES (?) ON CONFLICT DO NOTHING", current.id)
                    val result = block(connection, current, now)
                    connection.commit()
                    result
                } catch (error: Exception) {
                    connection.rollback()
                    throw error
                }
            }
        }

    private fun view(connection: Connection, actor: Actor, hash: ByteArray, client: UUID, now: OffsetDateTime): ForestMemoryView {
        val row = checkNotNull(connection.memoryRow(actor.id))
        val owned = row.owned(hash, client, now)
        return ForestMemoryView(actor.publicId, row.revision, now.toInstant().toString(), row.updatedAt?.toInstant()?.toString(), row.snapshot,
            ForestMemoryLease(owned, row.expiresAt?.takeIf { row.active(now) }?.toInstant()?.toString(), row.token?.takeIf { owned }?.toString()))
    }

    override suspend fun read(sessionHash: ByteArray, expectedOwnerPublicId: String, clientId: UUID): ForestMemoryView {
        if (parsePublicId(expectedOwnerPublicId) != expectedOwnerPublicId || clientId.version() != 4 || clientId.variant() != 2) invalidForestMemory()
        return transaction(sessionHash, expectedOwnerPublicId) { connection, actor, now -> view(connection, actor, sessionHash, clientId, now) }
    }

    override suspend fun command(sessionHash: ByteArray, command: ForestMemoryCommand): ForestMemoryResult {
        validateForestMemoryCommand(command)
        return transaction(sessionHash, command.ownerPublicId) { connection, actor, now ->
            val client = UUID.fromString(command.clientId)
            val request = UUID.fromString(command.requestId)
            // Hash normalized typed JSON; receipts never duplicate snapshot data.
            val signature = MessageDigest.getInstance("SHA-256").digest(forestMemoryJson.encodeToString(command).toByteArray(Charsets.UTF_8))
            val receipt = connection.memoryRows("SELECT signature,session_hash,accepted_revision FROM forest_memory_receipts WHERE user_id=? AND request_id=?", actor.id, request) {
                Receipt(it.getBytes(1), it.getBytes(2), it.getLong(3))
            }.firstOrNull()
            if (receipt != null) {
                if (!MessageDigest.isEqual(receipt.signature, signature) || !MessageDigest.isEqual(receipt.sessionHash, sessionHash))
                    fail("FOREST_MEMORY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия")
                return@transaction ForestMemoryResult(view(connection, actor, sessionHash, client, now), receipt.revision, replayed = true)
            }
            val before = checkNotNull(connection.memoryRow(actor.id))
            if (before.revision != command.expectedRevision || before.revision >= FOREST_MEMORY_MAX_REVISION)
                fail("FOREST_MEMORY_REVISION_CONFLICT", "Память Мохлика уже изменилась. Получите последнее состояние.")
            val owned = before.owned(sessionHash, client, now)
            when (command.action) {
                "acquire" -> {
                    if (before.active(now) && !owned && !command.takeover)
                        fail("FOREST_MEMORY_ACTIVE_ELSEWHERE", "Мохлик сейчас живёт на другом устройстве")
                    val token = if (owned) checkNotNull(before.token) else UUID.randomUUID()
                    connection.memoryUpdate("""UPDATE forest_memory SET revision=revision+1,lease_client_id=?,lease_session_hash=?,lease_token=?,lease_expires_at=? WHERE user_id=?""",
                        client, sessionHash, token, now.plusSeconds(FOREST_MEMORY_LEASE_SECONDS), actor.id)
                }
                "save", "release" -> {
                    if (!owned || before.token.toString() != command.leaseToken)
                        fail("FOREST_MEMORY_LEASE_LOST", "Право сохранения перешло другому устройству")
                    if (command.action == "save") {
                        connection.memoryUpdate("""UPDATE forest_memory SET revision=revision+1,snapshot=?::jsonb,updated_at=?,lease_expires_at=? WHERE user_id=?""",
                            forestMemoryJson.encodeToString(checkNotNull(command.snapshot)), now, now.plusSeconds(FOREST_MEMORY_LEASE_SECONDS), actor.id)
                    } else {
                        connection.memoryUpdate("""UPDATE forest_memory SET revision=revision+1,lease_client_id=NULL,lease_session_hash=NULL,lease_token=NULL,lease_expires_at=NULL WHERE user_id=?""", actor.id)
                    }
                }
            }
            val acceptedRevision = before.revision + 1
            connection.memoryUpdate("INSERT INTO forest_memory_receipts(user_id,request_id,signature,session_hash,accepted_revision) VALUES (?,?,?,?,?)",
                actor.id, request, signature, sessionHash, acceptedRevision)
            connection.memoryUpdate("""DELETE FROM forest_memory_receipts WHERE user_id=? AND request_id IN
                (SELECT request_id FROM forest_memory_receipts WHERE user_id=? ORDER BY accepted_revision DESC OFFSET 64)""", actor.id, actor.id)
            ForestMemoryResult(view(connection, actor, sessionHash, client, now), acceptedRevision)
        }
    }
}
