package ru.zhiv.mochlik.lab

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class NativePushPayloadTest {
    private fun payload(): MutableMap<String, String> = mutableMapOf(
        "source" to "mochlik-remote",
        "ownerPublicId" to "AAAA-0000-0001",
        "target" to "mailbox",
        "eventId" to "11111111-1111-4111-8111-111111111111",
    )

    @Test
    fun acceptsOnlyAccountScopedNonMutatingDestinations() {
        val data = payload()
        assertNotNull(NativePushPayload.parse(data))
        data["target"] = "checkin"
        assertNotNull(NativePushPayload.parse(data))
        for (target in listOf("construction", "production", "https://evil.test", "logout", "")) {
            data["target"] = target
            assertNull(NativePushPayload.parse(data))
        }
    }

    @Test
    fun rejectsMalformedUnownedMessages() {
        assertNull(NativePushPayload.parse(null))
        for (key in listOf("source", "ownerPublicId", "target", "eventId")) {
            val data = payload()
            data.remove(key)
            assertNull(NativePushPayload.parse(data))
        }
        for (owner in listOf("AAAA-OOOO-0001", "owner", "AAAA-0000-0001\n", "")) {
            val data = payload()
            data["ownerPublicId"] = owner
            assertNull(NativePushPayload.parse(data))
        }
        val data = payload()
        data["eventId"] = "not-a-uuid"
        assertNull(NativePushPayload.parse(data))
    }

    @Test
    fun rejectsNullIntentExtras() {
        for (key in listOf("source", "ownerPublicId", "target", "eventId")) {
            val data = payload().mapValuesTo(mutableMapOf<String, String?>()) { it.value }
            data[key] = null
            assertNull(NativePushPayload.parse(data))
        }
    }

    @Test
    fun visibleTextNeverUsesPrivatePayloadFields() {
        val data = payload()
        data["body"] = "Private message"
        data["latitude"] = "55.0"
        assertEquals("В приложении есть новое письмо.", NativePushPayload.parse(data)?.body())
        data["target"] = "checkin"
        assertEquals("Откройте приложение, чтобы проверить отметку.", NativePushPayload.parse(data)?.body())
    }
}
