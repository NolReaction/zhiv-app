package ru.zhiv.http

import kotlinx.serialization.Serializable

@Serializable
data class PublicUserDto(
    val publicId: String,
    val displayName: String,
)

@Serializable
data class MeResponse(
    val user: PublicUserDto,
    val lastCheckInAt: String?,
    val checkInCount: Long,
    val serverTime: String,
)

@Serializable
data class BootstrapRequest(val displayName: String)

@Serializable
data class CheckInResponse(
    val eventId: String,
    val checkedAt: String,
    val checkInCount: Long,
    val serverTime: String,
    val nextAllowedAt: String,
    val replayed: Boolean,
)

@Serializable
data class CooldownResponse(
    val code: String = "CHECK_IN_COOLDOWN",
    val checkedAt: String,
    val serverTime: String,
    val nextAllowedAt: String,
)

@Serializable
data class ApiErrorResponse(val code: String, val message: String)

@Serializable
data class UserLookupResponse(
    val user: PublicUserDto,
    val relationshipState: String,
    val serverTime: String,
)

@Serializable
data class CreateDirectRequestRequest(val publicId: String)

@Serializable
data class UpdateSharingRequest(val sharingMode: String)

@Serializable
data class DirectRequestDto(
    val requestId: String,
    val direction: String,
    val user: PublicUserDto,
    val createdAt: String,
    val expiresAt: String,
)

@Serializable
data class PersonDto(
    val circleId: String,
    val user: PublicUserDto,
    val connectedAt: String,
    val mySharingMode: String,
    val theirSharingMode: String,
    val lastCheckInAt: String?,
)

@Serializable
data class PeopleResponse(
    val people: List<PersonDto>,
    val incomingRequests: List<DirectRequestDto>,
    val outgoingRequests: List<DirectRequestDto>,
    val audienceCount: Int,
    val serverTime: String,
)

@Serializable
data class DirectRequestsResponse(
    val incomingRequests: List<DirectRequestDto>,
    val outgoingRequests: List<DirectRequestDto>,
    val serverTime: String,
)

@Serializable
data class DirectRequestResponse(
    val request: DirectRequestDto,
    val replayed: Boolean,
    val serverTime: String,
)

@Serializable
data class DirectRequestActionResponse(
    val requestId: String,
    val status: String,
    val person: PersonDto?,
    val replayed: Boolean,
    val serverTime: String,
)

@Serializable
data class SharingResponse(
    val circleId: String,
    val sharingMode: String,
    val serverTime: String,
)

@Serializable
data class CreateGroupRequest(
    val title: String,
    val emoji: String? = null,
    val inviteeCircleIds: List<String> = emptyList(),
)

@Serializable
data class UpdateGroupRequest(
    val title: String,
    val emoji: String? = null,
)

@Serializable
data class CreateGroupInviteRequest(val personCircleId: String)

@Serializable
data class GroupMemberDto(
    val membershipId: String,
    val user: PublicUserDto,
    val role: String,
    val sharingMode: String,
    val lastCheckInAt: String?,
    val joinedAt: String,
    val isMe: Boolean,
)

@Serializable
data class GroupInviteDto(
    val inviteId: String,
    val direction: String,
    val groupId: String,
    val groupTitle: String,
    val groupEmoji: String?,
    val user: PublicUserDto,
    val createdAt: String,
    val expiresAt: String,
)

@Serializable
data class GroupDto(
    val groupId: String,
    val title: String,
    val emoji: String?,
    val myRole: String,
    val mySharingMode: String,
    val createdAt: String,
    val members: List<GroupMemberDto>,
    val pendingInvites: List<GroupInviteDto>,
)

@Serializable
data class GroupsResponse(
    val groups: List<GroupDto>,
    val incomingInvites: List<GroupInviteDto>,
    val outgoingInvites: List<GroupInviteDto>,
    val serverTime: String,
)

@Serializable
data class GroupMutationResponse(
    val groupId: String,
    val replayed: Boolean,
    val serverTime: String,
)
