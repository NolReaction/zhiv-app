package ru.zhiv.recovery

import ru.zhiv.identity.UserSnapshot
import ru.zhiv.relationships.UserReference
import java.time.OffsetDateTime
import java.util.UUID

data class RecoveryContactSnapshot(val contactId: UUID, val circleId: UUID, val user: UserReference)
data class RecoveryEligibleSnapshot(val circleId: UUID, val user: UserReference)
data class RecoveryContactsSnapshot(
    val contacts: List<RecoveryContactSnapshot>,
    val eligible: List<RecoveryEligibleSnapshot>,
    val trustedBy: List<RecoveryContactSnapshot>,
    val serverTime: OffsetDateTime,
)

enum class RecoveryAttemptStatus { PENDING, APPROVED, COMPLETED }

data class RecoveryAttemptSnapshot(
    val attemptId: UUID,
    val status: RecoveryAttemptStatus,
    val expiresAt: OffsetDateTime,
    val target: UserReference?,
    val replayed: Boolean,
    val serverTime: OffsetDateTime,
)

data class RecoveryApprovalCandidateSnapshot(
    val contactId: UUID,
    val target: UserReference,
)

data class RecoveryApprovalPreviewSnapshot(
    val eligible: List<RecoveryApprovalCandidateSnapshot>,
    val expiresAt: OffsetDateTime,
    val serverTime: OffsetDateTime,
)

data class RecoveryCompletionSnapshot(
    val attempt: RecoveryAttemptSnapshot,
    val user: UserSnapshot,
)

sealed interface RecoveryResult<out T> {
    data class Success<T>(val value: T) : RecoveryResult<T>
    data object Unauthorized : RecoveryResult<Nothing>
    data object NotFound : RecoveryResult<Nothing>
    data object Forbidden : RecoveryResult<Nothing>
    data object Expired : RecoveryResult<Nothing>
    data object Conflict : RecoveryResult<Nothing>
    data object LimitReached : RecoveryResult<Nothing>
}

interface RecoveryRepository {
    suspend fun list(sessionTokenHash: ByteArray): RecoveryResult<RecoveryContactsSnapshot>
    suspend fun add(sessionTokenHash: ByteArray, circleId: UUID, key: UUID): RecoveryResult<RecoveryContactsSnapshot>
    suspend fun remove(sessionTokenHash: ByteArray, contactId: UUID, key: UUID): RecoveryResult<RecoveryContactsSnapshot>

    suspend fun createAttempt(
        approvalTokenHash: ByteArray,
        claimTokenHash: ByteArray,
        key: UUID,
        initiatingSessionTokenHash: ByteArray?,
    ): RecoveryResult<RecoveryAttemptSnapshot>

    suspend fun currentAttempt(claimTokenHash: ByteArray): RecoveryResult<RecoveryAttemptSnapshot>
    suspend fun cancelAttempt(claimTokenHash: ByteArray): RecoveryResult<Unit>

    suspend fun previewApproval(
        sessionTokenHash: ByteArray,
        approvalTokenHash: ByteArray,
    ): RecoveryResult<RecoveryApprovalPreviewSnapshot>

    suspend fun confirmApproval(
        sessionTokenHash: ByteArray,
        approvalTokenHash: ByteArray,
        contactId: UUID,
        key: UUID,
    ): RecoveryResult<RecoveryAttemptSnapshot>

    suspend fun completeAttempt(
        claimTokenHash: ByteArray,
        key: UUID,
        sessionLifetimeDays: Long,
    ): RecoveryResult<RecoveryCompletionSnapshot>
}
