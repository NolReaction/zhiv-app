package ru.zhiv.auth

import kotlinx.serialization.Serializable
import ru.zhiv.security.TokenCodec
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

const val MOBILE_AUTH_CALLBACK = "ru.zhiv.mochlik.lab://auth/callback"
private val mobileProofPattern = Regex("^[A-Za-z0-9_-]{43}$")
private val mobileVerifierPattern = Regex("^[A-Za-z0-9._~-]{43,128}$")
private val mobileTokenPattern = Regex("^m1_[A-Za-z0-9_-]{43}$")

@Serializable data class MobileAuthorizeRequest(val challenge: String, val state: String, val platform: String)
@Serializable data class MobileAuthorizeResponse(val url: String)
@Serializable data class MobileExchangeRequest(val code: String, val verifier: String, val state: String, val platform: String)
@Serializable data class MobileSessionResponse(val token: String, val expiresAt: String, val userId: String)
data class MobileAuthorization(val codeHash: ByteArray, val challenge: String, val stateHash: ByteArray, val platform: String)
data class MobileSessionGrant(val userId: UUID, val expiresAt: String)

interface MobileAuthRepository {
    suspend fun authorize(browserSessionHash: ByteArray, authorization: MobileAuthorization)
    suspend fun exchange(authorization: MobileAuthorization, newSessionHash: ByteArray, sessionDays: Long): MobileSessionGrant
}

fun isMobileToken(value: String): Boolean = mobileTokenPattern.matches(value)

/** Distinct raw-token namespace: prefixing a stolen browser token changes its hash. */
fun issueMobileToken(tokens: TokenCodec): String = "m1_${tokens.issue().raw}"

fun mobileAuthorization(body: MobileAuthorizeRequest, codeHash: ByteArray, tokens: TokenCodec): MobileAuthorization {
    if (!mobileProofPattern.matches(body.challenge) || !mobileProofPattern.matches(body.state) || body.platform !in setOf("ios", "android")) {
        throw AuthFailure("INVALID_REQUEST", "Некорректный запрос подключения приложения")
    }
    return MobileAuthorization(codeHash, body.challenge, tokens.hash(body.state), body.platform)
}

fun mobileExchangeProof(body: MobileExchangeRequest, tokens: TokenCodec): MobileAuthorization {
    if (!mobileProofPattern.matches(body.code) || !mobileVerifierPattern.matches(body.verifier)) {
        throw AuthFailure("AUTH_EXPIRED", "Запрос подключения недействителен. Начните вход заново.")
    }
    val challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(body.verifier.toByteArray(Charsets.US_ASCII)),
    )
    return mobileAuthorization(MobileAuthorizeRequest(challenge, body.state, body.platform), tokens.hash(body.code), tokens)
}
