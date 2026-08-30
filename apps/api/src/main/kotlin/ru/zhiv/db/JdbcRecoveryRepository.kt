package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.zhiv.checkins.DailyStreakSnapshot
import ru.zhiv.identity.UserSnapshot
import ru.zhiv.recovery.RecoveryApprovalCandidateSnapshot
import ru.zhiv.recovery.RecoveryApprovalPreviewSnapshot
import ru.zhiv.recovery.RecoveryAttemptSnapshot
import ru.zhiv.recovery.RecoveryAttemptStatus
import ru.zhiv.recovery.RecoveryCompletionSnapshot
import ru.zhiv.recovery.RecoveryContactSnapshot
import ru.zhiv.recovery.RecoveryContactsSnapshot
import ru.zhiv.recovery.RecoveryEligibleSnapshot
import ru.zhiv.recovery.RecoveryRepository
import ru.zhiv.recovery.RecoveryResult
import ru.zhiv.relationships.UserReference
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

class JdbcRecoveryRepository(private val dataSource: DataSource) : RecoveryRepository {
    override suspend fun list(sessionTokenHash: ByteArray): RecoveryResult<RecoveryContactsSnapshot> = io {
        tx { connection ->
            val userId = currentSession(connection, sessionTokenHash)?.userId
                ?: return@tx RecoveryResult.Unauthorized
            lockUsers(connection, setOf(userId))
            if (!sessionBelongsToUser(connection, sessionTokenHash, userId)) {
                return@tx RecoveryResult.Unauthorized
            }
            val now = serverTime(connection)
            revokeStaleContacts(connection, userId, now)
            RecoveryResult.Success(loadContacts(connection, userId, now))
        }
    }

    override suspend fun add(
        sessionTokenHash: ByteArray,
        circleId: UUID,
        key: UUID,
    ): RecoveryResult<RecoveryContactsSnapshot> = io {
        tx { connection ->
            val ownerId = currentSession(connection, sessionTokenHash)?.userId
                ?: return@tx RecoveryResult.Unauthorized
            val firstTrusteeId = otherDirectUser(connection, circleId, ownerId)
                ?: return@tx RecoveryResult.NotFound
            lockUsers(connection, setOf(ownerId, firstTrusteeId))
            if (!sessionBelongsToUser(connection, sessionTokenHash, ownerId)) {
                return@tx RecoveryResult.Unauthorized
            }
            val trusteeId = otherDirectUser(connection, circleId, ownerId)
                ?: return@tx RecoveryResult.NotFound
            if (trusteeId != firstTrusteeId) return@tx RecoveryResult.Conflict

            val now = serverTime(connection)
            revokeStaleContacts(connection, ownerId, now)
            val replay = connection.prepareStatement(
                """SELECT trustee_user_id, direct_circle_id
                     FROM account_recovery_contacts
                    WHERE owner_user_id = ? AND idempotency_key = ?""",
            ).use { statement ->
                statement.setObject(1, ownerId)
                statement.setObject(2, key)
                statement.executeQuery().use { result ->
                    if (!result.next()) null else Pair(
                        result.getObject("trustee_user_id", UUID::class.java),
                        result.getObject("direct_circle_id", UUID::class.java),
                    )
                }
            }
            if (replay != null) {
                if (replay.first != trusteeId || replay.second != circleId) {
                    return@tx RecoveryResult.Conflict
                }
                return@tx RecoveryResult.Success(loadContacts(connection, ownerId, now))
            }

            val alreadyActive = connection.prepareStatement(
                """SELECT 1 FROM account_recovery_contacts
                    WHERE owner_user_id = ? AND trustee_user_id = ? AND revoked_at IS NULL""",
            ).use { statement ->
                statement.setObject(1, ownerId)
                statement.setObject(2, trusteeId)
                statement.executeQuery().use { result -> result.next() }
            }
            if (alreadyActive) return@tx RecoveryResult.Conflict

            val activeCount = connection.prepareStatement(
                "SELECT count(*) FROM account_recovery_contacts WHERE owner_user_id = ? AND revoked_at IS NULL",
            ).use { statement ->
                statement.setObject(1, ownerId)
                statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
            }
            if (activeCount >= 3) return@tx RecoveryResult.LimitReached

            connection.prepareStatement(
                """INSERT INTO account_recovery_contacts
                       (owner_user_id, trustee_user_id, direct_circle_id, idempotency_key, created_at)
                     VALUES (?, ?, ?, ?, ?)""",
            ).use { statement ->
                statement.setObject(1, ownerId)
                statement.setObject(2, trusteeId)
                statement.setObject(3, circleId)
                statement.setObject(4, key)
                statement.setObject(5, now)
                check(statement.executeUpdate() == 1)
            }
            RecoveryResult.Success(loadContacts(connection, ownerId, now))
        }
    }

    override suspend fun remove(
        sessionTokenHash: ByteArray,
        contactId: UUID,
        key: UUID,
    ): RecoveryResult<RecoveryContactsSnapshot> = io {
        tx { connection ->
            val ownerId = currentSession(connection, sessionTokenHash)?.userId
                ?: return@tx RecoveryResult.Unauthorized
            val firstContact = rawContact(connection, contactId)
                ?.takeIf { it.ownerId == ownerId }
                ?: return@tx RecoveryResult.NotFound
            lockUsers(connection, setOf(firstContact.ownerId, firstContact.trusteeId))
            if (!sessionBelongsToUser(connection, sessionTokenHash, ownerId)) {
                return@tx RecoveryResult.Unauthorized
            }
            val contact = lockContact(connection, contactId)
                ?.takeIf { it.ownerId == ownerId }
                ?: return@tx RecoveryResult.NotFound
            val now = serverTime(connection)
            val priorRemoval = connection.prepareStatement(
                """SELECT contact_id FROM account_recovery_contact_removals
                    WHERE owner_user_id = ? AND idempotency_key = ?""",
            ).use { statement ->
                statement.setObject(1, ownerId)
                statement.setObject(2, key)
                statement.executeQuery().use { result ->
                    if (result.next()) result.getObject(1, UUID::class.java) else null
                }
            }
            if (priorRemoval != null && priorRemoval != contactId) {
                return@tx RecoveryResult.Conflict
            }
            if (priorRemoval == null) {
                connection.prepareStatement(
                    """INSERT INTO account_recovery_contact_removals
                           (owner_user_id, idempotency_key, contact_id, created_at)
                         VALUES (?, ?, ?, ?)""",
                ).use { statement ->
                    statement.setObject(1, ownerId)
                    statement.setObject(2, key)
                    statement.setObject(3, contactId)
                    statement.setObject(4, now)
                    check(statement.executeUpdate() == 1)
                }
            }
            if (contact.revokedAt == null) {
                connection.prepareStatement(
                    """UPDATE account_recovery_contacts
                          SET revoked_at = ?, revocation_idempotency_key = ?
                        WHERE id = ? AND revoked_at IS NULL""",
                ).use { statement ->
                    statement.setObject(1, now)
                    statement.setObject(2, key)
                    statement.setObject(3, contactId)
                    check(statement.executeUpdate() == 1)
                }
            }
            revokeStaleContacts(connection, ownerId, now)
            RecoveryResult.Success(loadContacts(connection, ownerId, now))
        }
    }

    override suspend fun createAttempt(
        approvalTokenHash: ByteArray,
        claimTokenHash: ByteArray,
        key: UUID,
        initiatingSessionTokenHash: ByteArray?,
    ): RecoveryResult<RecoveryAttemptSnapshot> = io {
        tx { connection ->
            advisoryLock(connection, "recovery-approval", approvalTokenHash)
            advisoryLock(connection, "recovery-create", key.toString())
            val initiating = initiatingSessionTokenHash?.let { currentSession(connection, it) }
            val now = serverTime(connection)

            findAttemptByCreationKey(connection, key, lock = true)?.let { row ->
                if (!row.approvalTokenHash.contentEquals(approvalTokenHash)
                    || row.initiatingSessionId != initiating?.id
                    || row.initiatingUserId != initiating?.userId
                ) return@tx RecoveryResult.Conflict
                if (row.status != "PENDING" || !row.expiresAt.isAfter(now)) {
                    if (row.status == "PENDING") expireAttempt(connection, row.id, now)
                    return@tx RecoveryResult.Expired
                }
                if (!row.claimTokenHash.contentEquals(claimTokenHash)) return@tx RecoveryResult.Conflict
                return@tx RecoveryResult.Success(
                    row.toSnapshot(connection, now, replayed = true),
                )
            }

            if (findAttemptByApproval(connection, approvalTokenHash, lock = true) != null) {
                return@tx RecoveryResult.Conflict
            }
            val row = connection.prepareStatement(
                """INSERT INTO account_recovery_attempts (
                       approval_token_hash, claim_token_hash, creation_idempotency_key,
                       initiating_session_id, initiating_user_id, created_at, expires_at
                     ) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS timestamptz) + interval '10 minutes')
                     RETURNING *""",
            ).use { statement ->
                statement.setBytes(1, approvalTokenHash)
                statement.setBytes(2, claimTokenHash)
                statement.setObject(3, key)
                statement.setObject(4, initiating?.id)
                statement.setObject(5, initiating?.userId)
                statement.setObject(6, now)
                statement.setObject(7, now)
                statement.executeQuery().use { result -> check(result.next()); result.toAttemptRow() }
            }
            RecoveryResult.Success(row.toSnapshot(connection, now, replayed = false))
        }
    }

    override suspend fun currentAttempt(
        claimTokenHash: ByteArray,
    ): RecoveryResult<RecoveryAttemptSnapshot> = io {
        tx { connection ->
            val now = serverTime(connection)
            val row = findAttemptByClaim(connection, claimTokenHash, lock = true)
                ?: return@tx RecoveryResult.NotFound
            when {
                row.status in TERMINAL_ATTEMPT_STATUSES -> RecoveryResult.Expired
                !row.expiresAt.isAfter(now) -> {
                    if (row.status in setOf("PENDING", "APPROVED")) expireAttempt(connection, row.id, now)
                    RecoveryResult.Expired
                }
                else -> RecoveryResult.Success(row.toSnapshot(connection, now, replayed = false))
            }
        }
    }

    override suspend fun cancelAttempt(claimTokenHash: ByteArray): RecoveryResult<Unit> = io {
        tx { connection ->
            val now = serverTime(connection)
            val row = findAttemptByClaim(connection, claimTokenHash, lock = true)
                ?: return@tx RecoveryResult.NotFound
            when (row.status) {
                "PENDING", "APPROVED" -> connection.prepareStatement(
                    """UPDATE account_recovery_attempts
                          SET status = 'CANCELLED', terminal_at = ?
                        WHERE id = ? AND status IN ('PENDING', 'APPROVED')""",
                ).use { statement ->
                    statement.setObject(1, now)
                    statement.setObject(2, row.id)
                    check(statement.executeUpdate() == 1)
                }
                "CANCELLED", "EXPIRED" -> Unit
                else -> return@tx RecoveryResult.Conflict
            }
            RecoveryResult.Success(Unit)
        }
    }

    override suspend fun previewApproval(
        sessionTokenHash: ByteArray,
        approvalTokenHash: ByteArray,
    ): RecoveryResult<RecoveryApprovalPreviewSnapshot> = io {
        tx { connection ->
            val trusteeId = currentSession(connection, sessionTokenHash)?.userId
                ?: return@tx RecoveryResult.Unauthorized
            lockUsers(connection, setOf(trusteeId))
            if (!sessionBelongsToUser(connection, sessionTokenHash, trusteeId)) {
                return@tx RecoveryResult.Unauthorized
            }
            val now = serverTime(connection)
            val attempt = findAttemptByApproval(connection, approvalTokenHash, lock = true)
                ?: return@tx RecoveryResult.NotFound
            if (attempt.status != "PENDING") {
                return@tx if (attempt.status in TERMINAL_ATTEMPT_STATUSES) {
                    RecoveryResult.Expired
                } else {
                    RecoveryResult.Conflict
                }
            }
            if (!attempt.expiresAt.isAfter(now)) {
                expireAttempt(connection, attempt.id, now)
                return@tx RecoveryResult.Expired
            }

            val eligible = connection.prepareStatement(
                """SELECT contact.id, owner_user.public_id, owner_user.display_name
                     FROM account_recovery_contacts contact
                     JOIN circles circle
                       ON circle.id = contact.direct_circle_id
                      AND circle.kind = 'DIRECT'
                      AND circle.archived_at IS NULL
                      AND circle.direct_user_low_id = LEAST(contact.owner_user_id, contact.trustee_user_id)
                      AND circle.direct_user_high_id = GREATEST(contact.owner_user_id, contact.trustee_user_id)
                     JOIN app_users owner_user
                       ON owner_user.id = contact.owner_user_id AND owner_user.deleted_at IS NULL
                     JOIN app_users trustee_user
                       ON trustee_user.id = contact.trustee_user_id AND trustee_user.deleted_at IS NULL
                    WHERE contact.trustee_user_id = ? AND contact.revoked_at IS NULL
                    ORDER BY lower(owner_user.display_name), owner_user.public_id""",
            ).use { statement ->
                statement.setObject(1, trusteeId)
                statement.executeQuery().use { result ->
                    buildList {
                        while (result.next()) add(
                            RecoveryApprovalCandidateSnapshot(
                                result.getObject("id", UUID::class.java),
                                UserReference(result.getString("public_id"), result.getString("display_name")),
                            ),
                        )
                    }
                }
            }
            RecoveryResult.Success(RecoveryApprovalPreviewSnapshot(eligible, attempt.expiresAt, now))
        }
    }

    override suspend fun confirmApproval(
        sessionTokenHash: ByteArray,
        approvalTokenHash: ByteArray,
        contactId: UUID,
        key: UUID,
    ): RecoveryResult<RecoveryAttemptSnapshot> = io {
        tx { connection ->
            val trusteeId = currentSession(connection, sessionTokenHash)?.userId
                ?: return@tx RecoveryResult.Unauthorized
            val firstContact = rawContact(connection, contactId)
                ?.takeIf { it.trusteeId == trusteeId }
                ?: return@tx RecoveryResult.Forbidden
            lockUsers(connection, setOf(firstContact.ownerId, firstContact.trusteeId))
            if (!sessionBelongsToUser(connection, sessionTokenHash, trusteeId)) {
                return@tx RecoveryResult.Unauthorized
            }
            val contact = activeContact(connection, contactId, trusteeId)
                ?: return@tx RecoveryResult.Forbidden
            val now = serverTime(connection)
            val attempt = findAttemptByApproval(connection, approvalTokenHash, lock = true)
                ?: return@tx RecoveryResult.NotFound

            val priorIdempotency = connection.prepareStatement(
                """SELECT id FROM account_recovery_attempts
                    WHERE approved_by_user_id = ? AND approval_idempotency_key = ?""",
            ).use { statement ->
                statement.setObject(1, trusteeId)
                statement.setObject(2, key)
                statement.executeQuery().use { result ->
                    if (result.next()) result.getObject(1, UUID::class.java) else null
                }
            }
            if (priorIdempotency != null && priorIdempotency != attempt.id) {
                return@tx RecoveryResult.Conflict
            }

            if (attempt.status in setOf("APPROVED", "COMPLETED")) {
                if (attempt.approvedByUserId != trusteeId
                    || attempt.recoveryContactId != contactId
                    || attempt.approvalIdempotencyKey != key
                    || attempt.targetUserId != contact.ownerId
                ) return@tx RecoveryResult.Conflict
                return@tx RecoveryResult.Success(attempt.toSnapshot(connection, now, replayed = true))
            }
            if (attempt.status != "PENDING" || !attempt.expiresAt.isAfter(now)) {
                if (attempt.status == "PENDING") expireAttempt(connection, attempt.id, now)
                return@tx RecoveryResult.Expired
            }

            connection.prepareStatement(
                """UPDATE account_recovery_attempts
                      SET status = 'CANCELLED', terminal_at = ?
                    WHERE target_user_id = ? AND status = 'APPROVED' AND id <> ?""",
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, contact.ownerId)
                statement.setObject(3, attempt.id)
                statement.executeUpdate()
            }
            connection.prepareStatement(
                """UPDATE account_recovery_attempts
                      SET status = 'APPROVED', target_user_id = ?, approved_by_user_id = ?,
                          recovery_contact_id = ?, approval_idempotency_key = ?, approved_at = ?
                    WHERE id = ? AND status = 'PENDING'""",
            ).use { statement ->
                statement.setObject(1, contact.ownerId)
                statement.setObject(2, trusteeId)
                statement.setObject(3, contactId)
                statement.setObject(4, key)
                statement.setObject(5, now)
                statement.setObject(6, attempt.id)
                check(statement.executeUpdate() == 1)
            }
            val approved = attempt.copy(
                status = "APPROVED",
                targetUserId = contact.ownerId,
                approvedByUserId = trusteeId,
                recoveryContactId = contactId,
                approvalIdempotencyKey = key,
                approvedAt = now,
            )
            RecoveryResult.Success(approved.toSnapshot(connection, now, replayed = false))
        }
    }

    override suspend fun completeAttempt(
        claimTokenHash: ByteArray,
        key: UUID,
        sessionLifetimeDays: Long,
    ): RecoveryResult<RecoveryCompletionSnapshot> = io {
        tx { connection ->
            val firstAttempt = findAttemptByClaim(connection, claimTokenHash, lock = false)
                ?: return@tx RecoveryResult.NotFound
            if (firstAttempt.status == "PENDING") return@tx RecoveryResult.Conflict
            if (firstAttempt.status in TERMINAL_ATTEMPT_STATUSES) return@tx RecoveryResult.Expired
            val targetId = firstAttempt.targetUserId ?: return@tx RecoveryResult.Conflict
            lockUsers(
                connection,
                listOfNotNull(
                    targetId,
                    firstAttempt.initiatingUserId,
                    firstAttempt.approvedByUserId,
                ).toSet(),
            )

            val lockedAttemptView = findAttemptByClaim(connection, claimTokenHash, lock = false)
                ?: return@tx RecoveryResult.NotFound
            if (lockedAttemptView.targetUserId != targetId
                || lockedAttemptView.initiatingUserId != firstAttempt.initiatingUserId
                || lockedAttemptView.approvedByUserId != firstAttempt.approvedByUserId
                || lockedAttemptView.recoveryContactId != firstAttempt.recoveryContactId
            ) return@tx RecoveryResult.Conflict

            if (lockedAttemptView.status == "APPROVED") {
                val contactId = lockedAttemptView.recoveryContactId ?: return@tx RecoveryResult.Conflict
                val trusteeId = lockedAttemptView.approvedByUserId ?: return@tx RecoveryResult.Conflict
                val contact = activeContact(connection, contactId, trusteeId)
                    ?: return@tx RecoveryResult.Forbidden
                if (contact.ownerId != targetId) return@tx RecoveryResult.Forbidden
            }

            val attempt = findAttemptByClaim(connection, claimTokenHash, lock = true)
                ?: return@tx RecoveryResult.NotFound
            val now = serverTime(connection)
            if (!attempt.expiresAt.isAfter(now)) {
                if (attempt.status in setOf("PENDING", "APPROVED")) expireAttempt(connection, attempt.id, now)
                return@tx RecoveryResult.Expired
            }
            if (attempt.status == "COMPLETED") {
                if (attempt.completionIdempotencyKey != key || attempt.completedSessionId == null) {
                    return@tx RecoveryResult.Conflict
                }
                val sessionIsActive = connection.prepareStatement(
                    """SELECT 1 FROM app_sessions
                        WHERE id = ? AND user_id = ? AND token_hash = ?
                          AND revoked_at IS NULL AND expires_at > ?""",
                ).use { statement ->
                    statement.setObject(1, attempt.completedSessionId)
                    statement.setObject(2, targetId)
                    statement.setBytes(3, claimTokenHash)
                    statement.setObject(4, now)
                    statement.executeQuery().use { result -> result.next() }
                }
                if (!sessionIsActive) return@tx RecoveryResult.Conflict
                val snapshot = attempt.toSnapshot(connection, now, replayed = true)
                return@tx RecoveryResult.Success(
                    RecoveryCompletionSnapshot(snapshot, loadUser(connection, targetId, now)),
                )
            }
            if (attempt.status != "APPROVED") {
                return@tx if (attempt.status in TERMINAL_ATTEMPT_STATUSES) {
                    RecoveryResult.Expired
                } else {
                    RecoveryResult.Conflict
                }
            }
            if (!attempt.expiresAt.isAfter(now)) {
                expireAttempt(connection, attempt.id, now)
                return@tx RecoveryResult.Expired
            }
            if (attempt.targetUserId != targetId
                || attempt.recoveryContactId != firstAttempt.recoveryContactId
                || attempt.approvedByUserId != firstAttempt.approvedByUserId
            ) return@tx RecoveryResult.Conflict

            connection.prepareStatement(
                """UPDATE account_recovery_contacts
                      SET revoked_at = GREATEST(?, created_at)
                    WHERE owner_user_id = ? AND id <> ? AND revoked_at IS NULL""",
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, targetId)
                statement.setObject(3, attempt.recoveryContactId)
                statement.executeUpdate()
            }
            connection.prepareStatement(
                """UPDATE direct_invite_links
                      SET status = 'REVOKED', revoked_at = ?
                    WHERE inviter_user_id = ? AND status = 'PENDING'""",
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, targetId)
                statement.executeUpdate()
            }
            connection.prepareStatement(
                """UPDATE direct_requests
                      SET status = CASE WHEN expires_at <= ? THEN 'EXPIRED' ELSE 'CANCELLED' END,
                          responded_at = ?
                    WHERE requester_user_id = ? AND status = 'PENDING'""",
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, now)
                statement.setObject(3, targetId)
                statement.executeUpdate()
            }
            connection.prepareStatement(
                """UPDATE circle_invites
                      SET status = 'REVOKED', revoked_at = ?
                    WHERE inviter_user_id = ? AND status = 'PENDING'""",
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, targetId)
                statement.executeUpdate()
            }
            connection.prepareStatement(
                """UPDATE account_recovery_attempts
                      SET status = 'CANCELLED', terminal_at = GREATEST(?, created_at)
                    WHERE approved_by_user_id = ? AND status = 'APPROVED' AND id <> ?""",
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, targetId)
                statement.setObject(3, attempt.id)
                statement.executeUpdate()
            }

            connection.prepareStatement(
                "UPDATE app_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
            ).use { statement ->
                statement.setObject(1, now)
                statement.setObject(2, targetId)
                statement.executeUpdate()
            }
            attempt.initiatingSessionId?.let { initiatingSessionId ->
                connection.prepareStatement(
                    "UPDATE app_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                ).use { statement ->
                    statement.setObject(1, now)
                    statement.setObject(2, initiatingSessionId)
                    statement.executeUpdate()
                }
            }
            val sessionId = connection.prepareStatement(
                """INSERT INTO app_sessions (user_id, token_hash, created_at, last_seen_at, expires_at)
                     VALUES (?, ?, ?, ?, CAST(? AS timestamptz) + (? * interval '1 day'))
                     RETURNING id""",
            ).use { statement ->
                statement.setObject(1, targetId)
                statement.setBytes(2, claimTokenHash)
                statement.setObject(3, now)
                statement.setObject(4, now)
                statement.setObject(5, now)
                statement.setLong(6, sessionLifetimeDays)
                statement.executeQuery().use { result -> check(result.next()); result.getObject(1, UUID::class.java) }
            }
            connection.prepareStatement(
                """UPDATE account_recovery_attempts
                      SET status = 'COMPLETED', completed_session_id = ?,
                          completion_idempotency_key = ?, completed_at = ?
                    WHERE id = ? AND status = 'APPROVED'""",
            ).use { statement ->
                statement.setObject(1, sessionId)
                statement.setObject(2, key)
                statement.setObject(3, now)
                statement.setObject(4, attempt.id)
                check(statement.executeUpdate() == 1)
            }
            val completed = attempt.copy(
                status = "COMPLETED",
                completedSessionId = sessionId,
                completionIdempotencyKey = key,
                completedAt = now,
            ).toSnapshot(connection, now, replayed = false)
            RecoveryResult.Success(
                RecoveryCompletionSnapshot(completed, loadUser(connection, targetId, now)),
            )
        }
    }

    private fun loadContacts(connection: Connection, userId: UUID, now: OffsetDateTime): RecoveryContactsSnapshot {
        val contacts = contactList(connection, userId, owner = true)
        val trustedBy = contactList(connection, userId, owner = false)
        val selected = contacts.mapTo(mutableSetOf()) { it.circleId }
        val eligible = connection.prepareStatement(
            """SELECT circle.id circle_id, other.public_id, other.display_name
                 FROM circles circle
                 JOIN app_users other
                   ON other.id = CASE WHEN circle.direct_user_low_id = ?
                                      THEN circle.direct_user_high_id ELSE circle.direct_user_low_id END
                  AND other.deleted_at IS NULL
                WHERE circle.kind = 'DIRECT' AND circle.archived_at IS NULL
                  AND ? IN (circle.direct_user_low_id, circle.direct_user_high_id)
                ORDER BY lower(other.display_name), other.public_id""",
        ).use { statement ->
            statement.setObject(1, userId)
            statement.setObject(2, userId)
            statement.executeQuery().use { result ->
                buildList {
                    while (result.next()) {
                        val circleId = result.getObject("circle_id", UUID::class.java)
                        if (circleId !in selected) add(
                            RecoveryEligibleSnapshot(
                                circleId,
                                UserReference(result.getString("public_id"), result.getString("display_name")),
                            ),
                        )
                    }
                }
            }
        }
        return RecoveryContactsSnapshot(contacts, eligible, trustedBy, now)
    }

    private fun contactList(connection: Connection, userId: UUID, owner: Boolean): List<RecoveryContactSnapshot> {
        val principalColumn = if (owner) "contact.owner_user_id" else "contact.trustee_user_id"
        val otherColumn = if (owner) "contact.trustee_user_id" else "contact.owner_user_id"
        return connection.prepareStatement(
            """SELECT contact.id, contact.direct_circle_id, other.public_id, other.display_name
                 FROM account_recovery_contacts contact
                 JOIN circles circle
                   ON circle.id = contact.direct_circle_id
                  AND circle.kind = 'DIRECT'
                  AND circle.archived_at IS NULL
                  AND circle.direct_user_low_id = LEAST(contact.owner_user_id, contact.trustee_user_id)
                  AND circle.direct_user_high_id = GREATEST(contact.owner_user_id, contact.trustee_user_id)
                 JOIN app_users other ON other.id = $otherColumn AND other.deleted_at IS NULL
                WHERE $principalColumn = ? AND contact.revoked_at IS NULL
                ORDER BY lower(other.display_name), other.public_id""",
        ).use { statement ->
            statement.setObject(1, userId)
            statement.executeQuery().use { result ->
                buildList {
                    while (result.next()) add(
                        RecoveryContactSnapshot(
                            result.getObject("id", UUID::class.java),
                            result.getObject("direct_circle_id", UUID::class.java),
                            UserReference(result.getString("public_id"), result.getString("display_name")),
                        ),
                    )
                }
            }
        }
    }

    private fun revokeStaleContacts(connection: Connection, userId: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            """UPDATE account_recovery_contacts contact
                  SET revoked_at = GREATEST(?, contact.created_at)
                WHERE contact.revoked_at IS NULL
                  AND ? IN (contact.owner_user_id, contact.trustee_user_id)
                  AND NOT EXISTS (
                      SELECT 1
                        FROM circles circle
                        JOIN app_users owner_user
                          ON owner_user.id = contact.owner_user_id AND owner_user.deleted_at IS NULL
                        JOIN app_users trustee_user
                          ON trustee_user.id = contact.trustee_user_id AND trustee_user.deleted_at IS NULL
                       WHERE circle.id = contact.direct_circle_id
                         AND circle.kind = 'DIRECT'
                         AND circle.archived_at IS NULL
                         AND circle.direct_user_low_id = LEAST(contact.owner_user_id, contact.trustee_user_id)
                         AND circle.direct_user_high_id = GREATEST(contact.owner_user_id, contact.trustee_user_id)
                  )""",
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, userId)
            statement.executeUpdate()
        }
    }

    private fun rawContact(connection: Connection, contactId: UUID): ContactRow? =
        connection.prepareStatement(
            """SELECT id, owner_user_id, trustee_user_id, direct_circle_id, revoked_at
                 FROM account_recovery_contacts WHERE id = ?""",
        ).use { statement ->
            statement.setObject(1, contactId)
            statement.executeQuery().use { result -> if (result.next()) result.toContactRow() else null }
        }

    private fun lockContact(connection: Connection, contactId: UUID): ContactRow? =
        connection.prepareStatement(
            """SELECT id, owner_user_id, trustee_user_id, direct_circle_id, revoked_at
                 FROM account_recovery_contacts WHERE id = ? FOR UPDATE""",
        ).use { statement ->
            statement.setObject(1, contactId)
            statement.executeQuery().use { result -> if (result.next()) result.toContactRow() else null }
        }

    private fun activeContact(connection: Connection, contactId: UUID, trusteeId: UUID): ContactRow? =
        connection.prepareStatement(
            """SELECT contact.id, contact.owner_user_id, contact.trustee_user_id,
                      contact.direct_circle_id, contact.revoked_at
                 FROM account_recovery_contacts contact
                 JOIN circles circle
                   ON circle.id = contact.direct_circle_id
                  AND circle.kind = 'DIRECT'
                  AND circle.archived_at IS NULL
                  AND circle.direct_user_low_id = LEAST(contact.owner_user_id, contact.trustee_user_id)
                  AND circle.direct_user_high_id = GREATEST(contact.owner_user_id, contact.trustee_user_id)
                 JOIN app_users owner_user
                   ON owner_user.id = contact.owner_user_id AND owner_user.deleted_at IS NULL
                 JOIN app_users trustee_user
                   ON trustee_user.id = contact.trustee_user_id AND trustee_user.deleted_at IS NULL
                WHERE contact.id = ? AND contact.trustee_user_id = ? AND contact.revoked_at IS NULL
                FOR UPDATE OF contact, circle""",
        ).use { statement ->
            statement.setObject(1, contactId)
            statement.setObject(2, trusteeId)
            statement.executeQuery().use { result -> if (result.next()) result.toContactRow() else null }
        }

    private fun otherDirectUser(connection: Connection, circleId: UUID, userId: UUID): UUID? =
        connection.prepareStatement(
            """SELECT CASE WHEN direct_user_low_id = ? THEN direct_user_high_id ELSE direct_user_low_id END
                 FROM circles
                WHERE id = ? AND kind = 'DIRECT' AND archived_at IS NULL
                  AND ? IN (direct_user_low_id, direct_user_high_id)""",
        ).use { statement ->
            statement.setObject(1, userId)
            statement.setObject(2, circleId)
            statement.setObject(3, userId)
            statement.executeQuery().use { result ->
                if (result.next()) result.getObject(1, UUID::class.java) else null
            }
        }

    private fun currentSession(connection: Connection, hash: ByteArray): SessionRow? =
        connection.prepareStatement(
            """SELECT session.id, session.user_id
                 FROM app_sessions session
                 JOIN app_users user_account ON user_account.id = session.user_id
                WHERE session.token_hash = ? AND session.revoked_at IS NULL
                  AND session.expires_at > clock_timestamp() AND user_account.deleted_at IS NULL""",
        ).use { statement ->
            statement.setBytes(1, hash)
            statement.executeQuery().use { result ->
                if (!result.next()) null else SessionRow(
                    result.getObject("id", UUID::class.java),
                    result.getObject("user_id", UUID::class.java),
                )
            }
        }

    private fun sessionBelongsToUser(connection: Connection, hash: ByteArray, expectedUserId: UUID): Boolean =
        currentSession(connection, hash)?.userId == expectedUserId

    private fun findAttemptByCreationKey(connection: Connection, key: UUID, lock: Boolean): AttemptRow? =
        findAttempt(connection, "creation_idempotency_key = ?", lock) { statement -> statement.setObject(1, key) }

    private fun findAttemptByApproval(connection: Connection, hash: ByteArray, lock: Boolean): AttemptRow? =
        findAttempt(connection, "approval_token_hash = ?", lock) { statement -> statement.setBytes(1, hash) }

    private fun findAttemptByClaim(connection: Connection, hash: ByteArray, lock: Boolean): AttemptRow? =
        findAttempt(connection, "claim_token_hash = ?", lock) { statement -> statement.setBytes(1, hash) }

    private fun findAttempt(
        connection: Connection,
        predicate: String,
        lock: Boolean,
        bind: (java.sql.PreparedStatement) -> Unit,
    ): AttemptRow? {
        val suffix = if (lock) " FOR UPDATE" else ""
        return connection.prepareStatement(
            "SELECT * FROM account_recovery_attempts WHERE $predicate$suffix",
        ).use { statement ->
            bind(statement)
            statement.executeQuery().use { result -> if (result.next()) result.toAttemptRow() else null }
        }
    }

    private fun expireAttempt(connection: Connection, id: UUID, now: OffsetDateTime) {
        connection.prepareStatement(
            """UPDATE account_recovery_attempts
                  SET status = 'EXPIRED', terminal_at = ?
                WHERE id = ? AND status IN ('PENDING', 'APPROVED')""",
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, id)
            statement.executeUpdate()
        }
    }

    private fun AttemptRow.toSnapshot(
        connection: Connection,
        now: OffsetDateTime,
        replayed: Boolean,
    ): RecoveryAttemptSnapshot {
        val publicTarget = targetUserId?.let { user(connection, it) }
        return RecoveryAttemptSnapshot(
            id,
            RecoveryAttemptStatus.valueOf(status),
            expiresAt,
            publicTarget,
            replayed,
            now,
        )
    }

    private fun user(connection: Connection, id: UUID): UserReference = connection.prepareStatement(
        "SELECT public_id, display_name FROM app_users WHERE id = ? AND deleted_at IS NULL",
    ).use { statement ->
        statement.setObject(1, id)
        statement.executeQuery().use { result ->
            check(result.next())
            UserReference(result.getString(1), result.getString(2))
        }
    }

    private fun lockUsers(connection: Connection, ids: Set<UUID>) {
        if (ids.isEmpty()) return
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

    private fun advisoryLock(connection: Connection, namespace: String, value: String) {
        connection.prepareStatement(
            "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
        ).use { statement ->
            statement.setString(1, "$namespace:$value")
            statement.executeQuery().use { result -> check(result.next()) }
        }
    }

    private fun advisoryLock(connection: Connection, namespace: String, value: ByteArray) {
        connection.prepareStatement(
            "SELECT pg_advisory_xact_lock(hashtextextended(? || encode(?::bytea, 'hex'), 0))",
        ).use { statement ->
            statement.setString(1, "$namespace:")
            statement.setBytes(2, value)
            statement.executeQuery().use { result -> check(result.next()) }
        }
    }

    private fun loadUser(connection: Connection, userId: UUID, now: OffsetDateTime): UserSnapshot =
        connection.prepareStatement(
            """SELECT user_account.id, user_account.public_id, user_account.display_name,
                      user_account.last_check_in_at,
                      (SELECT count(*) FROM check_ins event WHERE event.user_id = user_account.id) check_in_count,
                      streak.current_days, streak.longest_days, streak.is_active, streak.renew_by,
                      user_account.display_name_changed_at,
                      CASE WHEN user_account.display_name_changed_at + interval '24 hours' > ?
                           THEN user_account.display_name_changed_at + interval '24 hours' END
                           display_name_change_available_at,
                      ?::timestamptz server_time
                 FROM app_users user_account
                 CROSS JOIN LATERAL rolling_check_in_streak(user_account.id, ?::timestamptz) streak
                WHERE user_account.id = ? AND user_account.deleted_at IS NULL""",
        ).use { statement ->
            statement.setObject(1, now)
            statement.setObject(2, now)
            statement.setObject(3, now)
            statement.setObject(4, userId)
            statement.executeQuery().use { result ->
                check(result.next())
                UserSnapshot(
                    result.getObject("id", UUID::class.java),
                    result.getString("public_id"),
                    result.getString("display_name"),
                    result.getObject("last_check_in_at", OffsetDateTime::class.java),
                    result.getLong("check_in_count"),
                    DailyStreakSnapshot(
                        result.getLong("current_days"),
                        result.getLong("longest_days"),
                        result.getBoolean("is_active"),
                        result.getObject("renew_by", OffsetDateTime::class.java)
                            ?.withOffsetSameInstant(ZoneOffset.UTC),
                    ),
                    result.getObject("display_name_changed_at", OffsetDateTime::class.java),
                    result.getObject("display_name_change_available_at", OffsetDateTime::class.java),
                    now.withOffsetSameInstant(ZoneOffset.UTC),
                )
            }
        }

    private fun serverTime(connection: Connection): OffsetDateTime =
        connection.prepareStatement("SELECT clock_timestamp()").use { statement ->
            statement.executeQuery().use { result ->
                check(result.next())
                result.getObject(1, OffsetDateTime::class.java)
            }
        }

    private fun ResultSet.toContactRow() = ContactRow(
        getObject("id", UUID::class.java),
        getObject("owner_user_id", UUID::class.java),
        getObject("trustee_user_id", UUID::class.java),
        getObject("direct_circle_id", UUID::class.java),
        getObject("revoked_at", OffsetDateTime::class.java),
    )

    private fun ResultSet.toAttemptRow() = AttemptRow(
        id = getObject("id", UUID::class.java),
        approvalTokenHash = getBytes("approval_token_hash"),
        claimTokenHash = getBytes("claim_token_hash"),
        creationIdempotencyKey = getObject("creation_idempotency_key", UUID::class.java),
        initiatingSessionId = getObject("initiating_session_id", UUID::class.java),
        initiatingUserId = getObject("initiating_user_id", UUID::class.java),
        status = getString("status"),
        targetUserId = getObject("target_user_id", UUID::class.java),
        approvedByUserId = getObject("approved_by_user_id", UUID::class.java),
        recoveryContactId = getObject("recovery_contact_id", UUID::class.java),
        approvalIdempotencyKey = getObject("approval_idempotency_key", UUID::class.java),
        completedSessionId = getObject("completed_session_id", UUID::class.java),
        completionIdempotencyKey = getObject("completion_idempotency_key", UUID::class.java),
        expiresAt = getObject("expires_at", OffsetDateTime::class.java),
        approvedAt = getObject("approved_at", OffsetDateTime::class.java),
        completedAt = getObject("completed_at", OffsetDateTime::class.java),
    )

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    private fun <T> tx(block: (Connection) -> T): T = dataSource.connection.use { connection ->
        try {
            block(connection).also { connection.commit() }
        } catch (error: Throwable) {
            connection.rollback()
            throw error
        }
    }

    private data class SessionRow(val id: UUID, val userId: UUID)
    private data class ContactRow(
        val id: UUID,
        val ownerId: UUID,
        val trusteeId: UUID,
        val circleId: UUID,
        val revokedAt: OffsetDateTime?,
    )
    private data class AttemptRow(
        val id: UUID,
        val approvalTokenHash: ByteArray,
        val claimTokenHash: ByteArray,
        val creationIdempotencyKey: UUID,
        val initiatingSessionId: UUID?,
        val initiatingUserId: UUID?,
        val status: String,
        val targetUserId: UUID?,
        val approvedByUserId: UUID?,
        val recoveryContactId: UUID?,
        val approvalIdempotencyKey: UUID?,
        val completedSessionId: UUID?,
        val completionIdempotencyKey: UUID?,
        val expiresAt: OffsetDateTime,
        val approvedAt: OffsetDateTime?,
        val completedAt: OffsetDateTime?,
    )

    private companion object {
        val TERMINAL_ATTEMPT_STATUSES = setOf("CANCELLED", "EXPIRED")
    }
}
