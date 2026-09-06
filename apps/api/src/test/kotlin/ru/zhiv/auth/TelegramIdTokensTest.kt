package ru.zhiv.auth

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator
import com.nimbusds.jose.jwk.source.ImmutableJWKSet
import com.nimbusds.jose.proc.SecurityContext
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import java.time.Instant
import java.util.Date
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertNotEquals

class TelegramIdTokensTest {
    private val key = RSAKeyGenerator(2048).keyID("test-key").generate()
    private val validator = TelegramIdTokens("client", ImmutableJWKSet<SecurityContext>(JWKSet(key.toPublicJWK())))
    private fun token(issuer: String = "https://oauth.telegram.org", audience: String = "client", nonce: String = "nonce", expires: Long = 300, issued: Long = 0, azp: String? = null): String {
        val claims = JWTClaimsSet.Builder().issuer(issuer).subject("opaque-subject").audience(audience)
            .issueTime(Date.from(Instant.now().plusSeconds(issued))).expirationTime(Date.from(Instant.now().plusSeconds(expires)))
            .claim("nonce", nonce).apply { if (azp != null) claim("azp", azp) }.build()
        return SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.keyID).build(), claims).apply { sign(RSASSASigner(key)) }.serialize()
    }
    @Test fun `accepts signed provider identity and rejects claim confusion`() {
        assertEquals("opaque-subject", validator.verify(token(), "nonce").subject)
        for (bad in listOf(token(issuer = "https://evil.example"), token(audience = "other"), token(nonce = "other"), token(expires = -120), token(issued = 300), token(issued = -2000), token(azp = "other"))) {
            assertFails { validator.verify(bad, "nonce") }
        }
    }
    @Test fun `rejects forged signature even when claims match`() {
        val original = SignedJWT.parse(token())
        val forged = SignedJWT(original.header, original.jwtClaimsSet).apply { sign(RSASSASigner(RSAKeyGenerator(2048).generate())) }
        assertFails { validator.verify(forged.serialize(), "nonce") }
    }
    @Test fun `email digest is keyed and bound to each flow`() {
        assertNotEquals(codeDigest("secret", "flow-a", "123456").toList(), codeDigest("secret", "flow-b", "123456").toList())
        assertNotEquals(codeDigest("secret", "flow-a", "123456").toList(), codeDigest("other", "flow-a", "123456").toList())
        assertEquals("a+b@example.com", normalizedEmail(" A+B@Example.com "))
        assertEquals(null, normalizedEmail("a@example.com\r\nBcc: victim@example.com"))
    }
}
