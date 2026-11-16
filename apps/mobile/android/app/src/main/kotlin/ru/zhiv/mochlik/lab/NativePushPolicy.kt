package ru.zhiv.mochlik.lab

import android.Manifest
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import java.security.MessageDigest
import java.util.Locale

/** A data-only FCM message cannot bypass the current native session or explicit consent. */
internal object NativePushPolicy {
    const val CHANNEL = "mochlik-remote"
    private const val STORE = "mochlik.native.remote-push.v1"
    private var blocked = false

    private fun preferences(context: Context): SharedPreferences =
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

    fun configured(context: Context): Boolean = try {
        val id = context.resources.getIdentifier("google_app_id", "string", context.packageName)
        id != 0 && context.getString(id).isNotEmpty() && FirebaseApp.getApps(context).isNotEmpty()
    } catch (_: RuntimeException) {
        false
    }

    @Synchronized
    fun activate(context: Context, session: NativeSessionStore.Session, owner: String?) {
        require(NativePushPayload.validOwner(owner)) { "Invalid push owner" }
        val saved = preferences(context).edit()
            .putString("userId", session.userId)
            .putString("owner", owner)
            .putString("sessionTag", digest(session.token))
            .commit()
        check(saved) { "Cannot save push consent" }
        blocked = false
    }

    @Synchronized
    fun clear(context: Context) {
        blocked = true
        val saved = preferences(context).edit().clear().commit()
        clearDelivered(context)
        if (configured(context)) FirebaseMessaging.getInstance().isAutoInitEnabled = false
        check(saved) { "Cannot clear push consent" }
    }

    fun clearDelivered(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        for (item in manager.activeNotifications) {
            val notification = item.notification
            if (notification.group == CHANNEL || notification.extras.getString("source") == "mochlik-remote") {
                manager.cancel(item.tag, item.id)
            }
        }
    }

    @Synchronized
    fun allowed(context: Context, payload: NativePushPayload?): Boolean {
        if (blocked || payload == null) return false
        return try {
            val saved = preferences(context)
            if (payload.owner != saved.getString("owner", null)) return false
            val origin = NativeHttpPolicy(context.getString(R.string.mobile_backend_origin)).origin()
            val session = NativeSessionStore(context, origin).read()
            session != null && session.userId == saved.getString("userId", null) &&
                digest(session.token) == saved.getString("sessionTag", null)
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun receive(context: Context, data: Map<String, String?>?): Boolean {
        val payload = NativePushPayload.parse(data) ?: return false
        if (!allowed(context, payload)) return false
        val process = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(process)
        if (process.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) return true
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return false
        if (!manager.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, "Сообщения сервера", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Письма администрации и напоминания об отметках"
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
            manager.createNotificationChannel(channel)
        }
        val intent = Intent(context, MainActivity::class.java)
            .setAction("ru.zhiv.mochlik.REMOTE.${payload.eventId}")
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("google.message_id", payload.eventId)
            .putExtra("source", "mochlik-remote")
            .putExtra("ownerPublicId", payload.owner)
            .putExtra("target", payload.target)
            .putExtra("eventId", payload.eventId)
        val tap = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val extra = Bundle().apply { putString("source", "mochlik-remote") }
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_mochlik)
            .setContentTitle("Мохлик")
            .setContentText(payload.body())
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setGroup(CHANNEL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .addExtras(extra)
            .build()
        // clear() takes the same monitor, so logout cannot leave a late banner behind.
        manager.notify("$CHANNEL:${payload.eventId}", 0, notification)
        return true
    }

    fun cleanIntent(context: Context, intent: Intent?): Intent? {
        if (intent == null || !intent.hasExtra("google.message_id")) return intent
        val keys = listOf("source", "ownerPublicId", "target", "eventId")
        val data = keys.associateWith(intent::getStringExtra)
        if (allowed(context, NativePushPayload.parse(data))) return intent
        return Intent(intent).apply {
            removeExtra("google.message_id")
            keys.forEach(::removeExtra)
        }
    }

    private fun digest(value: String): String = buildString {
        for (item in MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))) {
            append(String.format(Locale.ROOT, "%02x", item.toInt() and 0xff))
        }
    }
}
