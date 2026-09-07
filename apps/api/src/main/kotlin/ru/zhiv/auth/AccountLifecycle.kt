package ru.zhiv.auth

import kotlinx.serialization.Serializable

@Serializable data class AccountProfile(val publicId: String, val displayName: String, val status: String? = null)
@Serializable data class AccountLifecycleState(
    val currentEmail: Boolean = false, val currentMerge: Boolean = false, val currentDelete: Boolean = false,
    val other: AccountProfile? = null, val newEmail: String? = null,
)
@Serializable data class AccountConfirmRequest(val confirm: Boolean = false, val idempotencyKey: String? = null)
@Serializable data class MergeChoices(
    val displayNameSource: String = "current", val statusSource: String = "current",
    val providerChoices: Map<String, String> = emptyMap(),
)
@Serializable data class MergeProviderConflict(val provider: String, val current: String, val other: String)
@Serializable data class MergePreview(
    val preview: String, val current: AccountProfile, val other: AccountProfile,
    val displayName: String, val status: String?, val effects: List<String>, val conflicts: List<String>,
    val providerConflicts: List<MergeProviderConflict>, val expiresInSeconds: Int = 300,
)
@Serializable data class MergeConfirmRequest(val preview: String, val confirm: Boolean = false)

interface AccountLifecycleRepository {
    suspend fun recordAccountProof(flow: LoginFlow, subject: String) { throw AuthFailure("AUTH_UNAVAILABLE", "Операция недоступна", 503) }
    suspend fun lifecycle(sessionHash: ByteArray, browserHash: ByteArray): AccountLifecycleState = AccountLifecycleState()
    suspend fun changeEmail(sessionHash: ByteArray, browserHash: ByteArray, requestHash: ByteArray) { throw AuthFailure("AUTH_UNAVAILABLE", "Операция недоступна", 503) }
    suspend fun previewMerge(sessionHash: ByteArray, browserHash: ByteArray, choices: MergeChoices, previewHash: ByteArray): MergePreview { throw AuthFailure("AUTH_UNAVAILABLE", "Операция недоступна", 503) }
    suspend fun confirmMerge(sessionHash: ByteArray, browserHash: ByteArray, previewHash: ByteArray) { throw AuthFailure("AUTH_UNAVAILABLE", "Операция недоступна", 503) }
    suspend fun deleteAccount(sessionHash: ByteArray, browserHash: ByteArray, requestHash: ByteArray) { throw AuthFailure("AUTH_UNAVAILABLE", "Операция недоступна", 503) }
}
