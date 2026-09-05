package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.checkins.CheckInRepository
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.checkins.DailyStreakSnapshot
import ru.zhiv.identity.BootstrapKeyExpiredException
import ru.zhiv.identity.DisplayNameUpdateResult
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
                            NewUser(
                                id = result.getObject("id", UUID::class.java),
                                createdAt = result.getObject("created_at", OffsetDateTime::class.java),
                            )
                        }
                    }

                    val sessionId = insertSession(
                        connection,
                        user.id,
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
                        statement.setObject(2, user.id)
                        statement.setObject(3, sessionId)
                        statement.executeUpdate()
                    }

                    loadUserSnapshot(connection, user.id, user.createdAt)
                        ?: error("Created user could not be reloaded")
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
        WITH request_clock AS MATERIALIZED (
            SELECT clock_timestamp() AS server_time
        )
        SELECT u.id, u.public_id, u.display_name, u.last_check_in_at,
               u.status_text, u.status_updated_at,
               (SELECT count(*) FROM check_ins e WHERE e.user_id = u.id) AS check_in_count,
               streak.current_days, streak.longest_days, streak.is_active,
               streak.renew_by, u.display_name_changed_at,
               CASE
                   WHEN u.display_name_changed_at + interval '24 hours' > clock.server_time
                   THEN u.display_name_changed_at + interval '24 hours'
               END AS display_name_change_available_at,
               b.session_id, b.expires_at, clock.server_time
        FROM identity_bootstrap_keys b
        JOIN app_users u ON u.id = b.user_id
        CROSS JOIN request_clock clock
        CROSS JOIN LATERAL rolling_check_in_streak(u.id, clock.server_time) streak
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
                    WITH request_clock AS MATERIALIZED (
                        SELECT clock_timestamp() AS server_time
                    )
                    SELECT u.id, u.public_id, u.display_name, u.last_check_in_at,
                           u.status_text, u.status_updated_at,
                           (SELECT count(*) FROM check_ins e WHERE e.user_id = u.id) AS check_in_count,
                           streak.current_days, streak.longest_days, streak.is_active,
                           streak.renew_by, u.display_name_changed_at,
                           CASE
                               WHEN u.display_name_changed_at + interval '24 hours' > clock.server_time
                               THEN u.display_name_changed_at + interval '24 hours'
                           END AS display_name_change_available_at,
                           clock.server_time
                    FROM app_sessions s
                    JOIN app_users u ON u.id = s.user_id
                    CROSS JOIN request_clock clock
                    CROSS JOIN LATERAL rolling_check_in_streak(u.id, clock.server_time) streak
                    WHERE s.token_hash = ?
                      AND s.revoked_at IS NULL
                      AND s.expires_at > clock.server_time
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

    override suspend fun updateDisplayName(
        sessionTokenHash: ByteArray,
        displayName: String,
        idempotencyKey: UUID,
    ): DisplayNameUpdateResult = withContext(Dispatchers.IO) {
        inTransaction { connection ->
            val user = lockUser(connection, sessionTokenHash)
                ?: return@inTransaction DisplayNameUpdateResult.Unauthorized

            if (displayName == user.displayName) {
                val snapshot = loadUserSnapshot(connection, user.userId, user.serverTime)
                    ?: return@inTransaction DisplayNameUpdateResult.Unauthorized
                return@inTransaction DisplayNameUpdateResult.Success(snapshot)
            }
            if (idempotencyKey == user.displayNameChangeKey) {
                return@inTransaction DisplayNameUpdateResult.IdempotencyConflict
            }

            val availableAt = user.displayNameChangedAt?.plusHours(24)
            if (availableAt != null && availableAt.isAfter(user.serverTime)) {
                return@inTransaction DisplayNameUpdateResult.Cooldown(
                    availableAt = availableAt,
                    serverTime = user.serverTime,
                )
            }

            connection.prepareStatement(
                """
                UPDATE app_users
                   SET display_name = ?,
                       display_name_changed_at = ?,
                       display_name_change_key = ?,
                       updated_at = ?
                 WHERE id = ?
                """.trimIndent(),
            ).use { statement ->
                statement.setString(1, displayName)
                statement.setObject(2, user.serverTime)
                statement.setObject(3, idempotencyKey)
                statement.setObject(4, user.serverTime)
                statement.setObject(5, user.userId)
                check(statement.executeUpdate() == 1)
            }

            val snapshot = loadUserSnapshot(connection, user.userId, user.serverTime)
                ?: return@inTransaction DisplayNameUpdateResult.Unauthorized
            DisplayNameUpdateResult.Success(snapshot)
        }
    }

    override suspend fun updateStatus(sessionTokenHash: ByteArray, text: String, idempotencyKey: UUID): DisplayNameUpdateResult = withContext(Dispatchers.IO) {
        inTransaction { connection ->
            val user = lockUser(connection, sessionTokenHash)
                ?: return@inTransaction DisplayNameUpdateResult.Unauthorized
            val previous = connection.prepareStatement("SELECT status_text FROM user_status_write_keys WHERE user_id = ? AND idempotency_key = ?").use {
                it.setObject(1, user.userId); it.setObject(2, idempotencyKey)
                it.executeQuery().use { rows -> if (rows.next()) rows.getString(1) else null }
            }
            if (previous != null && previous != text) return@inTransaction DisplayNameUpdateResult.IdempotencyConflict
            if (previous == null) {
                connection.prepareStatement("UPDATE app_users SET status_text = NULLIF(?, ''), status_updated_at = CASE WHEN ? = '' THEN NULL ELSE ? END, updated_at = ? WHERE id = ? AND COALESCE(status_text, '') <> ?").use {
                    it.setString(1, text); it.setString(2, text); it.setObject(3, user.serverTime)
                    it.setObject(4, user.serverTime); it.setObject(5, user.userId); it.setString(6, text)
                    it.executeUpdate()
                }
                connection.prepareStatement("INSERT INTO user_status_write_keys(user_id, idempotency_key, status_text) VALUES (?, ?, ?)").use {
                    it.setObject(1, user.userId); it.setObject(2, idempotencyKey); it.setString(3, text); it.executeUpdate()
                }
            }
            DisplayNameUpdateResult.Success(checkNotNull(loadUserSnapshot(connection, user.userId, user.serverTime)))
        }
    }

    override suspend fun record(
        sessionTokenHash: ByteArray,
        idempotencyKey: UUID,
    ): CheckInResult = withContext(Dispatchers.IO) {
        inTransaction { connection ->
            val user = lockUser(connection, sessionTokenHash)
                ?: return@inTransaction CheckInResult.Unauthorized

            findReplay(
                connection,
                user.userId,
                idempotencyKey,
                user.serverTime,
            )?.let {
                return@inTransaction it
            }

            val nextAllowedAt = user.lastCheckInAt?.plusSeconds(30)
            if (nextAllowedAt != null && nextAllowedAt.isAfter(user.serverTime)) {
                return@inTransaction CheckInResult.Cooldown(
                    checkedAt = user.lastCheckInAt,
                    streak = loadStreak(
                        connection,
                        user.userId,
                        user.serverTime,
                    ),
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
                streak = loadStreak(
                    connection,
                    user.userId,
                    user.serverTime,
                ),
                serverTime = user.serverTime,
                nextAllowedAt = acceptedNextAllowedAt,
                replayed = false,
            )
        }
    }

    private fun snapshotDirectAudiences(connection: Connection, eventId: UUID, user: LockedUser) {
        connection.prepareStatement(
            """
            INSERT INTO check_in_audiences(check_in_id,actor_user_id,circle_id,circle_kind,recipient_user_id,recipient_membership_id,access_level)
            SELECT ?, actor.id, c.id, 'DIRECT', CASE WHEN c.direct_user_low_id=actor.id THEN c.direct_user_high_id ELSE c.direct_user_low_id END, NULL, p.sharing_mode
            FROM app_users actor
            JOIN circles c ON actor.id IN(c.direct_user_low_id,c.direct_user_high_id) AND c.kind='DIRECT' AND c.archived_at IS NULL
            CROSS JOIN LATERAL effective_recipient_sharing(actor.id,CASE WHEN c.direct_user_low_id=actor.id THEN c.direct_user_high_id ELSE c.direct_user_low_id END) p
            WHERE actor.id=? AND c.created_at<=? AND p.sharing_mode<>'OFF' AND p.enabled_since<=? AND p.updated_at<=?
            FOR SHARE OF c
            """.trimIndent(),
        ).use {
            it.setObject(1,eventId); it.setObject(2,user.userId)
            for (index in 3..5) it.setObject(index,user.serverTime)
            it.executeUpdate()
        }
    }

    private fun snapshotGroupAudiences(connection: Connection, eventId: UUID, user: LockedUser) {
        connection.prepareStatement(
            """
            INSERT INTO check_in_audiences(check_in_id,actor_user_id,circle_id,circle_kind,recipient_user_id,recipient_membership_id,access_level)
            SELECT ?, a.user_id, c.id, 'GROUP', r.user_id, r.id, p.sharing_mode
            FROM circles c
            JOIN circle_memberships a ON a.circle_id=c.id AND a.user_id=? AND a.left_at IS NULL
            JOIN circle_memberships r ON r.circle_id=c.id AND r.user_id<>a.user_id AND r.left_at IS NULL AND r.history_visibility<>'NONE'
            CROSS JOIN LATERAL effective_recipient_sharing(a.user_id,r.user_id) p
            WHERE c.kind='GROUP' AND c.archived_at IS NULL AND c.created_at<=? AND a.joined_at<=? AND r.joined_at<=?
              AND p.sharing_mode<>'OFF' AND p.enabled_since<=? AND p.updated_at<=?
            FOR SHARE OF c,a,r
            """.trimIndent(),
        ).use {
            it.setObject(1,eventId); it.setObject(2,user.userId)
            for (index in 3..7) it.setObject(index,user.serverTime)
            it.executeUpdate()
        }
    }

    private fun lockUser(connection: Connection, tokenHash: ByteArray): LockedUser? {
        val session = connection.prepareStatement(
            """
            SELECT session.id AS session_id, session.user_id
              FROM app_sessions session
              JOIN app_users user_account ON user_account.id = session.user_id
             WHERE session.token_hash = ?
               AND session.revoked_at IS NULL
               AND session.expires_at > clock_timestamp()
               AND user_account.deleted_at IS NULL
            """.trimIndent(),
        ).use { statement ->
            statement.setBytes(1, tokenHash)
            statement.executeQuery().use { result ->
                if (!result.next()) null else SessionIdentity(
                    sessionId = result.getObject("session_id", UUID::class.java),
                    userId = result.getObject("user_id", UUID::class.java),
                )
            }
        }
        if (session == null) return null

        val activeUser = connection.prepareStatement(
            "SELECT id FROM app_users WHERE id = ? AND deleted_at IS NULL FOR NO KEY UPDATE",
        ).use { statement ->
            statement.setObject(1, session.userId)
            statement.executeQuery().use { result ->
                result.next()
            }
        }
        if (!activeUser) return null

        val serverTime = connection.prepareStatement("SELECT clock_timestamp() AS server_time").use { statement ->
            statement.executeQuery().use { result ->
                check(result.next())
                result.getObject("server_time", OffsetDateTime::class.java)
            }
        }
        return connection.prepareStatement(
            """
            SELECT user_account.display_name,
                   user_account.display_name_changed_at,
                   user_account.display_name_change_key,
                   user_account.last_check_in_at,
                   user_account.timezone_id,
                   session.expires_at
              FROM app_sessions session
              JOIN app_users user_account ON user_account.id = session.user_id
             WHERE session.id = ?
               AND session.user_id = ?
               AND session.token_hash = ?
               AND session.revoked_at IS NULL
               AND session.expires_at > ?
               AND user_account.deleted_at IS NULL
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, session.sessionId)
            statement.setObject(2, session.userId)
            statement.setBytes(3, tokenHash)
            statement.setObject(4, serverTime)
            statement.executeQuery().use { result ->
                if (!result.next()) null else LockedUser(
                    userId = session.userId,
                    sessionId = session.sessionId,
                    displayName = result.getString("display_name"),
                    displayNameChangedAt = result.getObject(
                        "display_name_changed_at",
                        OffsetDateTime::class.java,
                    ),
                    displayNameChangeKey = result.getObject(
                        "display_name_change_key",
                        UUID::class.java,
                    ),
                    lastCheckInAt = result.getObject("last_check_in_at", OffsetDateTime::class.java),
                    timezoneId = result.getString("timezone_id"),
                    expiresAt = result.getObject("expires_at", OffsetDateTime::class.java),
                    revokedAt = null,
                    deletedAt = null,
                    serverTime = serverTime,
                )
            }
        }
    }

    private fun findReplay(
        connection: Connection,
        userId: UUID,
        idempotencyKey: UUID,
        serverTime: OffsetDateTime,
    ): CheckInResult.Accepted? {
        val replay = connection.prepareStatement(
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
                    CheckInReplay(
                        eventId = result.getObject("id", UUID::class.java),
                        checkedAt = result.getObject("checked_at", OffsetDateTime::class.java),
                        checkInCount = result.getLong("check_in_count"),
                        nextAllowedAt = result.getObject("next_allowed_at", OffsetDateTime::class.java),
                    )
                }
            }
        }
        if (replay == null) return null
        return CheckInResult.Accepted(
            eventId = replay.eventId,
            checkedAt = replay.checkedAt,
            checkInCount = replay.checkInCount,
            streak = loadStreak(connection, userId, serverTime),
            serverTime = serverTime,
            nextAllowedAt = replay.nextAllowedAt,
            replayed = true,
        )
    }

    private fun loadUserSnapshot(
        connection: Connection,
        userId: UUID,
        serverTime: OffsetDateTime,
    ): UserSnapshot? = connection.prepareStatement(
        """
        WITH request_clock AS MATERIALIZED (
            SELECT CAST(? AS timestamptz) AS server_time
        )
        SELECT u.id, u.public_id, u.display_name, u.last_check_in_at,
               u.status_text, u.status_updated_at,
               (SELECT count(*) FROM check_ins event WHERE event.user_id = u.id) AS check_in_count,
               streak.current_days, streak.longest_days, streak.is_active,
               streak.renew_by, u.display_name_changed_at,
               CASE
                   WHEN u.display_name_changed_at + interval '24 hours' > clock.server_time
                   THEN u.display_name_changed_at + interval '24 hours'
               END AS display_name_change_available_at,
               clock.server_time
          FROM request_clock clock
          JOIN app_users u ON u.id = ?
          CROSS JOIN LATERAL rolling_check_in_streak(u.id, clock.server_time) streak
         WHERE u.deleted_at IS NULL
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, serverTime)
        statement.setObject(2, userId)
        statement.executeQuery().use { result ->
            if (result.next()) result.toUserSnapshot() else null
        }
    }

    private fun loadStreak(
        connection: Connection,
        userId: UUID,
        serverTime: OffsetDateTime,
    ): DailyStreakSnapshot = connection.prepareStatement(
        "SELECT * FROM rolling_check_in_streak(?, ?)",
    ).use { statement ->
        statement.setObject(1, userId)
        statement.setObject(2, serverTime)
        statement.executeQuery().use { result ->
            check(result.next())
            result.toDailyStreakSnapshot()
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
        statusText = getString("status_text"),
        statusUpdatedAt = getObject("status_updated_at", OffsetDateTime::class.java),
        id = getObject("id", UUID::class.java),
        publicId = getString("public_id"),
        displayName = getString("display_name"),
        lastCheckInAt = getObject("last_check_in_at", OffsetDateTime::class.java),
        checkInCount = getLong("check_in_count"),
        streak = toDailyStreakSnapshot(),
        displayNameChangedAt = getObject("display_name_changed_at", OffsetDateTime::class.java),
        displayNameChangeAvailableAt = getObject(
            "display_name_change_available_at",
            OffsetDateTime::class.java,
        ),
        serverTime = getObject("server_time", OffsetDateTime::class.java)
            .withOffsetSameInstant(ZoneOffset.UTC),
    )

    private fun ResultSet.toDailyStreakSnapshot() = DailyStreakSnapshot(
        currentDays = getLong("current_days"),
        longestDays = getLong("longest_days"),
        isActive = getBoolean("is_active"),
        renewBy = getObject("renew_by", OffsetDateTime::class.java)
            ?.withOffsetSameInstant(ZoneOffset.UTC),
    )

    private data class LockedUser(
        val userId: UUID,
        val sessionId: UUID,
        val displayName: String,
        val displayNameChangedAt: OffsetDateTime?,
        val displayNameChangeKey: UUID?,
        val lastCheckInAt: OffsetDateTime?,
        val timezoneId: String,
        val expiresAt: OffsetDateTime,
        val revokedAt: OffsetDateTime?,
        val deletedAt: OffsetDateTime?,
        val serverTime: OffsetDateTime = OffsetDateTime.MIN,
    )

    private data class SessionIdentity(
        val sessionId: UUID,
        val userId: UUID,
    )

    private data class BootstrapReplay(
        val user: UserSnapshot,
        val sessionId: UUID,
        val expiresAt: OffsetDateTime,
    )

    private data class NewUser(
        val id: UUID,
        val createdAt: OffsetDateTime,
    )

    private data class CheckInReplay(
        val eventId: UUID,
        val checkedAt: OffsetDateTime,
        val checkInCount: Long,
        val nextAllowedAt: OffsetDateTime,
    )
}
