package ru.zhiv.auth

import ru.zhiv.security.TokenCodec
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MobileAuthTest {
    private val tokens = TokenCodec()

    @Test fun `S256 uses the RFC 7636 vector and does not accept a plain challenge`() {
        val proof = mobileExchangeProof(MobileExchangeRequest(
            code = "c".repeat(43), verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
            state = "s".repeat(43), platform = "ios",
        ), tokens)
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", proof.challenge)
        assertContentEquals(tokens.hash("s".repeat(43)), proof.stateHash)
        assertContentEquals(tokens.hash("c".repeat(43)), proof.codeHash)
    }

    @Test fun `mobile and browser raw tokens occupy disjoint hash namespaces`() {
        val browser = tokens.issue().raw
        val mobile = issueMobileToken(tokens)
        assertFalse(isMobileToken(browser))
        assertTrue(isMobileToken(mobile))
        assertFalse(tokens.hash(browser).contentEquals(tokens.hash("m1_$browser")))
        for (invalid in listOf("m1_", "$mobile ", "m1_${"x".repeat(42)}", "m1_${"x".repeat(44)}")) assertFalse(isMobileToken(invalid))
    }

    @Test fun `authorize rejects arbitrary redirects malformed state and unknown platforms`() {
        val valid = MobileAuthorizeRequest("a".repeat(43), "b".repeat(43), "android")
        for (body in listOf(valid.copy(challenge = "https://evil.example"), valid.copy(state = "x&code=stolen"), valid.copy(platform = "web"))) {
            assertFailsWith<AuthFailure> { mobileAuthorization(body, tokens.issue().hash, tokens) }
        }
        assertEquals("ru.zhiv.mochlik.lab://auth/callback", MOBILE_AUTH_CALLBACK)
    }

    @Test fun `exchange refuses non RFC verifier characters and invalid lengths`() {
        val valid = MobileExchangeRequest("c".repeat(43), "v".repeat(43), "s".repeat(43), "ios")
        for (verifier in listOf("v".repeat(42), "v".repeat(129), "\u0430".repeat(43), "/".repeat(43))) {
            assertFailsWith<AuthFailure> { mobileExchangeProof(valid.copy(verifier = verifier), tokens) }
        }
    }
}
