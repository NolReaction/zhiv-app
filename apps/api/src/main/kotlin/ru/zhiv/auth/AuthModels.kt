package ru.zhiv.auth

import kotlinx.serialization.Serializable
import java.util.UUID

open class AuthFailure(val code: String, override val message: String, val status: Int = 400) : RuntimeException(message)

// Internal signal; the public error stays AUTH_EXPIRED unless a valid app session exists.
class ConsumedVkFlow : AuthFailure("AUTH_EXPIRED", "Запрос входа уже использован")

@Serializable data class AuthOptions(val telegram: Boolean, val email: Boolean, val vk: Boolean = false)
@Serializable data class AuthStartRequest(val intent: String = "login", val displayName: String? = null, val email: String? = null)
@Serializable data class AuthStartResponse(val flow: String, val url: String? = null)
@Serializable data class EmailVerifyRequest(val flow: String, val code: String)
@Serializable data class LoginMethod(val provider: String, val label: String)
@Serializable data class LoginSession(val id: String, val label: String, val createdAt: String, val lastSeenAt: String, val current: Boolean)
@Serializable data class AccountAccess(val methods: List<LoginMethod>, val sessions: List<LoginSession>)
@Serializable data class AuthDone(val status: String = "ok")
@Serializable data class RegistrationRequest(val displayName: String)
@Serializable data class RegistrationState(val pending: Boolean)

data class LoginFlow(
    val tokenHash: ByteArray, val browserHash: ByteArray, val provider: String, val intent: String,
    val sessionHash: ByteArray?, val displayName: String?, val subject: String?,
    val verifier: String?, val nonce: String?, val codeHash: ByteArray?,
)

data class VerifiedTelegram(val subject: String)
data class VerifiedVk(val subject: String)

fun normalizedEmail(raw: String): String? {
    val value = raw.trim().lowercase(java.util.Locale.ROOT)
    // A deliberately conservative mailbox syntax; do not rewrite dots or plus aliases.
    return value.takeIf { it.length <= 254 && Regex("^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,63}$").matches(it) }
}

fun loginDisplayName(raw: String?): String? = raw?.trim()?.replace(Regex("[\\s\\p{Z}]+"), " ")?.takeIf {
    it.codePointCount(0, it.length) in 1..50 && it.none { c -> c.isISOControl() || c in '\u202a'..'\u202e' || c in '\u2066'..'\u2069' }
}

fun deviceLabel(userAgent: String): String {
    val browser = when { "Telegram" in userAgent -> "Telegram"; "Edg" in userAgent -> "Edge"; "Firefox" in userAgent || "FxiOS" in userAgent -> "Firefox"; "Chrome" in userAgent || "CriOS" in userAgent -> "Chrome"; "Safari" in userAgent -> "Safari"; else -> "Браузер" }
    val system = when { "iPhone" in userAgent -> "iPhone"; "iPad" in userAgent -> "iPad"; "Android" in userAgent -> "Android"; "Windows" in userAgent -> "Windows"; "Mac" in userAgent -> "Mac"; "Linux" in userAgent -> "Linux"; else -> "" }
    return listOf(browser, system).filter(String::isNotEmpty).joinToString(" · ")
}

interface AuthRepository {
    suspend fun create(flow: LoginFlow)
    suspend fun takeTelegram(tokenHash: ByteArray, browserHash: ByteArray): LoginFlow
    suspend fun takeVk(tokenHash: ByteArray, browserHash: ByteArray): LoginFlow
    suspend fun verifyEmail(tokenHash: ByteArray, browserHash: ByteArray, codeHash: ByteArray): LoginFlow
    suspend fun finish(flow: LoginFlow, subject: String, newSessionHash: ByteArray, sessionDays: Long, label: String): UUID
    suspend fun prepareRegistration(flow: LoginFlow, subject: String, ticketHash: ByteArray)
    suspend fun hasRegistration(ticketHash: ByteArray, browserHash: ByteArray): Boolean
    suspend fun completeRegistration(ticketHash: ByteArray, browserHash: ByteArray, displayName: String, newSessionHash: ByteArray, sessionDays: Long, label: String): UUID
    suspend fun access(sessionHash: ByteArray): AccountAccess
    suspend fun revoke(sessionHash: ByteArray, target: UUID? = null, others: Boolean = false)
}
