package ru.zhiv.security

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

data class SessionToken(val raw: String, val hash: ByteArray)

class TokenCodec(private val random: SecureRandom = SecureRandom()) {
    fun issue(): SessionToken {
        val bytes = ByteArray(32).also(random::nextBytes)
        val raw = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        return SessionToken(raw, hash(raw))
    }

    fun hash(raw: String): ByteArray = MessageDigest.getInstance("SHA-256")
        .digest(raw.toByteArray(Charsets.UTF_8))
}
