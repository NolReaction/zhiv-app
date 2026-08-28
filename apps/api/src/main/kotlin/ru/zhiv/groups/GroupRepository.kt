package ru.zhiv.groups

import ru.zhiv.relationships.SharingMode
import ru.zhiv.relationships.UserReference
import java.time.OffsetDateTime
import java.util.UUID

enum class GroupRole {
    OWNER,
    ADMIN,
    MEMBER,
}

enum class GroupInviteDirection {
    INCOMING,
    OUTGOING,
}

enum class GroupInviteAction {
    ACCEPTED,
    REVOKED,
}

data class GroupMemberSnapshot(
    val membershipId: UUID,
    val user: UserReference,
    val role: GroupRole,
    val sharingMode: SharingMode,
    val lastCheckInAt: OffsetDateTime?,
    val joinedAt: OffsetDateTime,
    val isMe: Boolean,
)

data class GroupInviteSnapshot(
    val inviteId: UUID,
    val direction: GroupInviteDirection,
    val groupId: UUID,
    val groupTitle: String,
    val groupEmoji: String?,
    val user: UserReference,
    val createdAt: OffsetDateTime,
    val expiresAt: OffsetDateTime,
)

data class GroupSnapshot(
    val groupId: UUID,
    val title: String,
    val emoji: String?,
    val myRole: GroupRole,
    val mySharingMode: SharingMode,
    val createdAt: OffsetDateTime,
    val members: List<GroupMemberSnapshot>,
    val pendingInvites: List<GroupInviteSnapshot>,
)

data class GroupsSnapshot(
    val groups: List<GroupSnapshot>,
    val incomingInvites: List<GroupInviteSnapshot>,
    val outgoingInvites: List<GroupInviteSnapshot>,
    val serverTime: OffsetDateTime,
)

data class GroupMutationSnapshot(
    val groupId: UUID,
    val replayed: Boolean,
    val serverTime: OffsetDateTime,
)

data class GroupRemovedSnapshot(val serverTime: OffsetDateTime)

sealed interface GroupResult<out T> {
    data class Success<T>(val value: T) : GroupResult<T>
    data object Unauthorized : GroupResult<Nothing>
    data object NotFound : GroupResult<Nothing>
    data object Forbidden : GroupResult<Nothing>
    data object Conflict : GroupResult<Nothing>
    data object Expired : GroupResult<Nothing>
}

interface GroupRepository {
    suspend fun listGroups(sessionTokenHash: ByteArray): GroupResult<GroupsSnapshot>

    suspend fun createGroup(
        sessionTokenHash: ByteArray,
        title: String,
        emoji: String?,
        inviteeCircleIds: List<UUID>,
        idempotencyKey: UUID,
    ): GroupResult<GroupMutationSnapshot>

    suspend fun updateGroup(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        title: String,
        emoji: String?,
    ): GroupResult<GroupMutationSnapshot>

    suspend fun updateSharing(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        sharingMode: SharingMode,
    ): GroupResult<GroupMutationSnapshot>

    suspend fun inviteMember(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        personCircleId: UUID,
        idempotencyKey: UUID,
    ): GroupResult<GroupMutationSnapshot>

    suspend fun actOnInvite(
        sessionTokenHash: ByteArray,
        inviteId: UUID,
        action: GroupInviteAction,
    ): GroupResult<GroupMutationSnapshot>

    suspend fun revokeInvite(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        inviteId: UUID,
    ): GroupResult<GroupRemovedSnapshot>

    suspend fun removeMember(
        sessionTokenHash: ByteArray,
        groupId: UUID,
        membershipId: UUID,
    ): GroupResult<GroupRemovedSnapshot>

    suspend fun archiveGroup(
        sessionTokenHash: ByteArray,
        groupId: UUID,
    ): GroupResult<GroupRemovedSnapshot>
}
