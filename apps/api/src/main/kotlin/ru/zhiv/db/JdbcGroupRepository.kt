package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.groups.GroupInviteAction
import ru.zhiv.groups.GroupInviteDirection
import ru.zhiv.groups.GroupInviteSnapshot
import ru.zhiv.groups.GroupMemberSnapshot
import ru.zhiv.groups.GroupMutationSnapshot
import ru.zhiv.groups.GroupRemovedSnapshot
import ru.zhiv.groups.GroupRepository
import ru.zhiv.groups.GroupResult
import ru.zhiv.groups.GroupRole
import ru.zhiv.groups.GroupSnapshot
import ru.zhiv.groups.GroupsSnapshot
import ru.zhiv.relationships.SharingMode
import ru.zhiv.relationships.UserReference
import java.security.SecureRandom
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

class JdbcGroupRepository(
    private val dataSource: DataSource,
) : GroupRepository {
    private val random = SecureRandom()

    override suspend fun listGroups(
        sessionTokenHash: ByteArray,
    ): GroupResult<GroupsSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = authenticateForUpdate(connection, sessionTokenHash)
                ?: return@inTransaction GroupResult.Unauthorized
            val now = serverTime(connection)
            expireInvites(connection, currentUserId, now)
            val invites = listInvites(connection, currentUserId)
            val groups = listGroupRows(connection, currentUserId).map { row ->
                GroupSnapshot(
                    groupId = row.groupId,
                    title = row.title,
                    emoji = row.emoji,
                    myRole = row.myRole,
                    mySharingMode = row.mySharingMode,
                    sharingMixed = row.sharingMixed,
                    createdAt = row.createdAt,
                    members = listMembers(
                        connection,
                        row.groupId,
                        currentUserId,
                        row.myMembershipId,
                    ),
                    pendingInvites = invites.filter {
                        it.direction == GroupInviteDirection.OUTGOING && it.groupId == row.groupId
                    },
                )
            }
            GroupResult.Success(
                GroupsSnapshot(
                    groups = groups,
                    incomingInvites = invites.filter {
                        it.direction == GroupInviteDirection.INCOMING
                    },
                    outgoingInvites = invites.filter {
                        it.direction == GroupInviteDirection.OUTGOING
                    },
                    serverTime = serverTime(connection),
                ),
            )
        }
    }

    override suspend fun createGroup(
        sessionTokenHash: ByteArray,
        title: String,
        emoji: String?,
        inviteeCircleIds: List<UUID>,
        idempotencyKey: UUID,
    ): GroupResult<GroupMutationSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = findCurrentUser(connection, sessionTokenHash)
                ?: return@inTransaction GroupResult.Unauthorized
            findGroupCreationReplay(connection, currentUserId, idempotencyKey)?.let {
                lockUsers(connection, setOf(currentUserId))
                if (findCurrentUser(connection, sessionTokenHash) != currentUserId) {
                    return@inTransaction GroupResult.Unauthorized
                }
                val groupId = findGroupCreationReplay(connection, currentUserId, idempotencyKey)
                    ?: return@inTransaction GroupResult.Conflict
                return@inTransaction GroupResult.Success(
                    GroupMutationSnapshot(groupId, replayed = true, serverTime = serverTime(connection)),
                )
            }

            val initialTargets = linkedMapOf<UUID, UUID>()
            inviteeCircleIds.forEach { personCircleId ->
                val target = targetFromDirectCircle(connection, personCircleId, currentUserId)
                    ?: return@inTransaction GroupResult.Forbidden
                initialTargets[personCircleId] = target
            }
            val initialTargetUserIds = initialTargets.values.toSet()
            if (initialTargetUserIds.size > 20) return@inTransaction GroupResult.Conflict

            lockUsers(connection, initialTargetUserIds + currentUserId)
            if (findCurrentUser(connection, sessionTokenHash) != currentUserId) {
                return@inTransaction GroupResult.Unauthorized
            }
            findGroupCreationReplay(connection, currentUserId, idempotencyKey)?.let { groupId ->
                return@inTransaction GroupResult.Success(
                    GroupMutationSnapshot(groupId, replayed = true, serverTime = serverTime(connection)),
                )
            }
            val targetUserIds = inviteeCircleIds.map { personCircleId ->
                val target = targetFromDirectCircle(connection, personCircleId, currentUserId)
                    ?: return@inTransaction GroupResult.Forbidden
                if (target != initialTargets[personCircleId]) {
                    return@inTransaction GroupResult.Conflict
                }
                target
            }.toSet()
            val now = serverTime(connection)
            if (countOwnedGroups(connection, currentUserId) >= 20) {
                return@inTransaction GroupResult.Conflict
            }

            val groupId = connection.prepareStatement(
                """
                INSERT INTO circles (
                    kind, title, emoji, created_by_user_id,
                    creation_idempotency_key, created_at
                )
                VALUES ('GROUP', ?, ?, ?, ?, ?)
                RETURNING id
                """.trimIndent(),
            ).use { statement ->
                statement.setString(1, title)
                statement.setString(2, emoji)
                statement.setObject(3, currentUserId)
                statement.setObject(4, idempotencyKey)
                statement.setObject(5, now)
                statement.executeQuery().use { result ->
                    check(result.next())
                    result.getObject("id", UUID::class.java)
                }
            }
            insertMembership(connection, groupId, currentUserId, GroupRole.OWNER, now)
            enableSharing(connection, groupId, currentUserId, now, reset = false)
            targetUserIds.forEach { inviteeUserId ->
                insertInvite(
                    connection,
                    groupId,
                    currentUserId,
                    inviteeUserId,
                    UUID.randomUUID(),
                    now,
                )
            }
            GroupResult.Success(
                GroupMutationSnapshot(groupId, replayed = false, serverTime = now),
            )
        }
    }

    override suspend fun updateGroup(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        title: String,
        emoji: String?,
    ): GroupResult<GroupMutationSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = authenticateForUpdate(connection, sessionTokenHash)
                ?: return@inTransaction GroupResult.Unauthorized
            val membership = findActiveMembership(connection, groupId, currentUserId, lock = true)
                ?: return@inTransaction GroupResult.NotFound
            if (membership.role != GroupRole.OWNER) return@inTransaction GroupResult.Forbidden
            val now = serverTime(connection)
            connection.prepareStatement(
                "UPDATE circles SET title = ?, emoji = ? WHERE id = ? AND kind = 'GROUP' AND archived_at IS NULL",
            ).use { statement ->
                statement.setString(1, title)
                statement.setString(2, emoji)
                statement.setObject(3, groupId)
                if (statement.executeUpdate() != 1) return@inTransaction GroupResult.NotFound
            }
            GroupResult.Success(GroupMutationSnapshot(groupId, replayed = false, serverTime = now))
        }
    }

    override suspend fun updateSharing(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        sharingMode: SharingMode,
    ): GroupResult<GroupMutationSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = authenticateForUpdate(connection, sessionTokenHash)
                ?: return@inTransaction GroupResult.Unauthorized
            findActiveMembership(connection, groupId, currentUserId, lock = true)
                ?: return@inTransaction GroupResult.NotFound
            val now = serverTime(connection)
            connection.prepareStatement("""
                INSERT INTO recipient_sharing_preferences(actor_user_id,recipient_user_id,sharing_mode)
                SELECT ?, user_id, ? FROM circle_memberships WHERE circle_id=? AND left_at IS NULL AND user_id<>?
                ON CONFLICT(actor_user_id,recipient_user_id) DO UPDATE SET sharing_mode=EXCLUDED.sharing_mode
            """.trimIndent()).use {
                it.setObject(1,currentUserId); it.setString(2,sharingMode.name); it.setObject(3,groupId); it.setObject(4,currentUserId); it.executeUpdate()
            }
            if (sharingMode == SharingMode.OFF) {
                disableSharing(connection, groupId, currentUserId)
            } else {
                enableSharing(connection, groupId, currentUserId, now, reset = false)
            }
            GroupResult.Success(GroupMutationSnapshot(groupId, replayed = false, serverTime = now))
        }
    }

    override suspend fun inviteMember(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        personCircleId: UUID,
        idempotencyKey: UUID,
    ): GroupResult<GroupMutationSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = findCurrentUser(connection, sessionTokenHash)
                ?: return@inTransaction GroupResult.Unauthorized
            val initialTargetUserId = targetFromDirectCircle(
                connection,
                personCircleId,
                currentUserId,
            ) ?: return@inTransaction GroupResult.Forbidden
            lockUsers(connection, setOf(currentUserId, initialTargetUserId))
            if (findCurrentUser(connection, sessionTokenHash) != currentUserId) {
                return@inTransaction GroupResult.Unauthorized
            }
            val membership = findActiveMembership(connection, groupId, currentUserId, lock = true)
                ?: return@inTransaction GroupResult.NotFound
            if (membership.role != GroupRole.OWNER) return@inTransaction GroupResult.Forbidden
            val targetUserId = targetFromDirectCircle(connection, personCircleId, currentUserId)
                ?: return@inTransaction GroupResult.Forbidden
            if (targetUserId != initialTargetUserId) return@inTransaction GroupResult.Conflict
            val now = serverTime(connection)
            findInviteReplay(connection, currentUserId, idempotencyKey)?.let { replay ->
                if (replay.groupId != groupId || replay.inviteeUserId != targetUserId) {
                    return@inTransaction GroupResult.Conflict
                }
                return@inTransaction GroupResult.Success(
                    GroupMutationSnapshot(groupId, replayed = true, serverTime = now),
                )
            }
            if (findActiveMembership(connection, groupId, targetUserId, lock = false) != null) {
                return@inTransaction GroupResult.Conflict
            }
            expireGroupInvites(connection, groupId, now)
            if (findPendingInvite(connection, groupId, targetUserId) != null) {
                return@inTransaction GroupResult.Success(
                    GroupMutationSnapshot(groupId, replayed = true, serverTime = now),
                )
            }
            if (countActiveMembersAndInvites(connection, groupId) >= 50) {
                return@inTransaction GroupResult.Conflict
            }
            insertInvite(connection, groupId, currentUserId, targetUserId, idempotencyKey, now)
            GroupResult.Success(GroupMutationSnapshot(groupId, replayed = false, serverTime = now))
        }
    }

    override suspend fun actOnInvite(
        sessionTokenHash: ByteArray,
        inviteId: UUID,
        action: GroupInviteAction,
    ): GroupResult<GroupMutationSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = authenticateForUpdate(connection, sessionTokenHash)
                ?: return@inTransaction GroupResult.Unauthorized
            val invite = findInvite(connection, inviteId, lock = true)
                ?: return@inTransaction GroupResult.NotFound
            if (invite.inviteeUserId != currentUserId) return@inTransaction GroupResult.Forbidden
            val now = serverTime(connection)
            if (invite.status != "PENDING") {
                if (invite.status != action.name) return@inTransaction GroupResult.Conflict
                return@inTransaction GroupResult.Success(
                    GroupMutationSnapshot(invite.groupId, replayed = true, serverTime = now),
                )
            }
            if (!invite.expiresAt.isAfter(now)) {
                revokeInviteRow(connection, invite.id, now)
                return@inTransaction GroupResult.Expired
            }
            if (!isActiveGroup(connection, invite.groupId)) return@inTransaction GroupResult.NotFound

            if (action == GroupInviteAction.ACCEPTED) {
                if (findActiveMembership(connection, invite.groupId, currentUserId, lock = true) != null) {
                    return@inTransaction GroupResult.Conflict
                }
                insertMembership(connection, invite.groupId, currentUserId, GroupRole.MEMBER, now)
                enableSharing(connection, invite.groupId, currentUserId, now, reset = true)
                connection.prepareStatement(
                    """
                    UPDATE circle_invites
                       SET status = 'ACCEPTED', accepted_by_user_id = ?, accepted_at = ?
                     WHERE id = ? AND status = 'PENDING'
                    """.trimIndent(),
                ).use { statement ->
                    statement.setObject(1, currentUserId)
                    statement.setObject(2, now)
                    statement.setObject(3, invite.id)
                    check(statement.executeUpdate() == 1)
                }
                connection.prepareStatement("SELECT preserve_recipient_denies(?)").use { it.setObject(1,currentUserId); it.execute() }
            } else {
                revokeInviteRow(connection, invite.id, now)
            }
            GroupResult.Success(
                GroupMutationSnapshot(invite.groupId, replayed = false, serverTime = now),
            )
        }
    }

    override suspend fun revokeInvite(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        inviteId: UUID,
    ): GroupResult<GroupRemovedSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = authenticateForUpdate(connection, sessionTokenHash)
                ?: return@inTransaction GroupResult.Unauthorized
            val membership = findActiveMembership(connection, groupId, currentUserId, lock = true)
                ?: return@inTransaction GroupResult.NotFound
            if (membership.role != GroupRole.OWNER) return@inTransaction GroupResult.Forbidden
            val invite = findInvite(connection, inviteId, lock = true)
                ?.takeIf { it.groupId == groupId }
                ?: return@inTransaction GroupResult.NotFound
            if (invite.inviterUserId != currentUserId) return@inTransaction GroupResult.Forbidden
            val now = serverTime(connection)
            if (invite.status == "PENDING") revokeInviteRow(connection, invite.id, now)
            GroupResult.Success(GroupRemovedSnapshot(now))
        }
    }

    override suspend fun removeMember(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        membershipId: UUID,
    ): GroupResult<GroupRemovedSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = authenticateForUpdate(connection, sessionTokenHash)
                ?: return@inTransaction GroupResult.Unauthorized
            val target = findMembershipForRemoval(connection, groupId, membershipId)
                ?: return@inTransaction GroupResult.NotFound
            val mine = findActiveMembership(connection, groupId, currentUserId, lock = true)
            val removingSelf = target.userId == currentUserId
            if (target.leftAt != null) {
                if (removingSelf || (mine?.role == GroupRole.OWNER && target.role != GroupRole.OWNER)) {
                    return@inTransaction GroupResult.Success(GroupRemovedSnapshot(target.leftAt))
                }
                return@inTransaction if (mine == null) GroupResult.NotFound else GroupResult.Forbidden
            }
            if (mine == null) return@inTransaction GroupResult.NotFound
            if ((!removingSelf && mine.role != GroupRole.OWNER) || target.role == GroupRole.OWNER) {
                return@inTransaction GroupResult.Forbidden
            }
            val now = serverTime(connection)
            disableSharing(connection, groupId, target.userId)
            closeMembership(connection, target.id, now)
            GroupResult.Success(GroupRemovedSnapshot(now))
        }
    }

    override suspend fun archiveGroup(
        sessionTokenHash: ByteArray,
        groupId: UUID,
    ): GroupResult<GroupRemovedSnapshot> = io {
        inTransaction { connection ->
            val currentUserId = authenticateForUpdate(connection, sessionTokenHash)
                ?: return@inTransaction GroupResult.Unauthorized
            val group = findGroupForCreator(connection, groupId, currentUserId)
                ?: return@inTransaction GroupResult.NotFound
            if (group.archivedAt != null) {
                return@inTransaction GroupResult.Success(GroupRemovedSnapshot(group.archivedAt))
            }
            findActiveMembership(connection, groupId, currentUserId, lock = true)
                ?.takeIf { it.role == GroupRole.OWNER }
                ?: return@inTransaction GroupResult.Forbidden
            val now = serverTime(connection)
            activeMemberUserIds(connection, groupId).forEach { userId ->
                disableSharing(connection, groupId, userId)
            }
            connection.prepareStatement(
                "UPDATE circle_memberships SET left_at = ? WHERE circle_id = ? AND left_at IS NULL",
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, groupId)
                statement.executeUpdate()
            }
            connection.prepareStatement(
                """
                UPDATE circle_invites
                   SET status = 'REVOKED', revoked_at = ?
                 WHERE circle_id = ? AND status = 'PENDING'
                """.trimIndent(),
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, groupId)
                statement.executeUpdate()
            }
            connection.prepareStatement(
                "UPDATE circles SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, groupId)
                check(statement.executeUpdate() == 1)
            }
            GroupResult.Success(GroupRemovedSnapshot(now))
        }
    }

    private fun listGroupRows(connection: Connection, currentUserId: UUID): List<GroupRow> =
        connection.prepareStatement(
            """
            SELECT circle.id AS group_id, circle.title, circle.emoji, circle.created_at,
                   membership.id AS membership_id, membership.role,
                   CASE WHEN modes.total=0 THEN preference.sharing_mode WHEN modes.enabled=modes.total THEN 'LATEST_ONLY' ELSE 'OFF' END AS sharing_mode,
                   (modes.enabled>0 AND modes.enabled<modes.total) AS sharing_mixed
              FROM circle_memberships membership
              JOIN circles circle
                ON circle.id = membership.circle_id
               AND circle.kind = 'GROUP'
               AND circle.archived_at IS NULL
              JOIN circle_sharing_preferences preference
                ON preference.circle_id = circle.id
               AND preference.user_id = membership.user_id
              CROSS JOIN LATERAL (
                SELECT count(*) AS total, count(*) FILTER (WHERE p.sharing_mode<>'OFF') AS enabled
                FROM circle_memberships recipient
                CROSS JOIN LATERAL effective_recipient_sharing(membership.user_id,recipient.user_id) p
                WHERE recipient.circle_id=circle.id AND recipient.left_at IS NULL AND recipient.user_id<>membership.user_id
              ) modes
             WHERE membership.user_id = ? AND membership.left_at IS NULL
             ORDER BY lower(circle.title), circle.created_at
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, currentUserId)
            statement.executeQuery().use { result ->
                buildList {
                    while (result.next()) {
                        add(
                            GroupRow(
                                groupId = result.getObject("group_id", UUID::class.java),
                                title = result.getString("title"),
                                emoji = result.getString("emoji"),
                                createdAt = result.getObject("created_at", OffsetDateTime::class.java),
                                myMembershipId = result.getObject("membership_id", UUID::class.java),
                                myRole = GroupRole.valueOf(result.getString("role")),
                                mySharingMode = SharingMode.valueOf(result.getString("sharing_mode")),
                                sharingMixed = result.getBoolean("sharing_mixed"),
                            ),
                        )
                    }
                }
            }
        }

    private fun listMembers(
        connection: Connection,
        groupId: UUID,
        currentUserId: UUID,
        currentMembershipId: UUID,
    ): List<GroupMemberSnapshot> = connection.prepareStatement(
        """
        SELECT membership.id AS membership_id, membership.user_id, membership.role,
               membership.joined_at, person.public_id, person.display_name,
               CASE WHEN membership.id=CAST(? AS uuid) OR (preference.sharing_mode<>'OFF' AND person.status_updated_at>=preference.enabled_since) THEN person.status_text END AS status_text,
               CASE WHEN membership.id=CAST(? AS uuid) OR (preference.sharing_mode<>'OFF' AND person.status_updated_at>=preference.enabled_since) THEN person.status_updated_at END AS status_updated_at,
               preference.sharing_mode, latest.checked_at AS last_check_in_at
          FROM circle_memberships membership
          JOIN app_users person ON person.id = membership.user_id AND person.deleted_at IS NULL
          CROSS JOIN LATERAL effective_recipient_sharing(membership.user_id,CAST(? AS uuid)) preference
          LEFT JOIN LATERAL (
              SELECT event.checked_at
                FROM check_in_audiences audience
                JOIN check_ins event
                  ON event.id = audience.check_in_id
                 AND event.user_id = audience.actor_user_id
               WHERE audience.circle_id = membership.circle_id
                 AND audience.circle_kind = 'GROUP'
                 AND audience.actor_user_id = membership.user_id
                 AND audience.recipient_user_id = ?
                 AND audience.recipient_membership_id = ?
                 AND preference.sharing_mode <> 'OFF'
                 AND preference.enabled_since IS NOT NULL
                 AND event.checked_at >= preference.enabled_since
               ORDER BY event.checked_at DESC
               LIMIT 1
          ) latest ON TRUE
         WHERE membership.circle_id = ? AND membership.left_at IS NULL
         ORDER BY CASE WHEN membership.user_id = ? THEN 0 ELSE 1 END,
                  lower(person.display_name), person.public_id
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, currentMembershipId)
        statement.setObject(2, currentMembershipId)
        statement.setObject(3, currentUserId)
        statement.setObject(4, currentUserId)
        statement.setObject(5, currentMembershipId)
        statement.setObject(6, groupId)
        statement.setObject(7, currentUserId)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    add(
                        GroupMemberSnapshot(
                            statusText=result.getString("status_text"),
                            statusUpdatedAt=result.getObject("status_updated_at", OffsetDateTime::class.java),
                            membershipId = result.getObject("membership_id", UUID::class.java),
                            user = UserReference(
                                result.getString("public_id"),
                                result.getString("display_name"),
                            ),
                            role = GroupRole.valueOf(result.getString("role")),
                            sharingMode = SharingMode.valueOf(result.getString("sharing_mode")),
                            lastCheckInAt = result.getObject(
                                "last_check_in_at",
                                OffsetDateTime::class.java,
                            ),
                            joinedAt = result.getObject("joined_at", OffsetDateTime::class.java),
                            isMe = result.getObject("user_id", UUID::class.java) == currentUserId,
                        ),
                    )
                }
            }
        }
    }

    private fun listInvites(
        connection: Connection,
        currentUserId: UUID,
    ): List<GroupInviteSnapshot> = connection.prepareStatement(
        """
        SELECT invite.id, invite.circle_id, invite.inviter_user_id,
               invite.invitee_user_id, invite.created_at, invite.expires_at,
               circle.title, circle.emoji,
               person.public_id, person.display_name
          FROM circle_invites invite
          JOIN circles circle
            ON circle.id = invite.circle_id
           AND circle.kind = 'GROUP'
           AND circle.archived_at IS NULL
          JOIN app_users person
            ON person.id = CASE WHEN invite.invitee_user_id = ?
                                THEN invite.inviter_user_id
                                ELSE invite.invitee_user_id END
           AND person.deleted_at IS NULL
         WHERE invite.status = 'PENDING'
           AND invite.expires_at > clock_timestamp()
           AND ? IN (invite.inviter_user_id, invite.invitee_user_id)
         ORDER BY invite.created_at DESC
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, currentUserId)
        statement.setObject(2, currentUserId)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    val incoming = result.getObject(
                        "invitee_user_id",
                        UUID::class.java,
                    ) == currentUserId
                    add(
                        GroupInviteSnapshot(
                            inviteId = result.getObject("id", UUID::class.java),
                            direction = if (incoming) {
                                GroupInviteDirection.INCOMING
                            } else {
                                GroupInviteDirection.OUTGOING
                            },
                            groupId = result.getObject("circle_id", UUID::class.java),
                            groupTitle = result.getString("title"),
                            groupEmoji = result.getString("emoji"),
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

    private fun findCurrentUser(connection: Connection, tokenHash: ByteArray): UUID? =
        connection.prepareStatement(
            """
            SELECT user_account.id
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
                if (result.next()) result.getObject("id", UUID::class.java) else null
            }
        }

    private fun authenticateForUpdate(connection: Connection, tokenHash: ByteArray): UUID? {
        val userId = findCurrentUser(connection, tokenHash) ?: return null
        lockUsers(connection, setOf(userId))
        return findCurrentUser(connection, tokenHash)?.takeIf { it == userId }
    }

    private fun lockUsers(connection: Connection, userIds: Set<UUID>) {
        if (userIds.isEmpty()) return
        val ordered = userIds.sorted()
        val placeholders = ordered.joinToString(",") { "?" }
        connection.prepareStatement(
            "SELECT id FROM app_users WHERE id IN ($placeholders) ORDER BY id FOR NO KEY UPDATE",
        ).use { statement ->
            ordered.forEachIndexed { index, userId -> statement.setObject(index + 1, userId) }
            statement.executeQuery().use { result ->
                var count = 0
                while (result.next()) count++
                check(count == ordered.size)
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

    private fun findGroupCreationReplay(
        connection: Connection,
        userId: UUID,
        idempotencyKey: UUID,
    ): UUID? = connection.prepareStatement(
        """
        SELECT id FROM circles
         WHERE kind = 'GROUP' AND created_by_user_id = ?
           AND creation_idempotency_key = ?
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, userId)
        statement.setObject(2, idempotencyKey)
        statement.executeQuery().use { result ->
            if (result.next()) result.getObject("id", UUID::class.java) else null
        }
    }

    private fun countOwnedGroups(connection: Connection, userId: UUID): Int =
        connection.prepareStatement(
            "SELECT count(*) FROM circles WHERE kind = 'GROUP' AND created_by_user_id = ? AND archived_at IS NULL",
        ).use { statement ->
            statement.setObject(1, userId)
            statement.executeQuery().use { result ->
                check(result.next())
                result.getInt(1)
            }
        }

    private fun targetFromDirectCircle(
        connection: Connection,
        personCircleId: UUID,
        currentUserId: UUID,
    ): UUID? = connection.prepareStatement(
        """
        SELECT CASE WHEN direct_user_low_id = ?
                    THEN direct_user_high_id ELSE direct_user_low_id END AS target_user_id
          FROM circles
         WHERE id = ? AND kind = 'DIRECT' AND archived_at IS NULL
           AND ? IN (direct_user_low_id, direct_user_high_id)
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, currentUserId)
        statement.setObject(2, personCircleId)
        statement.setObject(3, currentUserId)
        statement.executeQuery().use { result ->
            if (result.next()) result.getObject("target_user_id", UUID::class.java) else null
        }
    }

    private fun insertMembership(
        connection: Connection,
        groupId: UUID,
        userId: UUID,
        role: GroupRole,
        now: OffsetDateTime,
    ): UUID = connection.prepareStatement(
        """
        INSERT INTO circle_memberships (circle_id, user_id, role, joined_at)
        VALUES (?, ?, ?, ?)
        RETURNING id
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, groupId)
        statement.setObject(2, userId)
        statement.setString(3, role.name)
        statement.setObject(4, now)
        statement.executeQuery().use { result ->
            check(result.next())
            result.getObject("id", UUID::class.java)
        }
    }

    private fun enableSharing(
        connection: Connection,
        groupId: UUID,
        userId: UUID,
        now: OffsetDateTime,
        reset: Boolean,
    ) {
        if (reset) disableSharing(connection, groupId, userId, insertIfMissing = false)
        connection.prepareStatement(
            """
            INSERT INTO circle_sharing_preferences (
                circle_id, user_id, sharing_mode, enabled_since, created_at, updated_at
            )
            VALUES (?, ?, 'LATEST_ONLY', ?, ?, ?)
            ON CONFLICT (circle_id, user_id) DO UPDATE
                SET sharing_mode = 'LATEST_ONLY'
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, groupId)
            statement.setObject(2, userId)
            statement.setObject(3, now)
            statement.setObject(4, now)
            statement.setObject(5, now)
            statement.executeUpdate()
        }
    }

    private fun disableSharing(
        connection: Connection,
        groupId: UUID,
        userId: UUID,
        insertIfMissing: Boolean = true,
    ) {
        val sql = if (insertIfMissing) {
            """
            INSERT INTO circle_sharing_preferences (
                circle_id, user_id, sharing_mode, enabled_since
            ) VALUES (?, ?, 'OFF', NULL)
            ON CONFLICT (circle_id, user_id) DO UPDATE SET sharing_mode = 'OFF'
            """.trimIndent()
        } else {
            "UPDATE circle_sharing_preferences SET sharing_mode = 'OFF' WHERE circle_id = ? AND user_id = ?"
        }
        connection.prepareStatement(sql).use { statement ->
            statement.setObject(1, groupId)
            statement.setObject(2, userId)
            statement.executeUpdate()
        }
    }

    private fun insertInvite(
        connection: Connection,
        groupId: UUID,
        inviterUserId: UUID,
        inviteeUserId: UUID,
        idempotencyKey: UUID,
        now: OffsetDateTime,
    ): UUID = connection.prepareStatement(
        """
        INSERT INTO circle_invites (
            circle_id, inviter_user_id, invitee_user_id, token_hash,
            idempotency_key, created_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, CAST(? AS timestamptz) + interval '7 days')
        RETURNING id
        """.trimIndent(),
    ).use { statement ->
        val tokenHash = ByteArray(32).also(random::nextBytes)
        statement.setObject(1, groupId)
        statement.setObject(2, inviterUserId)
        statement.setObject(3, inviteeUserId)
        statement.setBytes(4, tokenHash)
        statement.setObject(5, idempotencyKey)
        statement.setObject(6, now)
        statement.setObject(7, now)
        statement.executeQuery().use { result ->
            check(result.next())
            result.getObject("id", UUID::class.java)
        }
    }

    private fun findActiveMembership(
        connection: Connection,
        groupId: UUID,
        userId: UUID,
        lock: Boolean,
    ): MembershipRow? {
        val suffix = if (lock) " FOR UPDATE OF membership" else ""
        return connection.prepareStatement(
            """
            SELECT membership.id, membership.user_id, membership.role
              FROM circle_memberships membership
              JOIN circles circle
                ON circle.id = membership.circle_id
               AND circle.kind = 'GROUP'
               AND circle.archived_at IS NULL
             WHERE membership.circle_id = ? AND membership.user_id = ?
               AND membership.left_at IS NULL
            $suffix
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, groupId)
            statement.setObject(2, userId)
            statement.executeQuery().use { result ->
                if (result.next()) result.toMembershipRow() else null
            }
        }
    }

    private fun findMembershipForRemoval(
        connection: Connection,
        groupId: UUID,
        membershipId: UUID,
    ): RemovalMembershipRow? = connection.prepareStatement(
            """
            SELECT id, user_id, role, left_at FROM circle_memberships
             WHERE id = ? AND circle_id = ?
             FOR UPDATE
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, membershipId)
            statement.setObject(2, groupId)
            statement.executeQuery().use { result ->
                if (result.next()) {
                    RemovalMembershipRow(
                        id = result.getObject("id", UUID::class.java),
                        userId = result.getObject("user_id", UUID::class.java),
                        role = GroupRole.valueOf(result.getString("role")),
                        leftAt = result.getObject("left_at", OffsetDateTime::class.java),
                    )
                } else {
                    null
                }
            }
        }

    private fun findInviteReplay(
        connection: Connection,
        inviterUserId: UUID,
        idempotencyKey: UUID,
    ): InviteRow? = connection.prepareStatement(
        """
        SELECT id, circle_id, inviter_user_id, invitee_user_id, status, expires_at
          FROM circle_invites
         WHERE inviter_user_id = ? AND idempotency_key = ?
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, inviterUserId)
        statement.setObject(2, idempotencyKey)
        statement.executeQuery().use { result -> if (result.next()) result.toInviteRow() else null }
    }

    private fun findPendingInvite(
        connection: Connection,
        groupId: UUID,
        inviteeUserId: UUID,
    ): UUID? = connection.prepareStatement(
        """
        SELECT id FROM circle_invites
         WHERE circle_id = ? AND invitee_user_id = ? AND status = 'PENDING'
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, groupId)
        statement.setObject(2, inviteeUserId)
        statement.executeQuery().use { result ->
            if (result.next()) result.getObject("id", UUID::class.java) else null
        }
    }

    private fun findInvite(
        connection: Connection,
        inviteId: UUID,
        lock: Boolean,
    ): InviteRow? {
        val suffix = if (lock) " FOR UPDATE" else ""
        return connection.prepareStatement(
            """
            SELECT id, circle_id, inviter_user_id, invitee_user_id, status, expires_at
              FROM circle_invites WHERE id = ?
            $suffix
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, inviteId)
            statement.executeQuery().use { result -> if (result.next()) result.toInviteRow() else null }
        }
    }

    private fun expireInvites(connection: Connection, userId: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            """
            UPDATE circle_invites
               SET status = 'REVOKED', revoked_at = ?
             WHERE status = 'PENDING' AND expires_at <= ?
               AND ? IN (inviter_user_id, invitee_user_id)
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, now)
            statement.setObject(3, userId)
            statement.executeUpdate()
        }
    }

    private fun expireGroupInvites(connection: Connection, groupId: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            """
            UPDATE circle_invites SET status = 'REVOKED', revoked_at = ?
             WHERE circle_id = ? AND status = 'PENDING' AND expires_at <= ?
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, groupId)
            statement.setObject(3, now)
            statement.executeUpdate()
        }
    }

    private fun revokeInviteRow(connection: Connection, inviteId: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            """
            UPDATE circle_invites SET status = 'REVOKED', revoked_at = ?
             WHERE id = ? AND status = 'PENDING'
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, inviteId)
            statement.executeUpdate()
        }
    }

    private fun countActiveMembersAndInvites(connection: Connection, groupId: UUID): Int =
        connection.prepareStatement(
            """
            SELECT
                (SELECT count(*) FROM circle_memberships
                  WHERE circle_id = ? AND left_at IS NULL)
                +
                (SELECT count(*) FROM circle_invites
                  WHERE circle_id = ? AND status = 'PENDING') AS total
            """.trimIndent(),
        ).use { statement ->
            statement.setObject(1, groupId)
            statement.setObject(2, groupId)
            statement.executeQuery().use { result ->
                check(result.next())
                result.getInt("total")
            }
        }

    private fun isActiveGroup(connection: Connection, groupId: UUID): Boolean =
        connection.prepareStatement(
            "SELECT 1 FROM circles WHERE id = ? AND kind = 'GROUP' AND archived_at IS NULL FOR SHARE",
        ).use { statement ->
            statement.setObject(1, groupId)
            statement.executeQuery().use { result -> result.next() }
        }

    private fun closeMembership(connection: Connection, membershipId: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            "UPDATE circle_memberships SET left_at = ? WHERE id = ? AND left_at IS NULL",
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, membershipId)
            check(statement.executeUpdate() == 1)
        }
    }

    private fun findGroupForCreator(
        connection: Connection,
        groupId: UUID,
        creatorUserId: UUID,
    ): CreatorGroupRow? = connection.prepareStatement(
        """
        SELECT id, archived_at FROM circles
         WHERE id = ? AND kind = 'GROUP' AND created_by_user_id = ?
         FOR UPDATE
        """.trimIndent(),
    ).use { statement ->
        statement.setObject(1, groupId)
        statement.setObject(2, creatorUserId)
        statement.executeQuery().use { result ->
            if (result.next()) {
                CreatorGroupRow(
                    result.getObject("id", UUID::class.java),
                    result.getObject("archived_at", OffsetDateTime::class.java),
                )
            } else null
        }
    }

    private fun activeMemberUserIds(connection: Connection, groupId: UUID): List<UUID> =
        connection.prepareStatement(
            "SELECT user_id FROM circle_memberships WHERE circle_id = ? AND left_at IS NULL FOR UPDATE",
        ).use { statement ->
            statement.setObject(1, groupId)
            statement.executeQuery().use { result ->
                buildList { while (result.next()) add(result.getObject("user_id", UUID::class.java)) }
            }
        }

    private fun ResultSet.toMembershipRow() = MembershipRow(
        id = getObject("id", UUID::class.java),
        userId = getObject("user_id", UUID::class.java),
        role = GroupRole.valueOf(getString("role")),
    )

    private fun ResultSet.toInviteRow() = InviteRow(
        id = getObject("id", UUID::class.java),
        groupId = getObject("circle_id", UUID::class.java),
        inviterUserId = getObject("inviter_user_id", UUID::class.java),
        inviteeUserId = getObject("invitee_user_id", UUID::class.java),
        status = getString("status"),
        expiresAt = getObject("expires_at", OffsetDateTime::class.java),
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

    private data class GroupRow(
        val groupId: UUID,
        val title: String,
        val emoji: String?,
        val createdAt: OffsetDateTime,
        val myMembershipId: UUID,
        val myRole: GroupRole,
        val mySharingMode: SharingMode,
        val sharingMixed: Boolean,
    )

    private data class MembershipRow(val id: UUID, val userId: UUID, val role: GroupRole)
    private data class RemovalMembershipRow(
        val id: UUID,
        val userId: UUID,
        val role: GroupRole,
        val leftAt: OffsetDateTime?,
    )

    private data class InviteRow(
        val id: UUID,
        val groupId: UUID,
        val inviterUserId: UUID,
        val inviteeUserId: UUID,
        val status: String,
        val expiresAt: OffsetDateTime,
    )

    private data class CreatorGroupRow(val id: UUID, val archivedAt: OffsetDateTime?)
}
