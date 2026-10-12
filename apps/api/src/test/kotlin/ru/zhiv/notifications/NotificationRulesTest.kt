package ru.zhiv.notifications

import org.junit.jupiter.api.Test
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.Base64
import kotlin.test.*

class NotificationRulesTest {
    @Test fun `quiet hours cross midnight in user zone and end exactly at ten`() {
        val p=NotificationPreferences(timeZone="Europe/Moscow")
        assertEquals(Instant.parse("2026-10-12T07:00:00Z"),nextNotificationWindow(p,Instant.parse("2026-10-11T20:00:00Z")))
        assertEquals(Instant.parse("2026-10-12T07:00:00Z"),nextNotificationWindow(p,Instant.parse("2026-10-12T06:59:59Z")))
        assertEquals(Instant.parse("2026-10-12T07:00:00Z"),nextNotificationWindow(p,Instant.parse("2026-10-12T07:00:00Z")))
        val day=p.copy(quietStart="12:00",quietEnd="14:00")
        assertEquals(Instant.parse("2026-10-12T11:00:00Z"),nextNotificationWindow(day,Instant.parse("2026-10-12T10:00:00Z")))
    }
    @Test fun `quiet window follows DST instead of adding a fixed duration`() {
        val p=NotificationPreferences(timeZone="Europe/Berlin")
        assertEquals(Instant.parse("2026-10-25T09:00:00Z"),nextNotificationWindow(p,Instant.parse("2026-10-24T22:00:00Z")))
        assertEquals(Instant.parse("2026-03-29T08:00:00Z"),nextNotificationWindow(p,Instant.parse("2026-03-28T22:00:00Z")))
    }
    @Test fun `partial preferences do not silently reset omitted fields`() {
        assertFailsWith<SerializationException> { Json.decodeFromString<NotificationPreferences>("{\"constructionCompleted\":false}") }
    }
    @Test fun `previous complete preferences retain rate limits and explicit opt out survives serialization`() {
        val json=Json { encodeDefaults=true }
        val optedOut=NotificationPreferences(rateLimitsEnabled=false)
        val serialized=json.encodeToString(optedOut)
        assertFalse(json.decodeFromString<NotificationPreferences>(serialized).rateLimitsEnabled)
        val legacy=JsonObject(json.parseToJsonElement(serialized).jsonObject - "rateLimitsEnabled")
        assertTrue(json.decodeFromString<NotificationPreferences>(legacy.toString()).rateLimitsEnabled)
        validateNotificationPreferences(optedOut)
    }
    @Test fun `preferences bound spam and reject malformed clocks and zones`() {
        validateNotificationPreferences(NotificationPreferences())
        listOf(NotificationPreferences(maxPerDay=3),NotificationPreferences(minIntervalMinutes=1),
            NotificationPreferences(quietStart="25:00"),NotificationPreferences(quietEnd="23:00"),
            NotificationPreferences(timeZone="../../UTC")).forEach { assertFailsWith<AuthFailure> { validateNotificationPreferences(it) } }
        assertFalse(NotificationPreferences().checkinReminder)
    }
    @Test fun `endpoint allowlist rejects private hosts userinfo ports redirects and deceptive suffixes`() {
        listOf("https://fcm.googleapis.com/fcm/send/test","https://updates.push.services.mozilla.com/wpush/v2/test",
            "https://web.push.apple.com/test","https://abc.notify.windows.com/test").forEach(::validatePushEndpoint)
        listOf("http://fcm.googleapis.com/test","https://127.0.0.1/test","https://localhost/test",
            "https://fcm.googleapis.com.evil.test/test","https://evilpush.apple.com/test",
            "https://user@fcm.googleapis.com/test","https://fcm.googleapis.com:443/test",
            "https://fcm.googleapis.com/test#fragment","https://fcm.googleapis.com/").forEach {
            assertFailsWith<AuthFailure>(it) { validatePushEndpoint(it) }
        }
    }
    @Test fun `subscription requires uncompressed public key and sixteen byte auth secret`() {
        val encoder=Base64.getUrlEncoder().withoutPadding()
        val key=ByteArray(65).also { it[0]=4 }
        val valid=BrowserPushSubscription("https://fcm.googleapis.com/fcm/send/test",PushKeys(encoder.encodeToString(key),encoder.encodeToString(ByteArray(16))))
        validatePushSubscription(valid)
        assertFailsWith<AuthFailure> { validatePushSubscription(valid.copy(keys=valid.keys.copy(auth="AAAA"))) }
        assertFailsWith<AuthFailure> { validatePushSubscription(valid.copy(keys=valid.keys.copy(p256dh=encoder.encodeToString(ByteArray(65))))) }
    }
    @Test fun `missing VAPID stays unconfigured and partial config fails without exposing secrets`() {
        assertFalse(WebPushConfig.fromEnvironment(emptyMap()).configured)
        assertEquals("not_configured",WebPushConfig().delivery().reason)
        val sentinel=java.util.UUID.randomUUID().toString()
        val failure=assertFailsWith<IllegalArgumentException> { WebPushConfig.fromEnvironment(mapOf("WEB_PUSH_VAPID_PRIVATE_KEY" to sentinel)) }
        assertFalse(failure.message.orEmpty().contains(sentinel))
        assertFalse(WebPushConfig(privateKey=sentinel).toString().contains(sentinel))
    }
}
