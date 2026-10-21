package ru.zhiv.observability

import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.hooks.ResponseSent
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import io.ktor.util.AttributeKey
import kotlinx.serialization.Serializable
import java.time.Instant
import java.util.UUID

/** Filled only by the existing server-side session lookup, never from request fields. */
val trafficUserId = AttributeKey<UUID>("zhiv.traffic-user")
private val trafficRecorded = AttributeKey<Boolean>("zhiv.traffic-recorded")

@Serializable
data class RequestTrafficSignal(
    val publicId: String?, val displayName: String?, val operation: String, val method: String,
    val windowStartedAt: String, val lastAt: String, val requests: Int, val denied: Int,
    val throttled: Int, val serverErrors: Int, val reasons: List<String>,
)
@Serializable
data class RequestTrafficSnapshot(
    val actorPublicId: String, val serverTime: String, val startedAt: String,
    val retentionSeconds: Int, val capacity: Int, val evicted: Long, val signals: List<RequestTrafficSignal>,
)
data class TrafficPlayer(val id: UUID, val publicId: String, val displayName: String)
data class TrafficSample(val userId: UUID?, val signal: RequestTrafficSignal)

/** Observation only. No network, database, IP addresses, payloads or gameplay decisions.
 * Bounded memory and constant work per response; samples expire after 15 minutes.
 * Fixed minute windows are diagnostic hints, not proof of malicious intent. */
class RequestTraffic(private val clock: () -> Long = System::currentTimeMillis, val capacity: Int = 4096) {
    private data class Key(val userId: UUID?, val operation: String, val method: String)
    private data class Bucket(var minute: Long, var lastAt: Long, var requests: Int = 0,
        var denied: Int = 0, var throttled: Int = 0, var serverErrors: Int = 0,
        var signal: RequestTrafficSignal? = null, var signalAt: Long = 0)
    val startedAt: String = Instant.ofEpochMilli(clock()).toString()
    private val buckets = LinkedHashMap<Key, Bucket>(128, .75f, true)
    private var evictions = 0L
    init { require(capacity in 1..4096) }

    @Synchronized
    fun record(userId: UUID?, method: String, path: String, status: Int) {
        if (!path.startsWith("/api/v1/") || status !in 100..599) return
        if (path.startsWith("/api/v1/admin/") && status != 401 && status != 403) return
        val now = clock()
        val key = Key(userId, diagnosticOperation(path), method.takeIf { it in METHODS } ?: "OTHER")
        val minute = Math.floorDiv(now, 60_000)
        val bucket = buckets[key] ?: Bucket(minute, now).also {
            if (buckets.size >= capacity) {
                buckets.entries.iterator().run { next(); remove() }
                evictions++
            }
            buckets[key] = it
        }
        if (now - bucket.lastAt >= RETENTION_SECONDS * 1000L) bucket.signal = null
        if (bucket.minute != minute) {
            bucket.minute = minute; bucket.requests = 0; bucket.denied = 0; bucket.throttled = 0; bucket.serverErrors = 0
        }
        bucket.lastAt = now
        bucket.requests = increment(bucket.requests)
        if (status == 401 || status == 403) bucket.denied = increment(bucket.denied)
        if (status == 429) bucket.throttled = increment(bucket.throttled)
        if (status >= 500) bucket.serverErrors = increment(bucket.serverErrors)
        val reasons = buildList {
            if (bucket.requests >= 120) add("REQUEST_BURST")
            if (bucket.denied >= 20) add("ACCESS_DENIED_BURST")
            if (bucket.throttled >= 20) add("THROTTLED_BURST")
        }
        if (reasons.isNotEmpty()) {
            bucket.signalAt = now
            bucket.signal = RequestTrafficSignal(null, null, key.operation, key.method,
            Instant.ofEpochMilli(minute * 60_000).toString(), Instant.ofEpochMilli(now).toString(),
            bucket.requests, bucket.denied, bucket.throttled, bucket.serverErrors, reasons)
        }
    }

    fun samples(): List<TrafficSample> {
        val now = clock()
        val copy = synchronized(this) {
            buckets.entries.removeIf { now - it.value.lastAt >= RETENTION_SECONDS * 1000L }
            buckets.entries.mapNotNull { (key, bucket) -> bucket.signal?.takeIf {
                now - bucket.signalAt < RETENTION_SECONDS * 1000L
            }?.let { bucket.signalAt to TrafficSample(key.userId, it) } }
        }
        // Sorting/formatting a private admin snapshot never holds the response counter lock.
        return copy.sortedByDescending { it.first }.take(100).map { it.second }
    }

    @Synchronized fun evicted(): Long = evictions
    @Synchronized fun tracked(): Int = buckets.size
    companion object {
        const val RETENTION_SECONDS = 900
        private val METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
        private fun increment(value: Int) = if (value == Int.MAX_VALUE) value else value + 1
    }
}

class RequestTrafficConfig { lateinit var traffic: RequestTraffic }
val RequestTrafficObservation = createApplicationPlugin("RequestTrafficObservation", ::RequestTrafficConfig) {
    val traffic = pluginConfig.traffic
    on(ResponseSent) { call ->
        if (call.attributes.getOrNull(trafficRecorded) != true) {
            call.attributes.put(trafficRecorded, true)
            traffic.record(call.attributes.getOrNull(trafficUserId), call.request.httpMethod.value,
                call.request.path(), call.response.status()?.value ?: 200)
        }
    }
}
