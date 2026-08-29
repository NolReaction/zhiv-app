package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.relationships.DirectRequestActionSnapshot
import ru.zhiv.relationships.DirectRequestMutationSnapshot
import ru.zhiv.relationships.DirectRequestSnapshot
import ru.zhiv.relationships.PeopleSnapshot
import ru.zhiv.relationships.PersonCheckInState
import ru.zhiv.relationships.PersonSnapshot
import ru.zhiv.relationships.RelationshipRepository
import ru.zhiv.relationships.RelationshipResult
import ru.zhiv.relationships.RelationshipState
import ru.zhiv.relationships.RemovedSnapshot
import ru.zhiv.relationships.RequestAction
import ru.zhiv.relationships.RequestDirection
import ru.zhiv.relationships.SharingMode
import ru.zhiv.relationships.SharingSnapshot
import ru.zhiv.relationships.UserLookupSnapshot
import ru.zhiv.relationships.UserReference
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

class JdbcRelationshipRepository(
    private val dataSource: DataSource,
) : RelationshipRepository {

    override suspend fun lookup(
        sessionTokenHash: ByteArray,
        publicId: String,
    ): RelationshipResult<UserLookupSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = findCurrentUser(connection, sessionTokenHash)
                ?: return@inTransaction RelationshipResult.Unauthorized
            val target = findUserByPublicId(connection, publicId)
                ?: return@inTransaction RelationshipResult.NotFound
            val now = serverTime(connection)
            if (target.id != currentUserId) {
                expirePairRequests(connection, currentUserId, target.id, now)
            }
            val circle = if (target.id == currentUserId) null
            else findActiveCircle(connection, currentUserId, target.id)
            val pending = if (target.id == currentUserId || circle != null) null
            else findPendingRequest(connection, currentUserId, target.id)
            val state = when {
                target.id == currentUserId -> RelationshipState.SELF
                circle != null -> RelationshipState.CONNECTED
                pending?.requesterUserId == currentUserId -> RelationshipState.OUTGOING_REQUEST
                pending != null -> RelationshipState.INCOMING_REQUEST
                else -> RelationshipState.NONE
            }
            RelationshipResult.Success(
                UserLookupSnapshot(
                    user = target.reference,
                    relationshipState = state,
                    serverTime = now,
                ),
            )
        }
    }

    override suspend fun listPeople(
        sessionTokenHash: ByteArray,
    ): RelationshipResult<PeopleSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = findCurrentUser(connection, sessionTokenHash)
                ?: return@inTransaction RelationshipResult.Unauthorized
            val expiryTime = serverTime(connection)
            expireUserRequests(connection, currentUserId, expiryTime)
            val people = listPeople(connection, currentUserId)
            val requests = listRequests(connection, currentUserId)
            val responseTime = serverTime(connection)
            RelationshipResult.Success(
                PeopleSnapshot(
                    people = people,
                    incomingRequests = requests.filter { it.direction == RequestDirection.INCOMING },
                    outgoingRequests = requests.filter { it.direction == RequestDirection.OUTGOING },
                    audienceCount = countAudienceRecipients(connection, currentUserId),
                    serverTime = responseTime,
                ),
            )
        }
    }

    override suspend fun sendRequest(
        sessionTokenHash: ByteArray,
        targetPublicId: String,
        idempotencyKey: UUID,
    ): RelationshipResult<DirectRequestMutationSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = findCurrentUser(connection, sessionTokenHash)
                ?: return@inTransaction RelationshipResult.Unauthorized
            val target = findUserByPublicId(connection, targetPublicId)
                ?: return@inTransaction RelationshipResult.NotFound
            if (target.id == currentUserId) return@inTransaction RelationshipResult.Self

            lockUserPair(connection, currentUserId, target.id)
            val now = serverTime(connection)
            val replay = findRequestReplay(connection, currentUserId, idempotencyKey)
            if (replay != null) {
                if (replay.recipientUserId != target.id) {
                    return@inTransaction RelationshipResult.Conflict
                }
                return@inTransaction RelationshipResult.Success(
                    DirectRequestMutationSnapshot(
                        request = replay.toSnapshot(connection, currentUserId),
                        replayed = true,
                        serverTime = now,
                    ),
                )
            }

            expirePairRequests(connection, currentUserId, target.id, now)
            if (findActiveCircle(connection, currentUserId, target.id) != null) {
                return@inTransaction RelationshipResult.AlreadyConnected
            }
            val pending = findPendingRequest(connection, currentUserId, target.id)
            if (pending != null) {
                return@inTransaction RelationshipResult.Success(
                    DirectRequestMutationSnapshot(
                        request = pending.toSnapshot(connection, currentUserId),
                        replayed = true,
                        serverTime = now,
                    ),
                )
            }

            val request = connection.prepareStatement(
                """
                INSERT INTO direct_requests (
                    requester_user_id, recipient_user_id, idempotency_key,
                    created_at, expires_at
                )
                VALUES (?, ?, ?, ?, CAST(? AS timestamptz) + interval '7 days')
                RETURNING id, requester_user_id, recipient_user_id, status,
                          result_circle_id, created_at, expires_at, responded_at,
                          idempotency_key
                """.trimIndent(),
            ).use { statement ->
                statement.setObject(1, currentUserId)
                statement.setObject(2, target.id)
                statement.setObject(3, idempotencyKey)
                statement.setObject(4, now)
                statement.setObject(5, now)
                statement.executeQuery().use { result ->
                    check(result.next())
                    result.toRequestRow()
                }
            }
            RelationshipResult.Success(
                DirectRequestMutationSnapshot(
                    request = request.toSnapshot(connection, currentUserId),
                    replayed = false,
                    serverTime = now,
                ),
            )
        }
    }

    override suspend fun actOnRequest(
        sessionTokenHash: ByteArray,
        requestId: UUID,
        action: RequestAction,
    ): RelationshipResult<DirectRequestActionSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = findCurrentUser(connection, sessionTokenHash)
                ?: return@inTransaction RelationshipResult.Unauthorized
            var request = findRequest(connection, requestId)
                ?: return@inTransaction RelationshipResult.NotFound
            var authorized = if (action == RequestAction.CANCELLED) {
                request.requesterUserId == currentUserId
            } else {
                request.recipientUserId == currentUserId
            }
            if (!authorized) return@inTransaction RelationshipResult.Forbidden

            lockUserPair(connection, request.requesterUserId, request.recipientUserId)
            request = findRequestForUpdate(connection, requestId)
                ?: return@inTransaction RelationshipResult.NotFound
            authorized = if (action == RequestAction.CANCELLED) {
                request.requesterUserId == currentUserId
            } else {
                request.recipientUserId == currentUserId
            }
            if (!authorized) return@inTransaction RelationshipResult.Forbidden

            val now = serverTime(connection)
            if (request.status == "EXPIRED") return@inTransaction RelationshipResult.Expired
            if (request.status != "PENDING") {
                if (request.status != action.name) return@inTransaction RelationshipResult.Conflict
                val person = request.resultCircleId?.let {
                    findPerson(connection, it, currentUserId)
                }
                return@inTransaction RelationshipResult.Success(
                    DirectRequestActionSnapshot(
                        requestId = request.id,
                        status = action,
                        person = person,
                        replayed = true,
                        serverTime = now,
                    ),
                )
            }

            if (!request.expiresAt.isAfter(now)) {
                expireRequest(connection, request.id, now)
                return@inTransaction RelationshipResult.Expired
            }

            var person: PersonSnapshot? = null
            if (action == RequestAction.ACCEPTED) {
                val circleId = findActiveCircle(
                    connection,
                    request.requesterUserId,
                    request.recipientUserId,
                ) ?: createDirectCircle(connection, request, currentUserId, now)
                ensureSharingPreferences(
                    connection,
                    circleId,
                    request.requesterUserId,
                    request.recipientUserId,
                    now,
                )
                connection.prepareStatement(
                    """
                    UPDATE direct_requests
                       SET status = 'ACCEPTED', responded_at = ?,
                           result_circle_id = ?, result_circle_kind = 'DIRECT'
                     WHERE id = ? AND status = 'PENDING'
                    """.trimIndent(),
                ).use { statement ->
                    statement.setObject(1, now)
                    statement.setObject(2, circleId)
                    statement.setObject(3, request.id)
                    check(statement.executeUpdate() == 1)
                }
                request = request.copy(
                    status = "ACCEPTED",
                    resultCircleId = circleId,
                    respondedAt = now,
                )
                person = findPerson(connection, circleId, currentUserId)
            } else {
                connection.prepareStatement(
                    "UPDATE direct_requests SET status = ?, responded_at = ? WHERE id = ? AND status = 'PENDING'",
                ).use { statement ->
                    statement.setString(1, action.name)
                    statement.setObject(2, now)
                    statement.setObject(3, request.id)
                    check(statement.executeUpdate() == 1)
                }
            }

            RelationshipResult.Success(
                DirectRequestActionSnapshot(
                    requestId = request.id,
                    status = action,
                    person = person,
                    replayed = false,
                    serverTime = now,
                ),
            )
        }
    }

    override suspend fun updateSharing(
        sessionTokenHash: ByteArray,
        circleId: UUID,
        sharingMode: SharingMode,
    ): RelationshipResult<SharingSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = findCurrentUser(connection, sessionTokenHash)
                ?: return@inTransaction RelationshipResult.Unauthorized
            val circle = findCircleForUser(connection, circleId, currentUserId, lock = true)
                ?: return@inTransaction RelationshipResult.NotFound
            if (circle.archivedAt != null) return@inTransaction RelationshipResult.NotFound
            connection.prepareStatement(
                """
                INSERT INTO circle_sharing_preferences (
                    circle_id, user_id, sharing_mode, enabled_since
                )
                VALUES (?, ?, ?, CASE WHEN ? = 'OFF' THEN NULL ELSE clock_timestamp() END)
                ON CONFLICT (circle_id, user_id) DO UPDATE
                    SET sharing_mode = EXCLUDED.sharing_mode
                """.trimIndent(),
            ).use { statement ->
                statement.setObject(1, circleId)
                statement.setObject(2, currentUserId)
                statement.setString(3, sharingMode.name)
                statement.setString(4, sharingMode.name)
                statement.executeUpdate()
            }
            RelationshipResult.Success(
                SharingSnapshot(
                    circleId = circleId,
                    sharingMode = sharingMode,
                    serverTime = serverTime(connection),
                ),
            )
        }
    }

    override suspend fun removePerson(
        sessionTokenHash: ByteArray,
        circleId: UUID,
    ): RelationshipResult<RemovedSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = findCurrentUser(connection, sessionTokenHash)
                ?: return@inTransaction RelationshipResult.Unauthorized
            val circle = findCircleForUser(connection, circleId, currentUserId, lock = true)
                ?: return@inTransaction RelationshipResult.NotFound
            val now = serverTime(connection)
            if (circle.archivedAt == null) {
                connection.prepareStatement(
                    "UPDATE circles SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
                ).use { statement ->
                    statement.setObject(1, now)
                    statement.setObject(2, circleId)
                    check(statement.executeUpdate() == 1)
                }
            }
            RelationshipResult.Success(RemovedSnapshot(serverTime = now))
        }
    }

    private fun findCurrentUser(connection: Connection, tokenHash: ByteArray): UUID? =
        connection.prepareStatement(
            """
            SELECT u.id
              FROM app_sessions s
              JOIN app_users u ON u.id = s.user_id
             WHERE s.token_hash = ?
               AND s.revoked_at IS NULL
               AND s.expires_at > clock_timestamp()
               AND u.deleted_at IS NULL
            """.trimIndent(),
        ).use { statement ->
            statement.setBytes(1, tokenHash)
            statement.executeQuery().use { result ->
                if (result.next()) result.getObject("id", UUID::class.java) else null
            }
        }

    private fun findUserByPublicId(connection: Connection, publicId: String): UserRow? =
        connection.prepareStatement(
            "SELECT id, public_id, display_name FROM app_users WHERE public_id = ? AND deleted_at IS NULL",
        ).use { statement ->
            statement.setString(1, publicId)
            statement.executeQuery().use { result ->
                if (result.next()) result.toUserRow() else null
            }
        }

    private fun findUser(connection: Connection, userId: UUID): UserReference =
        connection.prepareStatement(
            "SELECT public_id, display_name FROM app_users WHERE id = ?",
        ).use { statement ->
            statement.setObject(1, userId)
            statement.executeQuery().use { result ->
                check(result.next())
                UserReference(result.getString("public_id"), result.getString("display_name"))
            }
        }

    private fun lockUserPair(connection: Connection, firstUserId: UUID, secondUserId: UUID) {
        connection.prepareStatement(
            "SELECT id FROM app_users WHERE id IN (?, ?) ORDER BY id FOR UPDATE",
        ).use { statement ->
            statement.setObject(1, firstUserId)
            statement.setObject(2, secondUserId)
            statement.executeQuery().use { result ->
                var count = 0
                while (result.next()) count++
                check(count == 2)
            }
        }
    }

    private fun serverTime(connection: Connection): OffsetDateTime =
        connection.prepareStatement("SELECT clock_timestamp() AS server_time").use { statement ->
            statement.executeQuery().use { result ->
                check(result.next())
                result.getObject("server_time", OffsetDateTime::class.java)
            }
        }

    private fun expireUserRequests(connection: Connection, userId: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            """
            UPDATE direct_requests
               SET status = 'EXPIRED', responded_at = ?
             WHERE status = 'PENDING' AND expires_at <= ?
               AND ? IN (requester_user_id, recipient_user_id)
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, now)
            statement.setObject(3, userId)
            statement.executeUpdate()
        }
    }

    private fun expirePairRequests(
        connection: Connection,
        firstUserId: UUID,
        secondUserId: UUID,
        now: OffsetDateTime,
    ) {
        connection.prepareStatement(
            """
            UPDATE direct_requests
               SET status = 'EXPIRED', responded_at = ?
             WHERE status = 'PENDING' AND expires_at <= ?
               AND LEAST(requester_user_id, recipient_user_id) = LEAST(?, ?)
               AND GREATEST(requester_user_id, recipient_user_id) = GREATEST(?, ?)
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, now)
            statement.setObject(3, firstUserId)
            statement.setObject(4, secondUserId)
            statement.setObject(5, firstUserId)
            statement.setObject(6, secondUserId)
            statement.executeUpdate()
        }
    }

    private fun expireRequest(connection: Connection, requestId: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            "UPDATE direct_requests SET status = 'EXPIRED', responded_at = ? WHERE id = ? AND status = 'PENDING'",
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, requestId)
            statement.executeUpdate()
        }
    }

    private fun findActiveCircle(connection: Connection, firstUserId: UUID, secondUserId: UUID): UUID? =
        connection.prepareStatement(
            """
            SELECT id FROM circles
             WHERE kind = 'DIRECT' AND archived_at IS NULL
               AND direct_user_low_id = LEAST(?, ?)
               AND direct_user_high_id = GREATEST(?, ?)
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, firstUserId)
            statement.setObject(2, secondUserId)
            statement.setObject(3, firstUserId)
            statement.setObject(4, secondUserId)
            statement.executeQuery().use { result ->
                if (result.next()) result.getObject("id", UUID::class.java) else null
            }
        }

    private fun findPendingRequest(connection: Connection, firstUserId: UUID, secondUserId: UUID): RequestRow? =
        connection.prepareStatement(
            """
            SELECT id, requester_user_id, recipient_user_id, status,
                   result_circle_id, created_at, expires_at, responded_at,
                   idempotency_key
              FROM direct_requests
             WHERE status = 'PENDING'
               AND LEAST(requester_user_id, recipient_user_id) = LEAST(?, ?)
               AND GREATEST(requester_user_id, recipient_user_id) = GREATEST(?, ?)
             FOR UPDATE
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, firstUserId)
            statement.setObject(2, secondUserId)
            statement.setObject(3, firstUserId)
            statement.setObject(4, secondUserId)
            statement.executeQuery().use { result ->
                if (result.next()) result.toRequestRow() else null
            }
        }

    private fun findRequestReplay(
        connection: Connection,
        requesterUserId: UUID,
        idempotencyKey: UUID,
    ): RequestRow? = connection.prepareStatement(
        """
        SELECT id, requester_user_id, recipient_user_id, status,
               result_circle_id, created_at, expires_at, responded_at,
               idempotency_key
          FROM direct_requests
         WHERE requester_user_id = ? AND idempotency_key = ?
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, requesterUserId)
        statement.setObject(2, idempotencyKey)
        statement.executeQuery().use { result ->
            if (result.next()) result.toRequestRow() else null
        }
    }

    private fun findRequestForUpdate(connection: Connection, requestId: UUID): RequestRow? =
        connection.prepareStatement(
            """
            SELECT id, requester_user_id, recipient_user_id, status,
                   result_circle_id, created_at, expires_at, responded_at,
                   idempotency_key
              FROM direct_requests
             WHERE id = ?
             FOR UPDATE
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, requestId)
            statement.executeQuery().use { result ->
                if (result.next()) result.toRequestRow() else null
            }
        }

    private fun findRequest(connection: Connection, requestId: UUID): RequestRow? =
        connection.prepareStatement(
            """
            SELECT id, requester_user_id, recipient_user_id, status,
                   result_circle_id, created_at, expires_at, responded_at,
                   idempotency_key
              FROM direct_requests
             WHERE id = ?
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, requestId)
            statement.executeQuery().use { result ->
                if (result.next()) result.toRequestRow() else null
            }
        }

    private fun createDirectCircle(
        connection: Connection,
        request: RequestRow,
        createdByUserId: UUID,
        now: OffsetDateTime,
    ): UUID = connection.prepareStatement(
        """
        INSERT INTO circles (
            kind, created_by_user_id, direct_user_low_id,
            direct_user_high_id, created_at
        )
        VALUES ('DIRECT', ?, LEAST(?, ?), GREATEST(?, ?), ?)
        RETURNING id
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, createdByUserId)
        statement.setObject(2, request.requesterUserId)
        statement.setObject(3, request.recipientUserId)
        statement.setObject(4, request.requesterUserId)
        statement.setObject(5, request.recipientUserId)
        statement.setObject(6, now)
        statement.executeQuery().use { result ->
            check(result.next())
            result.getObject("id", UUID::class.java)
        }
    }

    private fun ensureSharingPreferences(
        connection: Connection,
        circleId: UUID,
        firstUserId: UUID,
        secondUserId: UUID,
        now: OffsetDateTime,
    ) {
        connection.prepareStatement(
            """
            INSERT INTO circle_sharing_preferences (
                circle_id, user_id, sharing_mode, enabled_since,
                created_at, updated_at
            )
            VALUES
                (?, ?, 'LATEST_ONLY', ?, ?, ?),
                (?, ?, 'LATEST_ONLY', ?, ?, ?)
            ON CONFLICT (circle_id, user_id) DO NOTHING
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, circleId)
            statement.setObject(2, firstUserId)
            statement.setObject(3, now)
            statement.setObject(4, now)
            statement.setObject(5, now)
            statement.setObject(6, circleId)
            statement.setObject(7, secondUserId)
            statement.setObject(8, now)
            statement.setObject(9, now)
            statement.setObject(10, now)
            statement.executeUpdate()
        }
    }

    private fun listPeople(connection: Connection, currentUserId: UUID): List<PersonSnapshot> =
        connection.prepareStatement(
            """
            WITH direct_people AS (
                SELECT c.id, c.created_at,
                       CASE WHEN c.direct_user_low_id = ?
                            THEN c.direct_user_high_id
                            ELSE c.direct_user_low_id END AS other_user_id
                  FROM circles c
                 WHERE c.kind = 'DIRECT' AND c.archived_at IS NULL
                   AND ? IN (c.direct_user_low_id, c.direct_user_high_id)
            )
            SELECT direct_people.id AS circle_id, direct_people.created_at,
                   other.public_id, other.display_name,
                   mine.sharing_mode AS my_sharing_mode,
                   theirs.sharing_mode AS their_sharing_mode,
                   CASE
                       WHEN theirs.sharing_mode = 'OFF' THEN 'HIDDEN'
                       WHEN latest.checked_at IS NOT NULL THEN 'AVAILABLE'
                       WHEN theirs.enabled_since > theirs.created_at
                           THEN 'WAITING_AFTER_REENABLE'
                       ELSE 'WAITING_INITIAL'
                   END AS check_in_state,
                   latest.checked_at AS last_check_in_at
              FROM direct_people
              JOIN app_users other
                ON other.id = direct_people.other_user_id
               AND other.deleted_at IS NULL
              JOIN circle_sharing_preferences mine
                ON mine.circle_id = direct_people.id AND mine.user_id = ?
              JOIN circle_sharing_preferences theirs
                ON theirs.circle_id = direct_people.id
               AND theirs.user_id = direct_people.other_user_id
              LEFT JOIN LATERAL (
                  SELECT event.checked_at
                    FROM check_in_audiences audience
                    JOIN check_ins event
                      ON event.id = audience.check_in_id
                     AND event.user_id = audience.actor_user_id
                   WHERE audience.circle_id = direct_people.id
                     AND audience.circle_kind = 'DIRECT'
                     AND audience.recipient_user_id = ?
                     AND audience.actor_user_id = direct_people.other_user_id
                     AND theirs.sharing_mode <> 'OFF'
                     AND theirs.enabled_since IS NOT NULL
                     AND event.checked_at >= theirs.enabled_since
                   ORDER BY event.checked_at DESC
                   LIMIT 1
              ) latest ON TRUE
             ORDER BY lower(other.display_name), other.public_id
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, currentUserId)
            statement.setObject(2, currentUserId)
            statement.setObject(3, currentUserId)
            statement.setObject(4, currentUserId)
            statement.executeQuery().use { result ->
                buildList {
                    while (result.next()) add(result.toPersonSnapshot())
                }
            }
        }

    private fun countAudienceRecipients(connection: Connection, currentUserId: UUID): Int =
        connection.prepareStatement(
            """
            SELECT count(DISTINCT recipients.user_id)
              FROM (
                    SELECT CASE WHEN circle.direct_user_low_id = ?
                                THEN circle.direct_user_high_id
                                ELSE circle.direct_user_low_id END AS user_id
                      FROM circles circle
                      JOIN circle_sharing_preferences preference
                        ON preference.circle_id = circle.id
                       AND preference.user_id = ?
                       AND preference.sharing_mode <> 'OFF'
                     WHERE circle.kind = 'DIRECT' AND circle.archived_at IS NULL
                       AND ? IN (circle.direct_user_low_id, circle.direct_user_high_id)
                    UNION ALL
                    SELECT recipient.user_id
                      FROM circle_memberships actor
                      JOIN circles circle
                        ON circle.id = actor.circle_id
                       AND circle.kind = 'GROUP'
                       AND circle.archived_at IS NULL
                      JOIN circle_sharing_preferences preference
                        ON preference.circle_id = circle.id
                       AND preference.user_id = actor.user_id
                       AND preference.sharing_mode <> 'OFF'
                      JOIN circle_memberships recipient
                        ON recipient.circle_id = circle.id
                       AND recipient.left_at IS NULL
                       AND recipient.history_visibility <> 'NONE'
                       AND recipient.user_id <> actor.user_id
                     WHERE actor.user_id = ? AND actor.left_at IS NULL
              ) recipients
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, currentUserId)
            statement.setObject(2, currentUserId)
            statement.setObject(3, currentUserId)
            statement.setObject(4, currentUserId)
            statement.executeQuery().use { result ->
                check(result.next())
                result.getInt(1)
            }
        }

    private fun listRequests(connection: Connection, currentUserId: UUID): List<DirectRequestSnapshot> =
        connection.prepareStatement(
            """
            SELECT r.id, r.requester_user_id, r.recipient_user_id,
                   r.created_at, r.expires_at,
                   other.public_id, other.display_name
              FROM direct_requests r
              JOIN app_users other
                ON other.id = CASE WHEN r.requester_user_id = ?
                                   THEN r.recipient_user_id
                                   ELSE r.requester_user_id END
               AND other.deleted_at IS NULL
             WHERE r.status = 'PENDING'
               AND ? IN (r.requester_user_id, r.recipient_user_id)
             ORDER BY r.created_at DESC
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, currentUserId)
            statement.setObject(2, currentUserId)
            statement.executeQuery().use { result ->
                buildList {
                    while (result.next()) {
                        add(
                            DirectRequestSnapshot(
                                requestId = result.getObject("id", UUID::class.java),
                                direction = if (
                                    result.getObject("requester_user_id", UUID::class.java) == currentUserId
                                ) RequestDirection.OUTGOING else RequestDirection.INCOMING,
                                user = UserReference(
                                    result.getString("public_id"),
                                    result.getString("display_name"),
                                ),
                                createdAt = result.getObject("created_at", OffsetDateTime::class.java),
                                expiresAt = result.getObject("expires_at", OffsetDateTime::class.java),
                            ),
                        )
                    }
                }
            }
        }

    private fun findPerson(
        connection: Connection,
        circleId: UUID,
        currentUserId: UUID,
    ): PersonSnapshot? = connection.prepareStatement(
        """
        WITH direct_person AS (
            SELECT c.id, c.created_at,
                   CASE WHEN c.direct_user_low_id = ?
                        THEN c.direct_user_high_id
                        ELSE c.direct_user_low_id END AS other_user_id
              FROM circles c
             WHERE c.id = ? AND c.kind = 'DIRECT' AND c.archived_at IS NULL
               AND ? IN (c.direct_user_low_id, c.direct_user_high_id)
        )
        SELECT direct_person.id AS circle_id, direct_person.created_at,
               other.public_id, other.display_name,
               mine.sharing_mode AS my_sharing_mode,
               theirs.sharing_mode AS their_sharing_mode,
               CASE
                   WHEN theirs.sharing_mode = 'OFF' THEN 'HIDDEN'
                   WHEN latest.checked_at IS NOT NULL THEN 'AVAILABLE'
                   WHEN theirs.enabled_since > theirs.created_at
                       THEN 'WAITING_AFTER_REENABLE'
                   ELSE 'WAITING_INITIAL'
               END AS check_in_state,
               latest.checked_at AS last_check_in_at
          FROM direct_person
          JOIN app_users other
            ON other.id = direct_person.other_user_id
           AND other.deleted_at IS NULL
          JOIN circle_sharing_preferences mine
            ON mine.circle_id = direct_person.id AND mine.user_id = ?
          JOIN circle_sharing_preferences theirs
            ON theirs.circle_id = direct_person.id
           AND theirs.user_id = direct_person.other_user_id
          LEFT JOIN LATERAL (
              SELECT event.checked_at
                FROM check_in_audiences audience
                JOIN check_ins event
                  ON event.id = audience.check_in_id
                 AND event.user_id = audience.actor_user_id
               WHERE audience.circle_id = direct_person.id
                 AND audience.circle_kind = 'DIRECT'
                 AND audience.recipient_user_id = ?
                 AND audience.actor_user_id = direct_person.other_user_id
                 AND theirs.sharing_mode <> 'OFF'
                 AND theirs.enabled_since IS NOT NULL
                 AND event.checked_at >= theirs.enabled_since
               ORDER BY event.checked_at DESC
               LIMIT 1
          ) latest ON TRUE
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, currentUserId)
        statement.setObject(2, circleId)
        statement.setObject(3, currentUserId)
        statement.setObject(4, currentUserId)
        statement.setObject(5, currentUserId)
        statement.executeQuery().use { result ->
            if (result.next()) result.toPersonSnapshot() else null
        }
    }

    private fun findCircleForUser(
        connection: Connection,
        circleId: UUID,
        userId: UUID,
        lock: Boolean,
    ): CircleRow? {
        val suffix = if (lock) " FOR UPDATE" else ""
        return connection.prepareStatement(
            """
            SELECT id, archived_at
              FROM circles
             WHERE id = ? AND kind = 'DIRECT'
               AND ? IN (direct_user_low_id, direct_user_high_id)
            $suffix
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, circleId)
            statement.setObject(2, userId)
            statement.executeQuery().use { result ->
                if (result.next()) {
                    CircleRow(
                        id = result.getObject("id", UUID::class.java),
                        archivedAt = result.getObject("archived_at", OffsetDateTime::class.java),
                    )
                } else null
            }
        }
    }

    private fun RequestRow.toSnapshot(
        connection: Connection,
        currentUserId: UUID,
    ): DirectRequestSnapshot {
        val direction = if (requesterUserId == currentUserId) {
            RequestDirection.OUTGOING
        } else {
            RequestDirection.INCOMING
        }
        val relatedUserId = if (direction == RequestDirection.OUTGOING) recipientUserId else requesterUserId
        return DirectRequestSnapshot(
            requestId = id,
            direction = direction,
            user = findUser(connection, relatedUserId),
            createdAt = createdAt,
            expiresAt = expiresAt,
        )
    }

    private fun ResultSet.toUserRow() = UserRow(
        id = getObject("id", UUID::class.java),
        reference = UserReference(getString("public_id"), getString("display_name")),
    )

    private fun ResultSet.toRequestRow() = RequestRow(
        id = getObject("id", UUID::class.java),
        requesterUserId = getObject("requester_user_id", UUID::class.java),
        recipientUserId = getObject("recipient_user_id", UUID::class.java),
        status = getString("status"),
        resultCircleId = getObject("result_circle_id", UUID::class.java),
        createdAt = getObject("created_at", OffsetDateTime::class.java),
        expiresAt = getObject("expires_at", OffsetDateTime::class.java),
        respondedAt = getObject("responded_at", OffsetDateTime::class.java),
        idempotencyKey = getObject("idempotency_key", UUID::class.java),
    )

    private fun ResultSet.toPersonSnapshot() = PersonSnapshot(
        circleId = getObject("circle_id", UUID::class.java),
        user = UserReference(getString("public_id"), getString("display_name")),
        connectedAt = getObject("created_at", OffsetDateTime::class.java),
        mySharingMode = SharingMode.valueOf(getString("my_sharing_mode")),
        theirSharingMode = SharingMode.valueOf(getString("their_sharing_mode")),
        checkInState = PersonCheckInState.valueOf(getString("check_in_state")),
        lastCheckInAt = getObject("last_check_in_at", OffsetDateTime::class.java),
    )

    private fun <T> inTransaction(block: (Connection) -> T): T = dataSource.connection.use { connection ->
        try {
            block(connection).also { connection.commit() }
        } catch (error: Throwable) {
            connection.rollback()
            throw error
        }
    }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    private data class UserRow(val id: UUID, val reference: UserReference)

    private data class RequestRow(
        val id: UUID,
        val requesterUserId: UUID,
        val recipientUserId: UUID,
        val status: String,
        val resultCircleId: UUID?,
        val createdAt: OffsetDateTime,
        val expiresAt: OffsetDateTime,
        val respondedAt: OffsetDateTime?,
        val idempotencyKey: UUID,
    )

    private data class CircleRow(val id: UUID, val archivedAt: OffsetDateTime?)
}
