package ru.zhiv.notifications

import kotlinx.serialization.Serializable
import kotlinx.serialization.Required
import ru.zhiv.auth.AuthFailure
import java.net.URI
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.util.Base64

@Serializable data class NotificationPreferences(
    @Required val constructionCompleted: Boolean = true,
    @Required val explorationCompleted: Boolean = true,
    @Required val productionCompleted: Boolean = true,
    // Older saved JSON inherits the category, never device permission or a subscription.
    val administrationMessages: Boolean = true,
    @Required val checkinReminder: Boolean = false,
    @Required val quietHoursEnabled: Boolean = true,
    @Required val quietStart: String = "23:00",
    @Required val quietEnd: String = "10:00",
    @Required val timeZone: String = "Europe/Moscow",
    // Missing preferences use the current default; explicit saved choices remain unchanged.
    val rateLimitsEnabled: Boolean = false,
    @Required val maxPerDay: Int = 2,
    @Required val minIntervalMinutes: Int = 120,
) {
    fun enabled(category: String): Boolean = when (category) {
        "construction" -> constructionCompleted
        "exploration" -> explorationCompleted
        "production" -> productionCompleted
        "mail" -> administrationMessages
        "checkin" -> checkinReminder
        else -> false
    }
}
@Serializable data class PushKeys(val p256dh: String, val auth: String)
@Serializable data class BrowserPushSubscription(val endpoint: String, val keys: PushKeys)
@Serializable data class NotificationDelivery(val configured: Boolean, val publicKey: String? = null, val reason: String? = null)
@Serializable data class NotificationSubscriptionState(val subscribed: Boolean)
@Serializable data class NotificationView(val ownerPublicId: String, val preferences: NotificationPreferences,
    val delivery: NotificationDelivery, val subscription: NotificationSubscriptionState)
@Serializable data class NotificationPreferencesRequest(val expectedOwnerPublicId: String, val preferences: NotificationPreferences)
@Serializable data class NotificationSubscribeRequest(val expectedOwnerPublicId: String, val subscription: BrowserPushSubscription)
@Serializable data class NotificationUnsubscribeRequest(val expectedOwnerPublicId: String, val endpoint: String)
@Serializable data class NotificationPresenceRequest(val expectedOwnerPublicId: String)
@Serializable data class NotificationPresenceResponse(val status: String = "ok")
@Serializable data class PushPayload(val title: String, val body: String, val tag: String, val url: String, val ownerPublicId: String)

interface NotificationRepository {
    suspend fun snapshot(hash: ByteArray, owner: String): NotificationView
    suspend fun preferences(hash: ByteArray, owner: String, preferences: NotificationPreferences): NotificationView
    suspend fun subscribe(hash: ByteArray, owner: String, subscription: BrowserPushSubscription): NotificationView
    suspend fun unsubscribe(hash: ByteArray, owner: String, endpoint: String): NotificationView
    suspend fun presence(hash: ByteArray, owner: String)
}
internal fun invalidNotification(): Nothing = throw AuthFailure("INVALID_NOTIFICATION_SETTINGS", "Проверьте настройки уведомлений", 400)
fun validateNotificationPreferences(p: NotificationPreferences) {
    if (p.maxPerDay !in 1..2 || p.minIntervalMinutes !in 60..1440 || p.timeZone.length > 64 ||
        p.timeZone !in ZoneId.getAvailableZoneIds() || !p.quietStart.matches(Regex("^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")) ||
        !p.quietEnd.matches(Regex("^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")) || p.quietStart == p.quietEnd) invalidNotification()
}

/** Browser push services only. No user-configurable origin, credentials, port,
 * fragment or redirect can turn the sender into a generic HTTP client. */
fun validatePushEndpoint(endpoint: String) {
    val uri = runCatching { URI(endpoint) }.getOrNull() ?: invalidNotification()
    val host = uri.host?.lowercase() ?: invalidNotification()
    val allowed = host == "fcm.googleapis.com" || host == "updates.push.services.mozilla.com" ||
        host == "web.push.apple.com" || host.endsWith(".push.apple.com") ||
        host == "wns.windows.com" || host.endsWith(".notify.windows.com")
    if (!allowed || endpoint.length !in 20..2048 || uri.scheme != "https" || uri.rawUserInfo != null ||
        uri.port != -1 || uri.rawFragment != null || uri.rawPath.isNullOrEmpty() || uri.rawPath == "/" ||
        endpoint.any { it.code <= 32 || it.code == 127 }) invalidNotification()
}
fun validatePushSubscription(subscription: BrowserPushSubscription) {
    validatePushEndpoint(subscription.endpoint)
    fun decode(value: String, length: Int): ByteArray {
        if (!value.matches(Regex("^[A-Za-z0-9_-]+={0,2}$")) || value.length > 100) invalidNotification()
        val bytes = runCatching { Base64.getUrlDecoder().decode(value) }.getOrNull() ?: invalidNotification()
        if (bytes.size != length) invalidNotification()
        return bytes
    }
    if (decode(subscription.keys.p256dh, 65)[0] != 4.toByte()) invalidNotification()
    decode(subscription.keys.auth, 16)
}

/** Calculate in the chosen zone (including DST), never in the server's zone. */
fun nextNotificationWindow(p: NotificationPreferences, now: Instant): Instant {
    if (!p.quietHoursEnabled) return now
    val local = now.atZone(ZoneId.of(p.timeZone))
    val start = LocalTime.parse(p.quietStart)
    val end = LocalTime.parse(p.quietEnd)
    val time = local.toLocalTime()
    val quiet = if (start < end) time >= start && time < end else time >= start || time < end
    if (!quiet) return now
    val date = if (start > end && time >= start) local.toLocalDate().plusDays(1) else local.toLocalDate()
    return date.atTime(end).atZone(local.zone).toInstant()
}
