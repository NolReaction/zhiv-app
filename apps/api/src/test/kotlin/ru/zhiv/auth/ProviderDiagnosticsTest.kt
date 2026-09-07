package ru.zhiv.auth

import kotlinx.coroutines.runBlocking
import ru.zhiv.observability.ProviderFailure
import ru.zhiv.observability.safeExceptionDetails
import java.net.http.HttpTimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertSame

class ProviderDiagnosticsTest {
    @Test
    fun `VK keeps the cause and stage for diagnostics while its public error stays safe`() = runBlocking {
        val cause = HttpTimeoutException("https://id.vk.ru/oauth2/auth?code=provider-secret&email=person@example.invalid")
        val config = AuthConfig(origin = "https://example.invalid", vkClientId = "123")
        val flow = LoginFlow(ByteArray(32), ByteArray(32), "vk", "login", null, null, null, "verifier", null, null)
        VkId(config, VkTransport { _, _ -> throw cause }).use { vk ->
            val failure = assertFailsWith<AuthFailure> { vk.verify("code", "device", "state", flow) }
            assertEquals("VK_LOGIN_FAILED", failure.code)
            assertEquals(502, failure.status)
            val provider = assertIs<ProviderFailure>(failure.cause)
            assertSame(cause, provider.cause)
            assertEquals("vk", provider.provider)
            assertEquals("exchange", provider.stage)
            val output = failure.message + safeExceptionDetails(failure).toString()
            assertFalse(output.contains("provider-secret"))
            assertFalse(output.contains("person@example.invalid"))
            assertFalse(output.contains("https://"))
        }
    }
}
