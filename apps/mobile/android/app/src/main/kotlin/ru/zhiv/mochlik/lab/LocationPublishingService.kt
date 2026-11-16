package ru.zhiv.mochlik.lab

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import com.getcapacitor.JSObject
import java.nio.charset.StandardCharsets
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import java.util.function.Consumer
import kotlin.math.abs
import kotlin.math.floor
import org.json.JSONObject

/** Explicit location foreground service; never restarted from boot or without a visible launch. */
class LocationPublishingService : Service(), LocationListener {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val generation = AtomicLong()
    private var locations: LocationManager? = null
    private lateinit var policy: NativeHttpPolicy
    private lateinit var store: NativeSessionStore
    private var session: NativeSessionStore.Session? = null
    private var settings: JSONObject? = null
    private var owner: String? = null
    private var epoch: String? = null
    private var error: String? = null
    private var lastPublishedAt: String? = null

    @Volatile
    private var transfer: NativeHttpClient.Transfer? = null
    private var active = false
    private var sessionLost = false
    private var sequence = 0L
    private var started = 0L
    private var usedTimestamp = 0L
    private var lastAttempt = 0L
    private var deadline = 0L

    private val sessionChanged = Runnable {
        cancelAllLaunches()
        val stoppedGeneration = generation.incrementAndGet()
        cancelTransfer()
        main.post {
            if (generation.get() == stoppedGeneration) retire(null, lost = false)
        }
    }
    private val expiry = object : Runnable {
        override fun run() {
            if (!active) return
            when {
                !sameSession() -> retire("Сеанс завершён", lost = true)
                SystemClock.elapsedRealtime() >= deadline ->
                    retire("Срок обмена геопозицией истёк", lost = false)
                else -> main.postDelayed(this, 15_000)
            }
        }
    }

    private fun publish() {
        last = emptyState().apply {
            put("active", active)
            put("ownerPublicId", owner ?: JSONObject.NULL)
            put("epoch", epoch ?: JSONObject.NULL)
            put("lastPublishedAt", lastPublishedAt ?: JSONObject.NULL)
            put("error", error ?: JSONObject.NULL)
            put("sessionLost", sessionLost)
        }
        emit(this)
    }

    override fun onCreate() {
        super.onCreate()
        running = this
        locations = getSystemService(LOCATION_SERVICE) as LocationManager?
        policy = NativeHttpPolicy(getString(R.string.mobile_backend_origin))
        store = NativeSessionStore(this, policy.origin())
        NativeSessionEvents.add(sessionChanged)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val launch = requireNotNull(intent) { "Explicit settings required" }
            val encodedSettings = requireNotNull(launch.getStringExtra("settings")) {
                "Explicit settings required"
            }
            val next = JSONObject(encodedSettings)
            if (!launchAllowed(launch.getLongExtra("launchTicket", -1), next)) {
                if (!active) stopSelf()
                return START_NOT_STICKY
            }
            val current = store.read()
            require(current != null && eligible(next) && next.getString("ownerPublicId").matches(OWNER_PATTERN)) {
                "Invalid consent"
            }
            UUID.fromString(next.getString("publicationEpoch"))
            if (active && sameSession() && epoch == next.getString("publicationEpoch") &&
                owner == next.getString("ownerPublicId")
            ) {
                val previous = checkNotNull(settings)
                require(previous.optString("precision") == next.optString("precision") &&
                    previous.nullableString("sharingUntil") == next.nullableString("sharingUntil")
                ) { "Lease settings changed" }
                return START_NOT_STICKY
            }
            if (active) retire(null, lost = false, terminate = false)
            session = current
            settings = next
            owner = next.getString("ownerPublicId")
            epoch = next.getString("publicationEpoch")
            generation.incrementAndGet()
            started = System.currentTimeMillis()
            usedTimestamp = 0
            sequence = 0
            lastAttempt = Long.MIN_VALUE / 2
            deadline = if (next.isNull("sharingUntil")) {
                Long.MAX_VALUE
            } else {
                SystemClock.elapsedRealtime() + (
                    parseTime(next.getString("sharingUntil")) - parseTime(next.getString("serverTime")) - 1000
                ).coerceAtLeast(0)
            }
            active = true
            sessionLost = false
            error = null
            lastPublishedAt = null
            foreground()
            startLocations()
            main.post(expiry)
            publish()
        } catch (_: Exception) {
            retire("Не удалось начать передачу геопозиции", lost = false)
        }
        return START_NOT_STICKY
    }

    private fun foreground() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Передача геопозиции", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(
            this,
            NOTIFICATION,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val notification = builder
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Мохлик: геопозиция для близких")
            .setContentText("Передача включена. Выключить можно в настройках геопозиции.")
            .setContentIntent(pending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION, notification)
        }
    }

    @SuppressLint("MissingPermission")
    private fun startLocations() {
        if (!hasLocationPermission(this)) throw SecurityException("No location permission")
        val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val manager = checkNotNull(locations)
        var registered = false
        if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 15_000, 25f, this, Looper.getMainLooper())
            registered = true
        }
        if (fine && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 15_000, 25f, this, Looper.getMainLooper())
            registered = true
        }
        check(registered) { "Location services unavailable" }
    }

    private fun sameSession(): Boolean = try {
        val current = store.read()
        val expected = session
        current != null && expected != null && current.token == expected.token && current.userId == expected.userId
    } catch (_: Exception) {
        false
    }

    private fun cancelTransfer() {
        val current = transfer
        transfer = null
        current?.cancel()
    }

    private fun retire(reason: String?, lost: Boolean, terminate: Boolean = true) {
        val previous = settings
        val priorSession = session
        generation.incrementAndGet()
        active = false
        settings = null
        error = reason
        sessionLost = lost
        cancelTransfer()
        main.removeCallbacks(expiry)
        locations?.removeUpdates(this)
        publish()
        if (terminate) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        if (previous != null && priorSession != null && sameSession() && !worker.isShutdown) {
            worker.execute {
                try {
                    val body = JSONObject()
                        .put("expectedOwnerPublicId", previous.getString("ownerPublicId"))
                        .put("publicationEpoch", previous.getString("publicationEpoch"))
                    NativeHttpClient.execute(
                        policy.api("/api/v1/earth/location", true),
                        "DELETE",
                        jsonHeaders(),
                        body.toString().toByteArray(StandardCharsets.UTF_8),
                        priorSession.token,
                        NativeHttpClient.Transfer(),
                    )
                } catch (_: Exception) {
                    // Epoch-scoped stop cannot restore consent. No location retry queue.
                }
            }
        }
    }

    override fun onDestroy() {
        NativeSessionEvents.remove(sessionChanged)
        if (active) retire(null, lost = false)
        main.removeCallbacksAndMessages(null)
        cancelTransfer()
        worker.shutdown()
        if (running === this) running = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        retire(null, lost = false)
    }

    override fun onProviderDisabled(provider: String) {
        val manager = checkNotNull(locations)
        if (!manager.isProviderEnabled(LocationManager.GPS_PROVIDER) &&
            !manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        ) {
            retire("Геопозиция выключена", lost = false)
        }
    }

    override fun onProviderEnabled(provider: String) = Unit

    @Deprecated("Deprecated by the Android location API")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    private fun valid(location: Location): Boolean {
        val age = System.currentTimeMillis() - location.time
        val monotonicAge = (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000
        return location.time >= started && age in -10_000L..60_000L && monotonicAge in 0L..60_000L &&
            location.hasAccuracy() && location.accuracy >= 0 && location.accuracy <= 100_000 &&
            location.latitude.isFinite() && location.longitude.isFinite() &&
            abs(location.latitude) <= 90 && abs(location.longitude) <= 180
    }

    override fun onLocationChanged(location: Location) {
        if (!active || transfer != null || SystemClock.elapsedRealtime() - lastAttempt < 30_000) return
        if (!sameSession()) {
            retire("Сеанс завершён", lost = true)
            return
        }
        if (SystemClock.elapsedRealtime() >= deadline) {
            retire("Срок обмена геопозицией истёк", lost = false)
            return
        }
        if (!valid(location) || location.time <= usedTimestamp) return
        val currentGeneration = generation.get()
        val capturedDeadline = deadline
        val capturedSession = session ?: return
        val consent = settings ?: return
        val sampleSequence = ++sequence
        lastAttempt = SystemClock.elapsedRealtime()
        usedTimestamp = location.time
        val sample = Location(location)
        val task = NativeHttpClient.Transfer()
        transfer = task
        worker.execute {
            try {
                val readStarted = SystemClock.elapsedRealtime()
                val read = NativeHttpClient.execute(
                    policy.api("/api/v1/earth/sharing", true),
                    "GET",
                    mapOf("Accept" to "application/json"),
                    null,
                    capturedSession.token,
                    task,
                )
                checkResponse(read, capturedSession)
                val fresh = JSONObject(String(read.body, StandardCharsets.UTF_8))
                val serverTime = parseTime(fresh.getString("serverTime"))
                val checkedDeadline = if (fresh.isNull("sharingUntil")) {
                    capturedDeadline
                } else {
                    minOf(
                        capturedDeadline,
                        SystemClock.elapsedRealtime() + (
                            parseTime(fresh.getString("sharingUntil")) - serverTime -
                                (SystemClock.elapsedRealtime() - readStarted) - 1000
                        ).coerceAtLeast(0),
                    )
                }
                if (!eligible(fresh) || fresh.getString("ownerPublicId") != consent.getString("ownerPublicId") ||
                    fresh.getString("precision") != consent.getString("precision") ||
                    fresh.nullableString("sharingUntil") != consent.nullableString("sharingUntil")
                ) {
                    throw EndPublication("Обмен остановлен настройками доступа")
                }
                if (generation.get() != currentGeneration || !sameSession() || !valid(sample) ||
                    SystemClock.elapsedRealtime() >= checkedDeadline
                ) return@execute
                main.post {
                    if (generation.get() == currentGeneration) deadline = minOf(deadline, checkedDeadline)
                }
                val approximate = consent.getString("precision") == "APPROXIMATE"
                val body = JSONObject()
                    .put("expectedOwnerPublicId", consent.getString("ownerPublicId"))
                    .put("publicationEpoch", consent.getString("publicationEpoch"))
                    .put("sequence", sampleSequence)
                    .put("latitude", if (approximate) floor(sample.latitude * 100 + .5) / 100 else sample.latitude)
                    .put("longitude", if (approximate) floor(sample.longitude * 100 + .5) / 100 else sample.longitude)
                    .put("accuracyMeters", (if (approximate) sample.accuracy.coerceAtLeast(1500f) else sample.accuracy).toDouble())
                    .put("capturedAt", iso(sample.time))
                val written = NativeHttpClient.execute(
                    policy.api("/api/v1/earth/location", true),
                    "PUT",
                    jsonHeaders(),
                    body.toString().toByteArray(StandardCharsets.UTF_8),
                    capturedSession.token,
                    task,
                )
                checkResponse(written, capturedSession)
                val receipt = JSONObject(String(written.body, StandardCharsets.UTF_8))
                if (receipt.getString("ownerPublicId") != consent.getString("ownerPublicId")) {
                    throw EndPublication("Неверный владелец ответа")
                }
                val accepted = receipt.getString("acceptedAt")
                parseTime(accepted)
                main.post {
                    if (generation.get() == currentGeneration) {
                        usedTimestamp = sample.time
                        lastPublishedAt = accepted
                        error = null
                        publish()
                    }
                }
            } catch (problem: EndPublication) {
                main.post {
                    if (generation.get() == currentGeneration) retire(problem.message, lost = false)
                }
            } catch (_: Exception) {
                main.post {
                    if (generation.get() == currentGeneration) {
                        error = "Нет связи: новые координаты пока не отправлены"
                        publish()
                    }
                }
            } finally {
                main.post {
                    if (generation.get() == currentGeneration && transfer === task) transfer = null
                }
            }
        }
    }

    private fun checkResponse(response: NativeHttpClient.Response, expected: NativeSessionStore.Session) {
        if (response.status == 401) {
            try {
                store.clearIfToken(expected.token)
            } catch (_: Exception) {
                // A failed disk cleanup must not preserve the active credential or publisher.
            } finally {
                NativeSessionEvents.invalidate(expected.token)
            }
            throw EndPublication("Сеанс завершён")
        }
        if (response.status == 403 || response.status == 409) {
            throw EndPublication("Право передачи геопозиции изменилось")
        }
        check(response.status in 200..299 && response.body.size <= 65_536) { "Request failed" }
    }

    private class EndPublication(message: String) : Exception(message)

    companion object {
        private const val CHANNEL = "mochlik.location"
        private const val NOTIFICATION = 7401
        private val OWNER_PATTERN = Regex("[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}")
        private val TIMESTAMP_PATTERN = Regex("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z")
        private val listeners = CopyOnWriteArraySet<Consumer<JSObject>>()

        @Volatile
        private var running: LocationPublishingService? = null

        @Volatile
        private var last = emptyState()
        private var launchTicket = 0L
        private var launchOwner: String? = null
        private var launchEpoch: String? = null

        @Synchronized
        fun authorizeLaunch(settings: JSONObject): Long {
            launchOwner = settings.getString("ownerPublicId")
            launchEpoch = settings.getString("publicationEpoch")
            return ++launchTicket
        }

        @Synchronized
        private fun launchAllowed(ticket: Long, settings: JSONObject): Boolean =
            ticket == launchTicket && launchOwner == settings.nullableString("ownerPublicId") &&
                launchEpoch == settings.nullableString("publicationEpoch")

        private fun JSONObject.nullableString(key: String): String? =
            if (isNull(key)) null else optString(key)

        @Synchronized
        private fun cancelLaunch(owner: String?, epoch: String?) {
            if (owner == null || epoch == null || owner != launchOwner || epoch != launchEpoch) return
            launchTicket++
            launchOwner = null
            launchEpoch = null
        }

        @Synchronized
        fun cancelAllLaunches() {
            launchTicket++
            launchOwner = null
            launchEpoch = null
        }

        fun addListener(listener: Consumer<JSObject>) {
            listeners.add(listener)
        }

        fun removeListener(listener: Consumer<JSObject>) {
            listeners.remove(listener)
        }

        private fun emptyState() = JSObject().apply {
            put("active", false)
            put("backgroundEnabled", false)
            put("ownerPublicId", JSONObject.NULL)
            put("epoch", JSONObject.NULL)
            put("lastPublishedAt", JSONObject.NULL)
            put("error", JSONObject.NULL)
            put("sessionLost", false)
        }

        fun snapshot(context: Context): JSObject {
            val value = try {
                JSObject(last.toString())
            } catch (_: Exception) {
                emptyState()
            }
            value.put("backgroundEnabled", backgroundEnabled(context))
            return value
        }

        fun backgroundEnabled(context: Context): Boolean = try {
            val policy = NativeHttpPolicy(context.getString(R.string.mobile_backend_origin))
            val session = NativeSessionStore(context, policy.origin()).read()
            session != null && context.getSharedPreferences("mochlik.location.v1", MODE_PRIVATE)
                .getBoolean("background:${session.userId}", false)
        } catch (_: Exception) {
            false
        }

        fun setBackgroundEnabled(context: Context, enabled: Boolean) {
            val policy = NativeHttpPolicy(context.getString(R.string.mobile_backend_origin))
            val session = checkNotNull(NativeSessionStore(context, policy.origin()).read()) { "No session" }
            check(
                context.getSharedPreferences("mochlik.location.v1", MODE_PRIVATE)
                    .edit().putBoolean("background:${session.userId}", enabled).commit(),
            ) { "Storage failed" }
            emit(context)
        }

        fun stop(context: Context, expectedOwner: String?, expectedEpoch: String?) {
            cancelLaunch(expectedOwner, expectedEpoch)
            val current = running
            if (current != null && current.owner == expectedOwner && current.epoch == expectedEpoch) {
                current.retire(null, lost = false)
            }
        }

        fun pause(context: Context) {
            val current = running
            if (current != null && !backgroundEnabled(context)) current.retire(null, lost = false)
        }

        private fun emit(context: Context) {
            val value = snapshot(context)
            for (listener in listeners) listener.accept(value)
        }

        fun hasLocationPermission(context: Context): Boolean =
            context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

        private fun jsonHeaders(): Map<String, String> = mapOf(
            "Accept" to "application/json",
            "Content-Type" to "application/json",
            "Idempotency-Key" to UUID.randomUUID().toString(),
        )

        private fun eligible(value: JSONObject): Boolean {
            if (value.getString("mode") != "SHARING" || value.getString("precision") !in setOf("PRECISE", "APPROXIMATE")) {
                return false
            }
            val recipients = value.getJSONArray("recipientCircleIds")
            val frozen = value.getJSONArray("frozenCircleIds")
            val frozenSet = (0 until frozen.length()).mapTo(mutableSetOf()) { frozen.getString(it) }
            return (0 until recipients.length()).any { recipients.getString(it) !in frozenSet }
        }

        private fun parseTime(value: String?): Long {
            require(value != null && TIMESTAMP_PATTERN.matches(value)) { "Invalid timestamp" }
            val normalized = value.substring(0, 19) + "Z"
            val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT).apply {
                timeZone = TimeZone.getTimeZone("UTC")
                isLenient = false
            }
            val position = ParsePosition(0)
            val date = format.parse(normalized, position)
            require(date != null && position.index == normalized.length) { "Invalid timestamp" }
            return date.time
        }

        private fun iso(timestamp: Long): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.format(Date(timestamp))
    }
}
