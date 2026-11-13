package ru.zhiv.mochlik.lab;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import java.nio.charset.StandardCharsets;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/** Explicit location foreground service; never restarted from boot or without a visible launch. */
public final class LocationPublishingService extends Service implements LocationListener {
    private static final String CHANNEL = "mochlik.location";
    private static final int NOTIFICATION = 7401;
    private static final CopyOnWriteArraySet<Consumer<JSObject>> LISTENERS = new CopyOnWriteArraySet<>();
    private static volatile LocationPublishingService running;
    private static volatile JSObject last = emptyState();
    private static long launchTicket;
    private static String launchOwner, launchEpoch;
    static synchronized long authorizeLaunch(JSONObject settings) throws Exception {
        launchOwner = settings.getString("ownerPublicId"); launchEpoch = settings.getString("publicationEpoch");
        return ++launchTicket;
    }
    private static synchronized boolean launchAllowed(long ticket, JSONObject settings) {
        return ticket == launchTicket && Objects.equals(launchOwner, settings.optString("ownerPublicId", null)) && Objects.equals(launchEpoch, settings.optString("publicationEpoch", null));
    }
    private static synchronized void cancelLaunch(String owner, String epoch) {
        if (owner == null || epoch == null || !Objects.equals(owner, launchOwner) || !Objects.equals(epoch, launchEpoch)) return;
        launchTicket++; launchOwner = launchEpoch = null;
    }
    static synchronized void cancelAllLaunches() { launchTicket++; launchOwner = launchEpoch = null; }
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong generation = new AtomicLong();
    private LocationManager locations;
    private NativeHttpPolicy policy;
    private NativeSessionStore store;
    private NativeSessionStore.Session session;
    private JSONObject settings;
    private String owner, epoch, error, lastPublishedAt;
    private volatile NativeHttpClient.Transfer transfer;
    private boolean active, sessionLost;
    private long sequence, started, usedTimestamp, lastAttempt;
    private long deadline;
    private final Runnable sessionChanged = () -> {
        cancelAllLaunches(); long stoppedGeneration = generation.incrementAndGet(); cancelTransfer();
        main.post(() -> { if (generation.get() == stoppedGeneration) retire(null, false); });
    };
    private final Runnable expiry = new Runnable() {
        @Override public void run() {
            if (!active) return;
            if (!sameSession()) retire("Сеанс завершён", true);
            else if (SystemClock.elapsedRealtime() >= deadline) retire("Срок обмена геопозицией истёк", false);
            else main.postDelayed(this, 15000);
        }
    };

    static void addListener(Consumer<JSObject> listener) { LISTENERS.add(listener); }
    static void removeListener(Consumer<JSObject> listener) { LISTENERS.remove(listener); }
    private static JSObject emptyState() {
        JSObject value = new JSObject(); value.put("active", false); value.put("backgroundEnabled", false);
        value.put("ownerPublicId", JSONObject.NULL); value.put("epoch", JSONObject.NULL);
        value.put("lastPublishedAt", JSONObject.NULL); value.put("error", JSONObject.NULL); value.put("sessionLost", false);
        return value;
    }
    static JSObject snapshot(Context context) {
        JSObject value;
        try { value = new JSObject(last.toString()); } catch (Exception error) { value = emptyState(); }
        value.put("backgroundEnabled", backgroundEnabled(context)); return value;
    }
    static boolean backgroundEnabled(Context context) {
        try {
            NativeHttpPolicy policy = new NativeHttpPolicy(context.getString(R.string.mobile_backend_origin));
            NativeSessionStore.Session session = new NativeSessionStore(context, policy.origin()).read();
            return session != null && context.getSharedPreferences("mochlik.location.v1", MODE_PRIVATE).getBoolean("background:" + session.userId, false);
        } catch (Exception error) { return false; }
    }
    static void setBackgroundEnabled(Context context, boolean enabled) throws Exception {
        NativeHttpPolicy policy = new NativeHttpPolicy(context.getString(R.string.mobile_backend_origin));
        NativeSessionStore.Session session = new NativeSessionStore(context, policy.origin()).read();
        if (session == null) throw new IllegalStateException("No session");
        if (!context.getSharedPreferences("mochlik.location.v1", MODE_PRIVATE).edit().putBoolean("background:" + session.userId, enabled).commit()) throw new IllegalStateException("Storage failed");
        emit(context);
    }
    static void stop(Context context, String expectedOwner, String expectedEpoch) {
        cancelLaunch(expectedOwner, expectedEpoch);
        LocationPublishingService current = running;
        if (current != null && Objects.equals(current.owner, expectedOwner) && Objects.equals(current.epoch, expectedEpoch)) current.retire(null, false);
    }
    static void pause(Context context) {
        LocationPublishingService current = running;
        if (current != null && !backgroundEnabled(context)) current.retire(null, false);
    }
    private static void emit(Context context) {
        JSObject value = snapshot(context);
        for (Consumer<JSObject> listener : LISTENERS) listener.accept(value);
    }
    private void publish() {
        JSObject value = emptyState(); value.put("active", active); value.put("ownerPublicId", owner == null ? JSONObject.NULL : owner);
        value.put("epoch", epoch == null ? JSONObject.NULL : epoch); value.put("lastPublishedAt", lastPublishedAt == null ? JSONObject.NULL : lastPublishedAt);
        value.put("error", error == null ? JSONObject.NULL : error); value.put("sessionLost", sessionLost);
        last = value; emit(this);
    }

    @Override public void onCreate() {
        super.onCreate(); running = this;
        locations = (LocationManager) getSystemService(LOCATION_SERVICE);
        policy = new NativeHttpPolicy(getString(R.string.mobile_backend_origin)); store = new NativeSessionStore(this, policy.origin());
        NativeSessionEvents.add(sessionChanged);
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            if (intent == null || intent.getStringExtra("settings") == null) throw new IllegalArgumentException("Explicit settings required");
            JSONObject next = new JSONObject(intent.getStringExtra("settings"));
            if (!launchAllowed(intent.getLongExtra("launchTicket", -1), next)) { if (!active) stopSelf(); return START_NOT_STICKY; }
            NativeSessionStore.Session current = store.read();
            if (current == null || !eligible(next) || !next.getString("ownerPublicId").matches("[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}")) throw new IllegalArgumentException("Invalid consent");
            UUID.fromString(next.getString("publicationEpoch"));
            if (active && sameSession() && Objects.equals(epoch, next.getString("publicationEpoch")) && Objects.equals(owner, next.getString("ownerPublicId"))) {
                if (!Objects.equals(settings.optString("precision"), next.optString("precision")) || !Objects.equals(settings.optString("sharingUntil", null), next.optString("sharingUntil", null))) throw new IllegalArgumentException("Lease settings changed");
                return START_NOT_STICKY;
            }
            if (active) retire(null, false, false);
            session = current; settings = next; owner = next.getString("ownerPublicId"); epoch = next.getString("publicationEpoch");
            generation.incrementAndGet(); started = System.currentTimeMillis(); usedTimestamp = 0; sequence = 0; lastAttempt = Long.MIN_VALUE / 2;
            deadline = next.isNull("sharingUntil") ? Long.MAX_VALUE : SystemClock.elapsedRealtime() + Math.max(0, parseTime(next.getString("sharingUntil")) - parseTime(next.getString("serverTime")) - 1000);
            active = true; sessionLost = false; error = null; lastPublishedAt = null;
            foreground(); startLocations(); main.post(expiry); publish();
        } catch (Exception problem) { retire("Не удалось начать передачу геопозиции", false); }
        return START_NOT_STICKY;
    }
    private void foreground() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Передача геопозиции", NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification notification = builder.setSmallIcon(android.R.drawable.ic_menu_mylocation).setContentTitle("Мохлик: геопозиция для близких")
            .setContentText("Передача включена. Выключить можно в настройках геопозиции.").setContentIntent(pending).setOngoing(true).setOnlyAlertOnce(true).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTIFICATION, notification);
    }
    static boolean hasLocationPermission(Context context) {
        return context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED || context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    @SuppressLint("MissingPermission")
    private void startLocations() {
        if (!hasLocationPermission(this)) throw new SecurityException("No location permission");
        boolean fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean registered = false;
        if (locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) { locations.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 15000, 25, this, Looper.getMainLooper()); registered = true; }
        if (fine && locations.isProviderEnabled(LocationManager.GPS_PROVIDER)) { locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 15000, 25, this, Looper.getMainLooper()); registered = true; }
        if (!registered) throw new IllegalStateException("Location services unavailable");
    }
    private boolean sameSession() {
        try { NativeSessionStore.Session current = store.read(); return current != null && session != null && current.token.equals(session.token) && current.userId.equals(session.userId); }
        catch (Exception error) { return false; }
    }
    private void cancelTransfer() { NativeHttpClient.Transfer current = transfer; transfer = null; if (current != null) current.cancel(); }
    private void retire(String reason, boolean lost) { retire(reason, lost, true); }
    private void retire(String reason, boolean lost, boolean terminate) {
        JSONObject previous = settings; NativeSessionStore.Session priorSession = session;
        generation.incrementAndGet(); active = false; settings = null; error = reason; sessionLost = lost;
        cancelTransfer(); main.removeCallbacks(expiry);
        if (locations != null) locations.removeUpdates(this);
        publish(); if (terminate) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); }
        if (previous != null && priorSession != null && sameSession() && !worker.isShutdown()) worker.execute(() -> {
            try {
                JSONObject body = new JSONObject().put("expectedOwnerPublicId", previous.getString("ownerPublicId")).put("publicationEpoch", previous.getString("publicationEpoch"));
                NativeHttpClient.execute(policy.api("/api/v1/earth/location", true), "DELETE", jsonHeaders(), body.toString().getBytes(StandardCharsets.UTF_8), priorSession.token, new NativeHttpClient.Transfer());
            } catch (Exception ignored) { /* Epoch-scoped stop cannot restore consent. No location retry queue. */ }
        });
    }
    @Override public void onDestroy() {
        NativeSessionEvents.remove(sessionChanged);
        if (active) retire(null, false);
        main.removeCallbacksAndMessages(null); cancelTransfer(); worker.shutdown(); if (running == this) running = null;
        super.onDestroy();
    }
    @Override public void onTaskRemoved(Intent rootIntent) { retire(null, false); }
    @Override public void onProviderDisabled(String provider) { if (!locations.isProviderEnabled(LocationManager.GPS_PROVIDER) && !locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) retire("Геопозиция выключена", false); }
    @Override public void onProviderEnabled(String provider) {}
    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}

    private boolean valid(Location location) {
        long age = System.currentTimeMillis() - location.getTime();
        long monotonicAge = (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos()) / 1000000;
        return location.getTime() >= started && age >= -10000 && age <= 60000 && monotonicAge >= 0 && monotonicAge <= 60000 &&
            location.hasAccuracy() && location.getAccuracy() >= 0 && location.getAccuracy() <= 100000 && Double.isFinite(location.getLatitude()) && Double.isFinite(location.getLongitude()) && Math.abs(location.getLatitude()) <= 90 && Math.abs(location.getLongitude()) <= 180;
    }
    @Override public void onLocationChanged(Location location) {
        if (!active || transfer != null || SystemClock.elapsedRealtime() - lastAttempt < 30000) return;
        if (!sameSession()) { retire("Сеанс завершён", true); return; }
        if (SystemClock.elapsedRealtime() >= deadline) { retire("Срок обмена геопозицией истёк", false); return; }
        if (!valid(location) || location.getTime() <= usedTimestamp) return;
        long currentGeneration = generation.get(), capturedDeadline = deadline; NativeSessionStore.Session capturedSession = session; JSONObject consent = settings;
        long sampleSequence = ++sequence; lastAttempt = SystemClock.elapsedRealtime(); usedTimestamp = location.getTime();
        Location sample = new Location(location); NativeHttpClient.Transfer task = new NativeHttpClient.Transfer(); transfer = task;
        worker.execute(() -> {
            try {
                long readStarted = SystemClock.elapsedRealtime();
                NativeHttpClient.Response read = NativeHttpClient.execute(policy.api("/api/v1/earth/sharing", true), "GET", Collections.singletonMap("Accept", "application/json"), null, capturedSession.token, task);
                checkResponse(read, capturedSession);
                JSONObject fresh = new JSONObject(new String(read.body, StandardCharsets.UTF_8));
                long serverTime = parseTime(fresh.getString("serverTime"));
                long checkedDeadline = fresh.isNull("sharingUntil") ? capturedDeadline : Math.min(capturedDeadline, SystemClock.elapsedRealtime() + Math.max(0,
                    parseTime(fresh.getString("sharingUntil")) - serverTime - (SystemClock.elapsedRealtime() - readStarted) - 1000));
                if (!eligible(fresh) || !fresh.getString("ownerPublicId").equals(consent.getString("ownerPublicId")) || !fresh.getString("precision").equals(consent.getString("precision")) ||
                    !Objects.equals(fresh.optString("sharingUntil", null), consent.optString("sharingUntil", null))) throw new EndPublication("Обмен остановлен настройками доступа");
                if (generation.get() != currentGeneration || !sameSession() || !valid(sample) || SystemClock.elapsedRealtime() >= checkedDeadline) return;
                main.post(() -> { if (generation.get() == currentGeneration) deadline = Math.min(deadline, checkedDeadline); });
                boolean approximate = "APPROXIMATE".equals(consent.getString("precision"));
                JSONObject body = new JSONObject().put("expectedOwnerPublicId", consent.getString("ownerPublicId")).put("publicationEpoch", consent.getString("publicationEpoch"))
                    .put("sequence", sampleSequence).put("latitude", approximate ? Math.floor(sample.getLatitude() * 100 + .5) / 100 : sample.getLatitude())
                    .put("longitude", approximate ? Math.floor(sample.getLongitude() * 100 + .5) / 100 : sample.getLongitude())
                    .put("accuracyMeters", approximate ? Math.max(1500, sample.getAccuracy()) : sample.getAccuracy()).put("capturedAt", iso(sample.getTime()));
                NativeHttpClient.Response written = NativeHttpClient.execute(policy.api("/api/v1/earth/location", true), "PUT", jsonHeaders(), body.toString().getBytes(StandardCharsets.UTF_8), capturedSession.token, task);
                checkResponse(written, capturedSession);
                JSONObject receipt = new JSONObject(new String(written.body, StandardCharsets.UTF_8));
                if (!receipt.getString("ownerPublicId").equals(consent.getString("ownerPublicId"))) throw new EndPublication("Неверный владелец ответа");
                String accepted = receipt.getString("acceptedAt"); parseTime(accepted);
                main.post(() -> { if (generation.get() == currentGeneration) { usedTimestamp = sample.getTime(); lastPublishedAt = accepted; error = null; publish(); } });
            } catch (EndPublication problem) { main.post(() -> { if (generation.get() == currentGeneration) retire(problem.getMessage(), false); }); }
            catch (Exception problem) { main.post(() -> { if (generation.get() == currentGeneration) { error = "Нет связи: новые координаты пока не отправлены"; publish(); } }); }
            finally { main.post(() -> { if (generation.get() == currentGeneration && transfer == task) transfer = null; }); }
        });
    }
    private void checkResponse(NativeHttpClient.Response response, NativeSessionStore.Session expected) throws Exception {
        if (response.status == 401) {
            try { store.clearIfToken(expected.token); }
            catch (Exception ignored) { /* A failed disk cleanup must not preserve the active credential or publisher. */ }
            finally { NativeSessionEvents.invalidate(expected.token); }
            throw new EndPublication("Сеанс завершён");
        }
        if (response.status == 403 || response.status == 409) throw new EndPublication("Право передачи геопозиции изменилось");
        if (response.status < 200 || response.status >= 300 || response.body.length > 65536) throw new IllegalStateException("Request failed");
    }
    private static Map<String, String> jsonHeaders() {
        Map<String, String> headers = new HashMap<>(); headers.put("Accept", "application/json"); headers.put("Content-Type", "application/json"); headers.put("Idempotency-Key", UUID.randomUUID().toString()); return headers;
    }
    private static boolean eligible(JSONObject value) throws Exception {
        if (!"SHARING".equals(value.getString("mode")) || !Arrays.asList("PRECISE", "APPROXIMATE").contains(value.getString("precision"))) return false;
        JSONArray recipients = value.getJSONArray("recipientCircleIds"), frozen = value.getJSONArray("frozenCircleIds"); Set<String> frozenSet = new HashSet<>();
        for (int index = 0; index < frozen.length(); index++) frozenSet.add(frozen.getString(index));
        for (int index = 0; index < recipients.length(); index++) if (!frozenSet.contains(recipients.getString(index))) return true;
        return false;
    }
    private static long parseTime(String value) {
        if (value == null || !value.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z")) throw new IllegalArgumentException("Invalid timestamp");
        String normalized = value.substring(0, 19) + "Z"; SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC")); format.setLenient(false); ParsePosition position = new ParsePosition(0); Date date = format.parse(normalized, position);
        if (date == null || position.getIndex() != normalized.length()) throw new IllegalArgumentException("Invalid timestamp"); return date.getTime();
    }
    private static String iso(long timestamp) { SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT); format.setTimeZone(TimeZone.getTimeZone("UTC")); return format.format(new Date(timestamp)); }
    private static final class EndPublication extends Exception { EndPublication(String message) { super(message); } }
}
