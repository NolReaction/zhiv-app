package ru.zhiv.mochlik.lab;

import android.Manifest;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;

/** A data-only FCM message cannot bypass the current native session or explicit consent. */
final class NativePushPolicy {
    static final String CHANNEL = "mochlik-remote";
    private static final String STORE = "mochlik.native.remote-push.v1";
    private static boolean blocked;
    private static SharedPreferences preferences(Context context) { return context.getSharedPreferences(STORE, Context.MODE_PRIVATE); }

    static boolean configured(Context context) {
        try {
            int id = context.getResources().getIdentifier("google_app_id", "string", context.getPackageName());
            return id != 0 && !context.getString(id).isEmpty() && !FirebaseApp.getApps(context).isEmpty();
        } catch (RuntimeException ignored) { return false; }
    }
    static synchronized void activate(Context context, NativeSessionStore.Session session, String owner) throws Exception {
        if (!NativePushPayload.validOwner(owner)) throw new IllegalArgumentException("Invalid push owner");
        if (!preferences(context).edit().putString("userId", session.userId).putString("owner", owner)
            .putString("sessionTag", digest(session.token)).commit()) throw new IllegalStateException("Cannot save push consent");
        blocked = false;
    }
    static synchronized void clear(Context context) {
        blocked = true;
        boolean saved = preferences(context).edit().clear().commit();
        clearDelivered(context);
        if (configured(context)) FirebaseMessaging.getInstance().setAutoInitEnabled(false);
        if (!saved) throw new IllegalStateException("Cannot clear push consent");
    }
    static void clearDelivered(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        for (StatusBarNotification item : manager.getActiveNotifications()) {
            Notification notification = item.getNotification();
            if (CHANNEL.equals(notification.getGroup()) || "mochlik-remote".equals(notification.extras.getString("source"))) {
                manager.cancel(item.getTag(), item.getId());
            }
        }
    }
    static synchronized boolean allowed(Context context, NativePushPayload payload) {
        if (blocked || payload == null) return false;
        try {
            SharedPreferences saved = preferences(context);
            if (!payload.owner.equals(saved.getString("owner", null))) return false;
            String origin = new NativeHttpPolicy(context.getString(R.string.mobile_backend_origin)).origin();
            NativeSessionStore.Session session = new NativeSessionStore(context, origin).read();
            return session != null && session.userId.equals(saved.getString("userId", null))
                && digest(session.token).equals(saved.getString("sessionTag", null));
        } catch (Exception ignored) { return false; }
    }
    static synchronized boolean receive(Context context, Map<String, String> data) {
        NativePushPayload payload = NativePushPayload.parse(data);
        if (!allowed(context, payload)) return false;
        ActivityManager.RunningAppProcessInfo process = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(process);
        if (process.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) return true;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Сообщения сервера", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Письма администрации и напоминания об отметках");
            channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(channel);
        }
        Intent intent = new Intent(context, MainActivity.class).setAction("ru.zhiv.mochlik.REMOTE." + payload.eventId)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("google.message_id", payload.eventId).putExtra("source", "mochlik-remote")
            .putExtra("ownerPublicId", payload.owner).putExtra("target", payload.target).putExtra("eventId", payload.eventId);
        PendingIntent tap = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Bundle extra = new Bundle(); extra.putString("source", "mochlik-remote");
        Notification notification = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_mochlik).setContentTitle("Мохлик").setContentText(payload.body())
            .setContentIntent(tap).setAutoCancel(true).setGroup(CHANNEL).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_REMINDER).addExtras(extra).build();
        // clear() takes the same monitor, so logout cannot leave a late banner behind.
        manager.notify(CHANNEL + ":" + payload.eventId, 0, notification);
        return true;
    }
    static Intent cleanIntent(Context context, Intent intent) {
        if (intent == null || !intent.hasExtra("google.message_id")) return intent;
        Map<String, String> data = new HashMap<>();
        for (String key : new String[] { "source", "ownerPublicId", "target", "eventId" }) data.put(key, intent.getStringExtra(key));
        if (allowed(context, NativePushPayload.parse(data))) return intent;
        Intent clean = new Intent(intent);
        for (String key : new String[] { "google.message_id", "source", "ownerPublicId", "target", "eventId" }) clean.removeExtra(key);
        return clean;
    }
    private static String digest(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder output = new StringBuilder();
        for (byte item : bytes) output.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return output.toString();
    }
    private NativePushPolicy() {}
}
