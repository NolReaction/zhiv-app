package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.checkins.CheckInRepository
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.identity.BootstrapKeyExpiredException
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.PublicIdGenerator
import ru.zhiv.identity.UserSnapshot
import java.nio.ByteBuffer
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

class JdbcZhivRepository(
    private val dataSource: DataSource,
    private val publicIds: PublicIdGenerator = PublicIdGenerator(),
) : IdentityRepository, CheckInRepository {

    override suspend fun bootstrap(
        displayName: String,
        bootstrapKeyHash: ByteArray,
        sessionTokenHash: ByteArray,
        sessionLifetimeDays: Long,
    ): UserSnapshot = withContext(Dispatchers.IO) {
        var lastCollision: SQLException? = null
        repeat(5) {
            try {
                return@withContext inTransaction { connection ->
                    lockBootstrapKey(connection, bootstrapKeyHash)
                    val replay = findBootstrapReplay(connection, bootstrapKeyHash)
                    if (replay != null) {
                        if (!replay.expiresAt.isAfter(replay.user.serverTime)) {
                            throw BootstrapKeyExpiredException()
                        }
                        if (!rotateSession(
                                connection,
                                replay.sessionId,
                                replay.user.id,
                                sessionTokenHash,
                                sessionLifetimeDays,
                            )
                        ) {
                            throw BootstrapKeyExpiredException()
                        }
                        return@inTransaction replay.user
                    }

                    val publicId = publicIds.next()
                    val user = connection.prepareStatement(
                        """
                        INSERT INTO app_users (public_id, display_name)
                        VALUES (?, ?)
                        RETURNING id, created_at
                        """.trimIndent(),
                    ).use { statement ->
                        statement.setString(1, publicId)
                        statement.setString(2, displayName)
                        statement.executeQuery().use { result ->
                            check(result.next())
                            result.getObject("id", UUID::class.java) to
                                result.getObject("created_at", OffsetDateTime::class.java)
                        }
                    }

                    val sessionId = insertSession(
                        connection,
                        user.first,
                        sessionTokenHash,
                        sessionLifetimeDays,
                    )
                    connection.prepareStatement(
                        """
                        INSERT INTO identity_bootstrap_keys (
                            idempotency_hash, user_id, session_id, expires_at
                        )
                        VALUES (?, ?, ?, clock_timestamp() + interval '10 minutes')
                        """.trimIndent(),
                    ).use { statement ->
                        statement.setBytes(1, bootstrapKeyHash)
                        statement.setObject(2, user.first)
                        statement.setObject(3, sessionId)
                        statement.executeUpdate()
                    }

                    UserSnapshot(
                        id = user.first,
                        publicId = publicId,
                        displayName = displayName,
                        lastCheckInAt = null,
                        checkInCount = 0,
                        serverTime = user.second,
                    )
                }
            } catch (error: SQLException) {
                if (error.sqlState == "23505" && error.message.orEmpty().contains("public_id")) {
                    lastCollision = error
                } else {
                    throw error
                }
            }
        }
        throw IllegalStateException("Could not allocate a unique public ID", lastCollision)
    }

    private fun lockBootstrapKey(connection: Connection, bootstrapKeyHash: ByteArray) {
        val lockId = ByteBuffer.wrap(bootstrapKeyHash, 0, Long.SIZE_BYTES).long
        connection.prepareStatement("SELECT pg_advisory_xact_lock(?)").use { statement ->
            statement.setLong(1, lockId)
            statement.execute()
        }
    }

    private fun findBootstrapReplay(
        connection: Connection,
        bootstrapKeyHash: ByteArray,
    ): BootstrapReplay? = connection.prepareStatement(
        """
        SELECT u.id, u.public_id, u.display_name, u.last_check_in_at,
               (SELECT count(*) FROM check_ins e WHERE e.user_id = u.id) AS check_in_count,
               b.session_id, b.expires_at, clock_timestamp() AS server_time
        FROM identity_bootstrap_keys b
        JOIN app_users u ON u.id = b.user_id
        WHERE b.idempotency_hash = ?
        FOR UPDATE OF b, u
        """.trimIndent(),
    ).use { statement ->
        statement.setBytes(1, bootstrapKeyHash)
        statement.executeQuery().use { result ->
            if (!result.next()) {
                null
            } else {
                BootstrapReplay(
                    user = result.toUserSnapshot(),
                    sessionId = result.getObject("session_id", UUID::class.java),
                    expiresAt = result.getObject("expires_at", OffsetDateTime::class.java),
                )
            }
        }
    }

    private fun insertSession(
        connection: Connection,
        userId: UUID,
        sessionTokenHash: ByteArray,
        sessionLifetimeDays: Long,
    ): UUID {
        connection.prepareStatement(
            """
            INSERT INTO app_sessions (user_id, token_hash, expires_at)
            VALUES (?, ?, clock_timestamp() + (? * interval '1 day'))
            RETURNING id
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, userId)
            statement.setBytes(2, sessionTokenHash)
            statement.setLong(3, sessionLifetimeDays)
            statement.executeQuery().use { result ->
                check(result.next())
                return result.getObject("id", UUID::class.java)
            }
        }
    }

    private fun rotateSession(
        connection: Connection,
        sessionId: UUID,
        userId: UUID,
        sessionTokenHash: ByteArray,
        sessionLifetimeDays: Long,
    ): Boolean = connection.prepareStatement(
        """
        UPDATE app_sessions s
           SET token_hash = ?,
               last_seen_at = clock_timestamp(),
               expires_at = clock_timestamp() + (? * interval '1 day')
          FROM app_users u
         WHERE s.id = ?
           AND s.user_id = ?
           AND u.id = s.user_id
           AND s.revoked_at IS NULL
           AND u.deleted_at IS NULL
        """.trimIndent(),
    ).use { statement ->
        statement.setBytes(1, sessionTokenHash)
        statement.setLong(2, sessionLifetimeDays)
        statement.setObject(3, sessionId)
        statement.setObject(4, userId)
        statement.executeUpdate() == 1
    }

    override suspend fun findBySession(sessionTokenHash: ByteArray): UserSnapshot? =
        withContext(Dispatchers.IO) {
            dataSource.connection.use { connection ->
                connection.prepareStatement(
                    """
                    SELECT u.id, u.public_id, u.display_name, u.last_check_in_at,
                           (SELECT count(*) FROM check_ins e WHERE e.user_id = u.id) AS check_in_count,
                           clock_timestamp() AS server_time
                    FROM app_sessions s
                    JOIN app_users u ON u.id = s.user_id
                    WHERE s.token_hash = ?
                      AND s.revoked_at IS NULL
                      AND s.expires_at > clock_timestamp()
                      AND u.deleted_at IS NULL
                    """.trimIndent(),
                ).use { statement ->
                    statement.setBytes(1, sessionTokenHash)
                    statement.executeQuery().use { result ->
                        if (result.next()) result.toUserSnapshot() else null
                    }
                }
            }
        }

    override suspend fun record(
        sessionTokenHash: ByteArray,
        idempotencyKey: UUID,
    ): CheckInResult = withContext(Dispatchers.IO) {
        inTransaction { connection ->
            val user = lockUser(connection, sessionTokenHash)
                ?: return@inTransaction CheckInResult.Unauthorized

            findReplay(connection, user.userId, idempotencyKey, user.serverTime)?.let {
                return@inTransaction it
            }

            val nextAllowedAt = user.lastCheckInAt?.plusSeconds(30)
            if (nextAllowedAt != null && nextAllowedAt.isAfter(user.serverTime)) {
                return@inTransaction CheckInResult.Cooldown(
                    checkedAt = user.lastCheckInAt,
                    serverTime = user.serverTime,
                    nextAllowedAt = nextAllowedAt,
                )
            }

            val acceptedNextAllowedAt = user.serverTime.plusSeconds(30)
            val eventId = connection.prepareStatement(
                """
                INSERT INTO check_ins (
                    user_id, session_id, idempotency_key, checked_at,
                    next_allowed_at, timezone_id, local_date
                )
                VALUES (?, ?, ?, ?, ?, ?, (CAST(? AS timestamptz) AT TIME ZONE ?)::date)
                RETURNING id
                """.trimIndent(),
            ).use { statement ->
                statement.setObject(1, user.userId)
                statement.setObject(2, user.sessionId)
                statement.setObject(3, idempotencyKey)
                statement.setObject(4, user.serverTime)
                statement.setObject(5, acceptedNextAllowedAt)
                statement.setString(6, user.timezoneId)
                statement.setObject(7, user.serverTime)
                statement.setString(8, user.timezoneId)
                statement.executeQuery().use { result ->
                    check(result.next())
                    result.getObject("id", UUID::class.java)
                }
            }

            snapshotDirectAudiences(connection, eventId, user)
            snapshotGroupAudiences(connection, eventId, user)

            connection.prepareStatement(
                "UPDATE app_users SET last_check_in_at = ?, updated_at = ? WHERE id = ?",
            ).use { statement ->
                statement.setObject(1, user.serverTime)
                statement.setObject(2, user.serverTime)
                statement.setObject(3, user.userId)
                statement.executeUpdate()
            }

            val checkInCount = countCheckIns(connection, user.userId)

            CheckInResult.Accepted(
                eventId = eventId,
                checkedAt = user.serverTime,
                checkInCount = checkInCount,
                serverTime = user.serverTime,
                nextAllowedAt = acceptedNextAllowedAt,
                replayed = false,
            )
        }
    }

    private fun snapshotDirectAudiences(
        connection: Connection,
        eventId: UUID,
        user: LockedUser,
    ) {
        connection.prepareStatement(
            """
            INSERT INTO check_in_audiences (
                check_in_id, actor_user_id, circle_id, circle_kind,
                recipient_user_id, recipient_membership_id, access_level
            )
            SELECT ?, ?, c.id, 'DIRECT',
                   CASE WHEN c.direct_user_low_id = ?
                        THEN c.direct_user_high_id
                        ELSE c.direct_user_low_id END,
                   NULL, preference.sharing_mode
              FROM circles c
              JOIN circle_sharing_preferences preference
                ON preference.circle_id = c.id
               AND preference.user_id = ?
               AND preference.sharing_mode <> 'OFF'
               AND preference.enabled_since IS NOT NULL
               AND preference.enabled_since <= ?
               AND preference.updated_at <= ?
             WHERE c.kind = 'DIRECT'
               AND c.archived_at IS NULL
               AND c.created_at <= ?
               AND ? IN (c.direct_user_low_id, c.direct_user_high_id)
             FOR SHARE OF c, preference
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, eventId)
            statement.setObject(2, user.userId)
            statement.setObject(3, user.userId)
            statement.setObject(4, user.userId)
            statement.setObject(5, user.serverTime)
            statement.setObject(6, user.serverTime)
            statement.setObject(7, user.serverTime)
            statement.setObject(8, user.userId)
            statement.executeUpdate()
        }
    }

    private fun snapshotGroupAudiences(
        connection: Connection,
        eventId: UUID,
        user: LockedUser,
    ) {
        connection.prepareStatement(
            """
            INSERT INTO check_in_audiences (
                check_in_id, actor_user_id, circle_id, circle_kind,
                recipient_user_id, recipient_membership_id, access_level
            )
            SELECT ?, ?, c.id, 'GROUP', recipient.user_id,
                   recipient.id, preference.sharing_mode
              FROM circles c
              JOIN circle_memberships actor
                ON actor.circle_id = c.id
               AND actor.user_id = ?
               AND actor.joined_at <= ?
               AND actor.left_at IS NULL
              JOIN circle_sharing_preferences preference
                ON preference.circle_id = c.id
               AND preference.user_id = ?
               AND preference.sharing_mode <> 'OFF'
               AND preference.enabled_since IS NOT NULL
               AND preference.enabled_since <= ?
               AND preference.updated_at <= ?
              JOIN circle_memberships recipient
                ON recipient.circle_id = c.id
               AND recipient.user_id <> ?
               AND recipient.joined_at <= ?
               AND recipient.left_at IS NULL
               AND recipient.history_visibility <> 'NONE'
             WHERE c.kind = 'GROUP'
               AND c.archived_at IS NULL
               AND c.created_at <= ?
             FOR SHARE OF c, actor, preference, recipient
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, eventId)
            statement.setObject(2, user.userId)
            statement.setObject(3, user.userId)
            statement.setObject(4, user.serverTime)
            statement.setObject(5, user.userId)
            statement.setObject(6, user.serverTime)
            statement.setObject(7, user.serverTime)
            statement.setObject(8, user.userId)
            statement.setObject(9, user.serverTime)
            statement.setObject(10, user.serverTime)
            statement.executeUpdate()
        }
    }

    private fun lockUser(connection: Connection, tokenHash: ByteArray): LockedUser? {
        val locked = connection.prepareStatement(
            """
            SELECT u.id AS user_id, s.id AS session_id, u.last_check_in_at,
                   u.timezone_id, u.deleted_at, s.expires_at, s.revoked_at
            FROM app_sessions s
            JOIN app_users u ON u.id = s.user_id
            WHERE s.token_hash = ?
              AND s.revoked_at IS NULL
              AND s.expires_at > clock_timestamp()
              AND u.deleted_at IS NULL
            FOR UPDATE OF u, s
            """.trimIndent(),
        ).use { statement ->
            statement.setBytes(1, tokenHash)
            statement.executeQuery().use { result ->
                if (!result.next()) {
                    null
                } else {
                    LockedUser(
                        userId = result.getObject("user_id", UUID::class.java),
                        sessionId = result.getObject("session_id", UUID::class.java),
                        lastCheckInAt = result.getObject("last_check_in_at", OffsetDateTime::class.java),
                        timezoneId = result.getString("timezone_id"),
                        expiresAt = result.getObject("expires_at", OffsetDateTime::class.java),
                        revokedAt = result.getObject("revoked_at", OffsetDateTime::class.java),
                        deletedAt = result.getObject("deleted_at", OffsetDateTime::class.java),
                    )
                }
            }
        }

        if (locked == null) return null
        val serverTime = connection.prepareStatement("SELECT clock_timestamp() AS server_time").use { statement ->
            statement.executeQuery().use { result ->
                check(result.next())
                result.getObject("server_time", OffsetDateTime::class.java)
            }
        }
        if (locked.revokedAt != null || locked.deletedAt != null || !locked.expiresAt.isAfter(serverTime)) {
            return null
        }
        return locked.copy(serverTime = serverTime)
    }

    private fun findReplay(
        connection: Connection,
        userId: UUID,
        idempotencyKey: UUID,
        serverTime: OffsetDateTime,
    ): CheckInResult.Accepted? = connection.prepareStatement(
        """
        SELECT event.id, event.checked_at, event.next_allowed_at,
               (
                   SELECT count(*)
                     FROM check_ins previous
                    WHERE previous.user_id = event.user_id
                      AND (
                          previous.checked_at < event.checked_at
                          OR (previous.checked_at = event.checked_at AND previous.id <= event.id)
                      )
               ) AS check_in_count
          FROM check_ins event
         WHERE event.user_id = ? AND event.idempotency_key = ?
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, userId)
        statement.setObject(2, idempotencyKey)
        statement.executeQuery().use { result ->
            if (!result.next()) {
                null
            } else {
                CheckInResult.Accepted(
                    eventId = result.getObject("id", UUID::class.java),
                    checkedAt = result.getObject("checked_at", OffsetDateTime::class.java),
                    checkInCount = result.getLong("check_in_count"),
                    serverTime = serverTime,
                    nextAllowedAt = result.getObject("next_allowed_at", OffsetDateTime::class.java),
                    replayed = true,
                )
            }
        }
    }

    private fun countCheckIns(connection: Connection, userId: UUID): Long =
        connection.prepareStatement("SELECT count(*) FROM check_ins WHERE user_id = ?").use { statement ->
            statement.setObject(1, userId)
            statement.executeQuery().use { result ->
                check(result.next())
                result.getLong(1)
            }
        }

    private fun <T> inTransaction(block: (Connection) -> T): T = dataSource.connection.use { connection ->
        try {
            val result = block(connection)
            connection.commit()
            result
        } catch (error: Throwable) {
            connection.rollback()
            throw error
        }
    }

    private fun ResultSet.toUserSnapshot() = UserSnapshot(
        id = getObject("id", UUID::class.java),
        publicId = getString("public_id"),
        displayName = getString("display_name"),
        lastCheckInAt = getObject("last_check_in_at", OffsetDateTime::class.java),
        checkInCount = getLong("check_in_count"),
        serverTime = getObject("server_time", OffsetDateTime::class.java)
            .withOffsetSameInstant(ZoneOffset.UTC),
    )

    private data class LockedUser(
        val userId: UUID,
        val sessionId: UUID,
        val lastCheckInAt: OffsetDateTime?,
        val timezoneId: String,
        val expiresAt: OffsetDateTime,
        val revokedAt: OffsetDateTime?,
        val deletedAt: OffsetDateTime?,
        val serverTime: OffsetDateTime = OffsetDateTime.MIN,
    )

    private data class BootstrapReplay(
        val user: UserSnapshot,
        val sessionId: UUID,
        val expiresAt: OffsetDateTime,
    )
}
