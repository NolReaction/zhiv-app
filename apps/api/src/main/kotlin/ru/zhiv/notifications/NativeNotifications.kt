package ru.zhiv.notifications

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure

val nativePushCategories = setOf("mail", "checkin")

@Serializable data class NativeNotificationDelivery(
    val configured: Boolean,
    val platform: String,
    val reason: String? = null,
    val categories: List<String> = listOf("mail", "checkin"),
)
@Serializable data class NativeNotificationView(
    val ownerPublicId: String,
    val preferences: NotificationPreferences,
    val delivery: NativeNotificationDelivery,
    val subscription: NotificationSubscriptionState,
)
@Serializable data class NativeNotificationSubscribeRequest(val expectedOwnerPublicId: String, val platform: String, val token: String) {
    override fun toString(): String = "NativeNotificationSubscribeRequest(platform=$platform,token=<redacted>)"
}
@Serializable data class NativeNotificationUnsubscribeRequest(val expectedOwnerPublicId: String, val platform: String)

interface NativeNotificationRepository {
    suspend fun snapshot(hash: ByteArray, owner: String, platform: String): NativeNotificationView
    suspend fun subscribe(hash: ByteArray, owner: String, platform: String, token: String): NativeNotificationView
    suspend fun unsubscribe(hash: ByteArray, owner: String, platform: String): NativeNotificationView
}

fun validateNativePushPlatform(platform: String) {
    if (platform !in setOf("ios", "android")) invalidNotification()
}
fun validateNativePushToken(platform: String, token: String) {
    validateNativePushPlatform(platform)
    val valid = when (platform) {
        // APNs device token length is not assumed to be fixed at 32 bytes.
        "ios" -> token.length in 32..512 && token.length % 2 == 0 && token.matches(Regex("^[0-9a-f]+$"))
        else -> token.length in 16..4096 && token.matches(Regex("^[A-Za-z0-9_:./~+=-]+$"))
    }
    if (!valid) throw AuthFailure("INVALID_NATIVE_PUSH_TOKEN", "Не удалось подключить уведомления устройства", 400)
}
