package ru.zhiv.relationships

import java.time.OffsetDateTime
import java.util.UUID

enum class SharingMode {
    OFF,
    LATEST_ONLY,
}

enum class RelationshipState {
    SELF,
    NONE,
    CONNECTED,
    INCOMING_REQUEST,
    OUTGOING_REQUEST,
}

enum class RequestDirection {
    INCOMING,
    OUTGOING,
}

enum class RequestAction {
    ACCEPTED,
    REJECTED,
    CANCELLED,
}

data class UserReference(
    val publicId: String,
    val displayName: String,
)

data class UserLookupSnapshot(
    val user: UserReference,
    val relationshipState: RelationshipState,
    val serverTime: OffsetDateTime,
)

data class DirectRequestSnapshot(
    val requestId: UUID,
    val direction: RequestDirection,
    val user: UserReference,
    val createdAt: OffsetDateTime,
    val expiresAt: OffsetDateTime,
)

data class PersonSnapshot(
    val circleId: UUID,
    val user: UserReference,
    val connectedAt: OffsetDateTime,
    val mySharingMode: SharingMode,
    val theirSharingMode: SharingMode,
    val lastCheckInAt: OffsetDateTime?,
)

data class PeopleSnapshot(
    val people: List<PersonSnapshot>,
    val incomingRequests: List<DirectRequestSnapshot>,
    val outgoingRequests: List<DirectRequestSnapshot>,
    val audienceCount: Int,
    val serverTime: OffsetDateTime,
)

data class DirectRequestMutationSnapshot(
    val request: DirectRequestSnapshot,
    val replayed: Boolean,
    val serverTime: OffsetDateTime,
)

data class DirectRequestActionSnapshot(
    val requestId: UUID,
    val status: RequestAction,
    val person: PersonSnapshot?,
    val replayed: Boolean,
    val serverTime: OffsetDateTime,
)

data class SharingSnapshot(
    val circleId: UUID,
    val sharingMode: SharingMode,
    val serverTime: OffsetDateTime,
)

data class RemovedSnapshot(
    val serverTime: OffsetDateTime,
)

sealed interface RelationshipResult<out T> {
    data class Success<T>(val value: T) : RelationshipResult<T>
    data object Unauthorized : RelationshipResult<Nothing>
    data object NotFound : RelationshipResult<Nothing>
    data object Self : RelationshipResult<Nothing>
    data object AlreadyConnected : RelationshipResult<Nothing>
    data object Forbidden : RelationshipResult<Nothing>
    data object Expired : RelationshipResult<Nothing>
    data object Conflict : RelationshipResult<Nothing>
}

interface RelationshipRepository {
    suspend fun lookup(
        sessionTokenHash: ByteArray,
        publicId: String,
    ): RelationshipResult<UserLookupSnapshot>

    suspend fun listPeople(
        sessionTokenHash: ByteArray,
    ): RelationshipResult<PeopleSnapshot>

    suspend fun sendRequest(
        sessionTokenHash: ByteArray,
        targetPublicId: String,
        idempotencyKey: UUID,
    ): RelationshipResult<DirectRequestMutationSnapshot>

    suspend fun actOnRequest(
        sessionTokenHash: ByteArray,
        requestId: UUID,
        action: RequestAction,
    ): RelationshipResult<DirectRequestActionSnapshot>

    suspend fun updateSharing(
        sessionTokenHash: ByteArray,
        circleId: UUID,
        sharingMode: SharingMode,
    ): RelationshipResult<SharingSnapshot>

    suspend fun removePerson(
        sessionTokenHash: ByteArray,
        circleId: UUID,
    ): RelationshipResult<RemovedSnapshot>
}
