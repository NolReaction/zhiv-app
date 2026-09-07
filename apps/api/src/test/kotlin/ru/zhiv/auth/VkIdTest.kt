package ru.zhiv.auth

import kotlinx.coroutines.runBlocking
import java.net.URLDecoder
import kotlin.test.*

class VkIdTest {
    private val config = AuthConfig(origin = "https://im-alive.ru", vkClientId = "123")
    private val flow = LoginFlow(ByteArray(32), ByteArray(32), "vk", "login", null, null, null, "verifier", null, null)
    private fun values(form: String) = form.split('&').associate { item ->
        val parts = item.split('=', limit = 2)
        URLDecoder.decode(parts[0], Charsets.UTF_8) to URLDecoder.decode(parts[1], Charsets.UTF_8)
    }

    @Test fun `uses server PKCE exchange then confirms the same user at VK`() = runBlocking {
        var requests = 0
        VkId(config, VkTransport { uri, form ->
            requests++
            assertEquals("https", uri.scheme); assertEquals("id.vk.ru", uri.host)
            if (requests == 1) {
                assertEquals("/oauth2/auth", uri.path)
                val query = values(uri.rawQuery)
                assertEquals("verifier", query["code_verifier"])
                assertEquals("device", query["device_id"])
                assertEquals("state", query["state"])
                assertEquals(config.vkCallback, query["redirect_uri"])
                assertEquals("one+time/code", values(form)["code"])
                """{"state":"state","user_id":456,"access_token":"access-secret"}""".toByteArray()
            } else {
                assertEquals("/oauth2/user_info", uri.path)
                assertEquals("123", values(uri.rawQuery)["client_id"])
                assertEquals("access-secret", values(form)["access_token"])
                """{"user":{"user_id":"456"}}""".toByteArray()
            }
        }).use { assertEquals("456", it.verify("one+time/code", "device", "state", flow).subject) }
        assertEquals(2, requests)
    }

    @Test fun `rejects state mismatch before requesting user information`() = runBlocking {
        var requests = 0
        VkId(config, VkTransport { _, _ ->
            requests++; """{"state":"wrong","user_id":456,"access_token":"secret"}""".toByteArray()
        }).use {
            val error = assertFailsWith<AuthFailure> { it.verify("code", "device", "state", flow) }
            assertEquals("VK_LOGIN_FAILED", error.code)
            assertFalse(error.message.contains("secret"))
        }
        assertEquals(1, requests)
    }

    @Test fun `rejects conflicting identity provider error and oversized payload`() = runBlocking {
        for (badInfo in listOf("""{"user":{"user_id":"789"}}""", """{"error":"secret-provider-error"}""", "x".repeat(65_537))) {
            var requests = 0
            VkId(config, VkTransport { _, _ ->
                requests++
                (if (requests == 1) """{"state":"state","user_id":456,"access_token":"secret"}""" else badInfo).toByteArray()
            }).use {
                val error = assertFailsWith<AuthFailure> { it.verify("code", "device", "state", flow) }
                assertEquals("VK_LOGIN_FAILED", error.code)
                assertFalse(error.message.contains("secret"))
            }
        }
    }

    @Test fun `selectel relay supports implicit TLS independently of its port`() {
        val configured = AuthConfig.fromEnvironment(mapOf(
            "VK_CLIENT_ID" to "123", "SMTP_HOST" to "smtp.mail.selcloud.ru", "SMTP_PORT" to "1127",
            "SMTP_TLS_MODE" to "implicit", "SMTP_USER" to "test", "SMTP_PASSWORD" to "test-password",
            "SMTP_FROM" to "login@im-alive.ru", "AUTH_CODE_SECRET" to "x".repeat(32),
        ), setOf("https://im-alive.ru"))
        assertTrue(configured.vkEnabled); assertTrue(configured.emailEnabled)
        assertTrue(configured.smtpImplicitTls); assertEquals(1127, configured.smtpPort)
        assertEquals("https://im-alive.ru/api/v1/auth/vk/callback", configured.vkCallback)
    }
}
