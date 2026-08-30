package ru.zhiv.invites

import ru.zhiv.relationships.PersonSnapshot
import ru.zhiv.relationships.UserReference
import java.time.OffsetDateTime
import java.util.UUID

data class DirectInviteLinkSnapshot(
    val inviteId: UUID,
    val expiresAt: OffsetDateTime,
    val replayed: Boolean,
    val serverTime: OffsetDateTime,
)

data class DirectInvitePreviewSnapshot(
    val inviter: UserReference,
    val expiresAt: OffsetDateTime,
    val serverTime: OffsetDateTime,
)

data class DirectInviteRedeemSnapshot(
    val person: PersonSnapshot,
    val replayed: Boolean,
    val serverTime: OffsetDateTime,
)

sealed interface DirectInviteResult<out T> {
    data class Success<T>(val value: T) : DirectInviteResult<T>
    data object Unauthorized : DirectInviteResult<Nothing>
    data object NotFound : DirectInviteResult<Nothing>
    data object Self : DirectInviteResult<Nothing>
    data object Expired : DirectInviteResult<Nothing>
    data object Conflict : DirectInviteResult<Nothing>
}

interface DirectInviteRepository {
    suspend fun create(
        sessionTokenHash: ByteArray,
        tokenHash: ByteArray,
        idempotencyKey: UUID,
    ): DirectInviteResult<DirectInviteLinkSnapshot>

    suspend fun preview(tokenHash: ByteArray): DirectInviteResult<DirectInvitePreviewSnapshot>

    suspend fun redeem(
        sessionTokenHash: ByteArray,
        tokenHash: ByteArray,
        idempotencyKey: UUID,
    ): DirectInviteResult<DirectInviteRedeemSnapshot>
}
