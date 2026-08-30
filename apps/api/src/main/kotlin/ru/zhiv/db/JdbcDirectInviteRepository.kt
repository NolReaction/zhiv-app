package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.invites.DirectInviteLinkSnapshot
import ru.zhiv.invites.DirectInvitePreviewSnapshot
import ru.zhiv.invites.DirectInviteRedeemSnapshot
import ru.zhiv.invites.DirectInviteRepository
import ru.zhiv.invites.DirectInviteResult
import ru.zhiv.relationships.PersonCheckInState
import ru.zhiv.relationships.PersonSnapshot
import ru.zhiv.relationships.SharingMode
import ru.zhiv.relationships.UserReference
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

class JdbcDirectInviteRepository(private val dataSource: DataSource) : DirectInviteRepository {
    override suspend fun create(
        sessionTokenHash: ByteArray,
        tokenHash: ByteArray,
        idempotencyKey: UUID,
    ): DirectInviteResult<DirectInviteLinkSnapshot> = io {
        tx { connection ->
            val userId = currentUser(connection, sessionTokenHash)
                ?: return@tx DirectInviteResult.Unauthorized
            lockUsers(connection, setOf(userId))
            if (currentUser(connection, sessionTokenHash) != userId) {
                return@tx DirectInviteResult.Unauthorized
            }
            val now = serverTime(connection)
            findByIdempotency(connection, userId, idempotencyKey)?.let { row ->
                if (!row.tokenHash.contentEquals(tokenHash)) return@tx DirectInviteResult.Conflict
                return@tx DirectInviteResult.Success(
                    DirectInviteLinkSnapshot(row.id, row.expiresAt, true, now),
                )
            }
            connection.prepareStatement(
                """
                UPDATE direct_invite_links
                   SET status = 'REVOKED', revoked_at = ?
                 WHERE inviter_user_id = ? AND status = 'PENDING'
                """.trimIndent(),
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, userId)
                statement.executeUpdate()
            }
            val row = connection.prepareStatement(
                """
                INSERT INTO direct_invite_links (
                    inviter_user_id, token_hash, idempotency_key, created_at, expires_at
                ) VALUES (?, ?, ?, ?, ? + interval '7 days')
                RETURNING id, inviter_user_id, token_hash, status, accepted_by_user_id,
                          accepted_idempotency_key, result_circle_id, created_at, expires_at
                """.trimIndent(),
            ).use { statement ->
                statement.setObject(1, userId)
                statement.setBytes(2, tokenHash)
                statement.setObject(3, idempotencyKey)
                statement.setObject(4, now)
                statement.setObject(5, now)
                statement.executeQuery().use { result ->
                    check(result.next())
                    result.toInviteRow()
                }
            }
            DirectInviteResult.Success(
                DirectInviteLinkSnapshot(row.id, row.expiresAt, false, now),
            )
        }
    }

    override suspend fun preview(
        tokenHash: ByteArray,
    ): DirectInviteResult<DirectInvitePreviewSnapshot> = io {
        tx { connection ->
            val now = serverTime(connection)
            val row = findByToken(connection, tokenHash, lock = true)
                ?: return@tx DirectInviteResult.NotFound
            if (row.status != "PENDING" || !row.expiresAt.isAfter(now)) {
                if (row.status == "PENDING") expire(connection, row.id, now)
                return@tx DirectInviteResult.Expired
            }
            DirectInviteResult.Success(
                DirectInvitePreviewSnapshot(user(connection, row.inviterUserId), row.expiresAt, now),
            )
        }
    }

    override suspend fun redeem(
        sessionTokenHash: ByteArray,
        tokenHash: ByteArray,
        idempotencyKey: UUID,
    ): DirectInviteResult<DirectInviteRedeemSnapshot> = io {
        tx { connection ->
            val recipientId = currentUser(connection, sessionTokenHash)
                ?: return@tx DirectInviteResult.Unauthorized
            val initialRow = findByToken(connection, tokenHash, lock = false)
                ?: return@tx DirectInviteResult.NotFound
            if (initialRow.inviterUserId == recipientId) return@tx DirectInviteResult.Self
            lockUsers(connection, setOf(initialRow.inviterUserId, recipientId))
            if (currentUser(connection, sessionTokenHash) != recipientId) {
                return@tx DirectInviteResult.Unauthorized
            }
            val row = findByToken(connection, tokenHash, lock = true)
                ?: return@tx DirectInviteResult.NotFound
            val now = serverTime(connection)
            if (row.inviterUserId == recipientId) return@tx DirectInviteResult.Self
            val priorIdempotency = connection.prepareStatement(
                """SELECT id FROM direct_invite_links
                    WHERE accepted_by_user_id = ? AND accepted_idempotency_key = ?""",
            ).use { statement ->
                statement.setObject(1, recipientId)
                statement.setObject(2, idempotencyKey)
                statement.executeQuery().use { result ->
                    if (result.next()) result.getObject(1, UUID::class.java) else null
                }
            }
            if (priorIdempotency != null && priorIdempotency != row.id) {
                return@tx DirectInviteResult.Conflict
            }
            if (row.status == "ACCEPTED") {
                if (row.acceptedByUserId != recipientId
                    || row.acceptedIdempotencyKey != idempotencyKey
                    || row.resultCircleId == null
                ) {
                    return@tx DirectInviteResult.Conflict
                }
                val person = findPerson(connection, row.resultCircleId, recipientId)
                    ?: return@tx DirectInviteResult.Conflict
                return@tx DirectInviteResult.Success(DirectInviteRedeemSnapshot(person, true, now))
            }
            if (row.status != "PENDING" || !row.expiresAt.isAfter(now)) {
                if (row.status == "PENDING") expire(connection, row.id, now)
                return@tx DirectInviteResult.Expired
            }
            val circleId = activeCircle(connection, row.inviterUserId, recipientId)
                ?: createCircle(connection, row.inviterUserId, recipientId, now)
            ensurePreferences(connection, circleId, row.inviterUserId, recipientId, now)
            connection.prepareStatement(
                """
                UPDATE direct_requests SET status = 'EXPIRED', responded_at = ?
                 WHERE status = 'PENDING'
                   AND expires_at <= ?
                   AND LEAST(requester_user_id, recipient_user_id) = LEAST(?, ?)
                   AND GREATEST(requester_user_id, recipient_user_id) = GREATEST(?, ?)
                """.trimIndent(),
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, now)
                statement.setObject(3, row.inviterUserId)
                statement.setObject(4, recipientId)
                statement.setObject(5, row.inviterUserId)
                statement.setObject(6, recipientId)
                statement.executeUpdate()
            }
            connection.prepareStatement(
                """
                UPDATE direct_requests SET status = 'CANCELLED', responded_at = ?
                 WHERE status = 'PENDING'
                   AND expires_at > ?
                   AND LEAST(requester_user_id, recipient_user_id) = LEAST(?, ?)
                   AND GREATEST(requester_user_id, recipient_user_id) = GREATEST(?, ?)
                """.trimIndent(),
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, now)
                statement.setObject(3, row.inviterUserId)
                statement.setObject(4, recipientId)
                statement.setObject(5, row.inviterUserId)
                statement.setObject(6, recipientId)
                statement.executeUpdate()
            }
            connection.prepareStatement(
                """
                UPDATE direct_invite_links
                   SET status = 'ACCEPTED', accepted_by_user_id = ?,
                       accepted_idempotency_key = ?, result_circle_id = ?,
                       result_circle_kind = 'DIRECT', accepted_at = ?
                 WHERE id = ? AND status = 'PENDING'
                """.trimIndent(),
            ).use { statement ->
                statement.setObject(1, recipientId)
                statement.setObject(2, idempotencyKey)
                statement.setObject(3, circleId)
                statement.setObject(4, now)
                statement.setObject(5, row.id)
                check(statement.executeUpdate() == 1)
            }
            val person = findPerson(connection, circleId, recipientId)
                ?: error("accepted invite must expose its direct person")
            DirectInviteResult.Success(DirectInviteRedeemSnapshot(person, false, now))
        }
    }

    private fun currentUser(connection: Connection, hash: ByteArray): UUID? =
        connection.prepareStatement(
            """SELECT u.id FROM app_sessions s JOIN app_users u ON u.id = s.user_id
               WHERE s.token_hash = ? AND s.revoked_at IS NULL
                 AND s.expires_at > clock_timestamp() AND u.deleted_at IS NULL""",
        ).use { statement ->
            statement.setBytes(1, hash)
            statement.executeQuery().use { result ->
                if (result.next()) result.getObject(1, UUID::class.java) else null
            }
        }

    private fun findByIdempotency(connection: Connection, userId: UUID, key: UUID): InviteRow? =
        connection.prepareStatement(
            """SELECT id, inviter_user_id, token_hash, status, accepted_by_user_id,
                      accepted_idempotency_key, result_circle_id, created_at, expires_at
                 FROM direct_invite_links WHERE inviter_user_id = ? AND idempotency_key = ?""",
        ).use { statement ->
            statement.setObject(1, userId)
            statement.setObject(2, key)
            statement.executeQuery().use { result -> if (result.next()) result.toInviteRow() else null }
        }

    private fun findByToken(connection: Connection, hash: ByteArray, lock: Boolean): InviteRow? {
        val suffix = if (lock) " FOR UPDATE" else ""
        return connection.prepareStatement(
            """SELECT id, inviter_user_id, token_hash, status, accepted_by_user_id,
                      accepted_idempotency_key, result_circle_id, created_at, expires_at
                 FROM direct_invite_links WHERE token_hash = ?$suffix""",
        ).use { statement ->
            statement.setBytes(1, hash)
            statement.executeQuery().use { result -> if (result.next()) result.toInviteRow() else null }
        }
    }

    private fun expire(connection: Connection, id: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            "UPDATE direct_invite_links SET status = 'EXPIRED', revoked_at = ? WHERE id = ? AND status = 'PENDING'",
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, id)
            statement.executeUpdate()
        }
    }

    private fun lockUsers(connection: Connection, ids: Set<UUID>) {
        val ordered = ids.sorted()
        val placeholders = ordered.joinToString(",") { "?" }
        connection.prepareStatement(
            "SELECT id FROM app_users WHERE id IN ($placeholders) ORDER BY id FOR NO KEY UPDATE",
        ).use { statement ->
            ordered.forEachIndexed { index, id -> statement.setObject(index + 1, id) }
            statement.executeQuery().use { result ->
                var count = 0
                while (result.next()) count++
                check(count == ordered.size)
            }
        }
    }

    private fun activeCircle(connection: Connection, first: UUID, second: UUID): UUID? =
        connection.prepareStatement(
            """SELECT id FROM circles WHERE kind = 'DIRECT' AND archived_at IS NULL
               AND direct_user_low_id = LEAST(?, ?) AND direct_user_high_id = GREATEST(?, ?)""",
        ).use { statement ->
            statement.setObject(1, first); statement.setObject(2, second)
            statement.setObject(3, first); statement.setObject(4, second)
            statement.executeQuery().use { result -> if (result.next()) result.getObject(1, UUID::class.java) else null }
        }

    private fun createCircle(connection: Connection, first: UUID, second: UUID, now: OffsetDateTime): UUID =
        connection.prepareStatement(
            """INSERT INTO circles (kind, created_by_user_id, direct_user_low_id, direct_user_high_id, created_at)
               VALUES ('DIRECT', ?, LEAST(?, ?), GREATEST(?, ?), ?) RETURNING id""",
        ).use { statement ->
            statement.setObject(1, first)
            statement.setObject(2, first); statement.setObject(3, second)
            statement.setObject(4, first); statement.setObject(5, second)
            statement.setObject(6, now)
            statement.executeQuery().use { result -> check(result.next()); result.getObject(1, UUID::class.java) }
        }

    private fun ensurePreferences(connection: Connection, circleId: UUID, first: UUID, second: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            """INSERT INTO circle_sharing_preferences
                 (circle_id, user_id, sharing_mode, enabled_since, created_at, updated_at)
               VALUES (?, ?, 'LATEST_ONLY', ?, ?, ?), (?, ?, 'LATEST_ONLY', ?, ?, ?)
               ON CONFLICT (circle_id, user_id) DO NOTHING""",
        ).use { statement ->
            statement.setObject(1, circleId); statement.setObject(2, first)
            statement.setObject(3, now); statement.setObject(4, now); statement.setObject(5, now)
            statement.setObject(6, circleId); statement.setObject(7, second)
            statement.setObject(8, now); statement.setObject(9, now); statement.setObject(10, now)
            statement.executeUpdate()
        }
    }

    private fun findPerson(connection: Connection, circleId: UUID, current: UUID): PersonSnapshot? =
        connection.prepareStatement(
            """
            WITH direct_person AS (
                SELECT c.id, c.created_at,
                       CASE WHEN c.direct_user_low_id = ? THEN c.direct_user_high_id ELSE c.direct_user_low_id END other_user_id
                  FROM circles c WHERE c.id = ? AND c.kind = 'DIRECT' AND c.archived_at IS NULL
                    AND ? IN (c.direct_user_low_id, c.direct_user_high_id)
            )
            SELECT direct_person.id circle_id, direct_person.created_at, other.public_id, other.display_name,
                   mine.sharing_mode my_sharing_mode, theirs.sharing_mode their_sharing_mode,
                   CASE WHEN theirs.sharing_mode = 'OFF' THEN 'HIDDEN'
                        WHEN latest.checked_at IS NOT NULL THEN 'AVAILABLE'
                        WHEN theirs.enabled_since > theirs.created_at THEN 'WAITING_AFTER_REENABLE'
                        ELSE 'WAITING_INITIAL' END check_in_state,
                   latest.checked_at last_check_in_at
              FROM direct_person JOIN app_users other ON other.id = direct_person.other_user_id
              JOIN circle_sharing_preferences mine ON mine.circle_id = direct_person.id AND mine.user_id = ?
              JOIN circle_sharing_preferences theirs ON theirs.circle_id = direct_person.id AND theirs.user_id = direct_person.other_user_id
              LEFT JOIN LATERAL (
                  SELECT event.checked_at FROM check_in_audiences audience
                  JOIN check_ins event ON event.id = audience.check_in_id AND event.user_id = audience.actor_user_id
                  WHERE audience.circle_id = direct_person.id AND audience.circle_kind = 'DIRECT'
                    AND audience.recipient_user_id = ? AND audience.actor_user_id = direct_person.other_user_id
                    AND theirs.sharing_mode <> 'OFF' AND theirs.enabled_since IS NOT NULL
                    AND event.checked_at >= theirs.enabled_since
                  ORDER BY event.checked_at DESC LIMIT 1
              ) latest ON TRUE
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, current); statement.setObject(2, circleId); statement.setObject(3, current)
            statement.setObject(4, current); statement.setObject(5, current)
            statement.executeQuery().use { result -> if (result.next()) result.toPerson() else null }
        }

    private fun user(connection: Connection, id: UUID): UserReference =
        connection.prepareStatement("SELECT public_id, display_name FROM app_users WHERE id = ? AND deleted_at IS NULL").use { statement ->
            statement.setObject(1, id)
            statement.executeQuery().use { result -> check(result.next()); UserReference(result.getString(1), result.getString(2)) }
        }

    private fun serverTime(connection: Connection): OffsetDateTime =
        connection.prepareStatement("SELECT clock_timestamp()").use { statement ->
            statement.executeQuery().use { result -> check(result.next()); result.getObject(1, OffsetDateTime::class.java) }
        }

    private fun ResultSet.toInviteRow() = InviteRow(
        getObject("id", UUID::class.java), getObject("inviter_user_id", UUID::class.java),
        getBytes("token_hash"), getString("status"), getObject("accepted_by_user_id", UUID::class.java),
        getObject("accepted_idempotency_key", UUID::class.java),
        getObject("result_circle_id", UUID::class.java), getObject("created_at", OffsetDateTime::class.java),
        getObject("expires_at", OffsetDateTime::class.java),
    )

    private fun ResultSet.toPerson() = PersonSnapshot(
        getObject("circle_id", UUID::class.java), UserReference(getString("public_id"), getString("display_name")),
        getObject("created_at", OffsetDateTime::class.java), SharingMode.valueOf(getString("my_sharing_mode")),
        SharingMode.valueOf(getString("their_sharing_mode")), PersonCheckInState.valueOf(getString("check_in_state")),
        getObject("last_check_in_at", OffsetDateTime::class.java),
    )

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }
    private fun <T> tx(block: (Connection) -> T): T = dataSource.connection.use { connection ->
        try { block(connection).also { connection.commit() } }
        catch (error: Throwable) { connection.rollback(); throw error }
    }

    private data class InviteRow(
        val id: UUID, val inviterUserId: UUID, val tokenHash: ByteArray, val status: String,
        val acceptedByUserId: UUID?, val acceptedIdempotencyKey: UUID?, val resultCircleId: UUID?,
        val createdAt: OffsetDateTime,
        val expiresAt: OffsetDateTime,
    )
}
