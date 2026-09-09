package ru.zhiv.observability

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.Flow
import java.util.concurrent.TimeUnit

@Serializable
data class MonitoringSummary(
    val cpuPercent: Double? = null,
    val memoryUsedBytes: Double? = null,
    val memoryTotalBytes: Double? = null,
    val load1: Double? = null,
    val diskUsedBytes: Double? = null,
    val diskTotalBytes: Double? = null,
    val requestRate: Double? = null,
    val errorRate: Double? = null,
    val throttledRate: Double? = null,
    val p95LatencyMs: Double? = null,
    val gameAcceptedRate: Double? = null,
    val gameRejectedRate: Double? = null,
    val apiUptimeSeconds: Double? = null,
    val jvmHeapUsedBytes: Double? = null,
    val jvmHeapMaxBytes: Double? = null,
)

@Serializable
data class MonitoringSample(
    val at: String,
    val cpuPercent: Double? = null,
    val memoryPercent: Double? = null,
    val requestRate: Double? = null,
    val errorRate: Double? = null,
    val throttledRate: Double? = null,
    val p95LatencyMs: Double? = null,
)

@Serializable
data class MonitoringHealth(val name: String, val status: String)

@Serializable
data class MonitoringAlert(val name: String, val severity: String, val state: String, val summary: String, val activeAt: String? = null)

@Serializable
data class MonitoringSnapshot(
    val serverTime: String,
    val configured: Boolean,
    val available: Boolean,
    val error: String? = null,
    val rangeMinutes: Int = 60,
    val summary: MonitoringSummary = MonitoringSummary(),
    val samples: List<MonitoringSample> = emptyList(),
    val health: List<MonitoringHealth> = emptyList(),
    val alerts: List<MonitoringAlert> = emptyList(),
)

fun interface MonitoringTransport { fun read(uri: URI): String }

/** Only the operator configures the endpoint. No URL, PromQL, range or label comes from an HTTP caller. */
class MonitoringService(
    baseUrl: String?,
    private val clock: Clock = Clock.systemUTC(),
    private val transport: MonitoringTransport = HttpMonitoringTransport(),
) {
    private val configured = !baseUrl.isNullOrBlank()
    private val base = parseMonitoringBase(baseUrl)
    private val mutex = Mutex()
    private val cached = mutableMapOf<Int, Pair<Long, MonitoringSnapshot>>()

    suspend fun snapshot(rangeMinutes: Int = 60): MonitoringSnapshot = mutex.withLock {
        require(rangeMinutes in MONITORING_RANGES)
        cached[rangeMinutes]?.takeIf { System.nanoTime() - it.first < 10_000_000_000L }?.let { return@withLock it.second }
        val now = clock.instant()
        val response = if (base == null) {
            unavailable(now, if (configured) "MONITORING_CONFIGURATION_INVALID" else "MONITORING_DISABLED")
        } else {
            load(now, rangeMinutes)
        }
        val result = response.copy(rangeMinutes = rangeMinutes)
        cached[rangeMinutes] = System.nanoTime() to result
        result
    }

    private suspend fun load(now: Instant, rangeMinutes: Int): MonitoringSnapshot = coroutineScope {
        val end = now.epochSecond / 60 * 60
        val start = end - rangeMinutes * 60L
        val step = MONITORING_RANGES.getValue(rangeMinutes)
        val summaryRequest = async(Dispatchers.IO) { readObject("query", mapOf("query" to SUMMARY_QUERY, "time" to now.epochSecond.toString(), "timeout" to "2s")) }
        val rangeRequest = async(Dispatchers.IO) { readObject("query_range", mapOf("query" to HISTORY_QUERY.replace("[2m]", "[${maxOf(120L, step)}s]").replace("[5m]", "[${maxOf(300L, step)}s]"), "start" to start.toString(), "end" to end.toString(), "step" to step.toString(), "timeout" to "2s")) }
        val alertRequest = async(Dispatchers.IO) { readObject("alerts", emptyMap()) }
        val summaryResponse = summaryRequest.await()
        val rangeResponse = rangeRequest.await()
        val alertResponse = alertRequest.await()
        if (summaryResponse == null && rangeResponse == null && alertResponse == null) return@coroutineScope unavailable(now, "MONITORING_UNAVAILABLE")
        val values = summaryResponse?.let(::parseMonitoringVector).orEmpty()
        fun value(name: String): Double? = values[name]
        fun health(name: String): String = when (values[name]) { 1.0 -> "up"; 0.0 -> "down"; else -> "unknown" }
        MonitoringSnapshot(
            serverTime = now.toString(), configured = true, available = true,
            error = if (summaryResponse == null || rangeResponse == null || alertResponse == null) "MONITORING_PARTIAL" else null,
            summary = MonitoringSummary(
                cpuPercent = value("cpuPercent"), memoryUsedBytes = value("memoryUsedBytes"), memoryTotalBytes = value("memoryTotalBytes"),
                load1 = value("load1"), diskUsedBytes = value("diskUsedBytes"), diskTotalBytes = value("diskTotalBytes"),
                requestRate = value("requestRate"), errorRate = value("errorRate"), throttledRate = value("throttledRate"), p95LatencyMs = value("p95LatencyMs"),
                gameAcceptedRate = value("gameAcceptedRate"), gameRejectedRate = value("gameRejectedRate"),
                apiUptimeSeconds = value("apiUptimeSeconds"), jvmHeapUsedBytes = value("jvmHeapUsedBytes"), jvmHeapMaxBytes = value("jvmHeapMaxBytes"),
            ),
            samples = rangeResponse?.let { parseMonitoringMatrix(it, start, end, step) }.orEmpty(),
            health = listOf(MonitoringHealth("prometheus", "up"), MonitoringHealth("api", health("apiUp")), MonitoringHealth("node", health("nodeUp"))),
            alerts = alertResponse?.let(::parseMonitoringAlerts).orEmpty(),
        )
    }

    private fun readObject(path: String, query: Map<String, String>): JsonObject? = try {
        val queryString = query.entries.joinToString("&") { (key, value) -> "$key=${URLEncoder.encode(value, StandardCharsets.UTF_8)}" }
        val uri = URI("${checkNotNull(base)}/api/v1/$path${if (queryString.isEmpty()) "" else "?$queryString"}")
        val body = transport.read(uri)
        require(body.length <= MAX_RESPONSE_BYTES)
        (Json.parseToJsonElement(body) as? JsonObject)?.takeIf { it.text("status") == "success" && it["data"] is JsonObject }
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        null // Never return exception text, upstream URLs, configuration or response bodies to a browser.
    }

    private fun unavailable(now: Instant, error: String) = MonitoringSnapshot(
        serverTime = now.toString(), configured = configured, available = false, error = error,
        health = listOf("prometheus", "api", "node").map { MonitoringHealth(it, "unknown") },
    )
}

val MONITORING_RANGES = mapOf(60 to 60L, 360 to 180L, 1440 to 720L, 10080 to 5040L)

private const val MAX_RESPONSE_BYTES = 262_144
private val HISTORY_NAMES = setOf("cpuPercent", "memoryPercent", "requestRate", "errorRate", "p95LatencyMs", "throttledRate")
private val SUMMARY_NAMES = HISTORY_NAMES + setOf("memoryUsedBytes", "memoryTotalBytes", "load1", "diskUsedBytes", "diskTotalBytes", "gameAcceptedRate", "gameRejectedRate", "apiUp", "nodeUp", "apiUptimeSeconds", "jvmHeapUsedBytes", "jvmHeapMaxBytes")

internal fun parseMonitoringBase(value: String?): URI? = runCatching {
    value?.trim()?.takeIf(String::isNotEmpty)?.let(::URI)?.takeIf {
        it.scheme in setOf("http", "https") && !it.host.isNullOrEmpty() && it.rawUserInfo == null &&
            it.rawQuery == null && it.rawFragment == null && it.path in setOf("", "/") && (it.port == -1 || it.port in 1..65535)
    }?.let { URI(it.toString().trimEnd('/')) }
}.getOrNull()

private fun JsonObject.text(name: String): String? = (get(name) as? JsonPrimitive)?.contentOrNull
private fun JsonObject.results(expectedType: String): JsonArray? {
    val data = get("data") as? JsonObject ?: return null
    if (text("status") != "success" || data.text("resultType") != expectedType) return null
    return (data["result"] as? JsonArray)?.takeIf { it.size <= 24 }
}

private fun finiteSample(value: JsonArray?, name: String): Double? {
    if (value?.size != 2) return null
    val timestamp = (value[0] as? JsonPrimitive)?.doubleOrNull ?: return null
    if (!timestamp.isFinite() || timestamp < 0 || timestamp > 253_402_300_799.0) return null
    val number = (value[1] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() && it >= 0 } ?: return null
    if (name in setOf("cpuPercent", "memoryPercent") && number > 100) return null
    if (name in setOf("apiUp", "nodeUp") && number !in setOf(0.0, 1.0)) return null
    return number
}

internal fun parseMonitoringVector(root: JsonObject): Map<String, Double> = buildMap {
    val rows = root.results("vector") ?: return@buildMap
    rows.forEach { row ->
        val series = row as? JsonObject ?: return@forEach
        val name = (series["metric"] as? JsonObject)?.text("key")?.takeIf { it in SUMMARY_NAMES } ?: return@forEach
        val value = finiteSample(series["value"] as? JsonArray, name) ?: return@forEach
        if (!containsKey(name)) put(name, value)
    }
}

internal fun parseMonitoringMatrix(root: JsonObject, start: Long, end: Long, step: Long = 60L): List<MonitoringSample> {
    if (MONITORING_RANGES.entries.none { end - start == it.key * 60L && step == it.value } || start < 0 || end > 253_402_300_799L) return emptyList()
    val rows = root.results("matrix") ?: return emptyList()
    val values = mutableMapOf<Long, MutableMap<String, Double>>()
    rows.forEach { row ->
        val series = row as? JsonObject ?: return@forEach
        val name = (series["metric"] as? JsonObject)?.text("key")?.takeIf { it in HISTORY_NAMES } ?: return@forEach
        val samples = (series["values"] as? JsonArray)?.takeIf { it.size <= (end - start) / step + 1 } ?: return@forEach
        samples.forEach sampleLoop@ { element ->
            val sample = element as? JsonArray ?: return@sampleLoop
            val time = (sample.firstOrNull() as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() && it >= start && it <= end && it % 1.0 == 0.0 }?.toLong() ?: return@sampleLoop
            if ((time - start) % step != 0L) return@sampleLoop
            val value = finiteSample(sample, name) ?: return@sampleLoop
            values.getOrPut(time) { mutableMapOf() }.putIfAbsent(name, value)
        }
    }
    // Include gaps as null; drawing a continuous line through an outage would be misleading.
    return (0..((end - start) / step).toInt()).map { index ->
        val time = start + index * step
        val point = values[time].orEmpty()
        MonitoringSample(Instant.ofEpochSecond(time).toString(), point["cpuPercent"], point["memoryPercent"], point["requestRate"], point["errorRate"], point["throttledRate"], point["p95LatencyMs"])
    }
}

private val ALERT_DEFINITIONS = mapOf(
    "ZhivApiDown" to ("critical" to "API не отвечает на сбор метрик больше минуты"),
    "ZhivNodeDown" to ("warning" to "Не удаётся получить показатели сервера"),
    "ZhivHighErrorRate" to ("critical" to "Повышена доля ответов API с ошибкой 5xx"),
    "ZhivRateLimited" to ("warning" to "Повышена доля ограничений 429: проверьте частоту запросов"),
    "ZhivSlowApi" to ("warning" to "95-й процентиль времени ответа API превышает 2 секунды"),
    "ZhivDiskLow" to ("critical" to "На основном диске осталось меньше 10% свободного места"),
    "ZhivMemoryPressure" to ("warning" to "На сервере доступно меньше 10% оперативной памяти"),
    "ZhivGameRejects" to ("warning" to "Сервер отклоняет заметную долю игровых нажатий"),
)

internal fun parseMonitoringAlerts(root: JsonObject): List<MonitoringAlert> {
    if (root.text("status") != "success") return emptyList()
    val rows = ((root["data"] as? JsonObject)?.get("alerts") as? JsonArray)?.takeIf { it.size <= 100 } ?: return emptyList()
    return rows.mapNotNull { row ->
        val value = row as? JsonObject ?: return@mapNotNull null
        val name = (value["labels"] as? JsonObject)?.text("alertname") ?: return@mapNotNull null
        val definition = ALERT_DEFINITIONS[name] ?: return@mapNotNull null
        val state = value.text("state")?.takeIf { it in setOf("pending", "firing") } ?: return@mapNotNull null
        val activeAt = value.text("activeAt")?.takeIf { it.length <= 40 }?.let { runCatching { Instant.parse(it).toString() }.getOrNull() }
        MonitoringAlert(name, definition.first, state, definition.second, activeAt)
    }.distinctBy { it.name }.take(20)
}

private fun host(expression: String) = "($expression) and on() (max(up{job=\"node\"}) == 1)"
private fun api(expression: String) = "($expression) and on() (max(up{job=\"api\"}) == 1)"
private val EXPRESSIONS = linkedMapOf(
    "cpuPercent" to host("clamp(100 * (1 - avg(rate(node_cpu_seconds_total{job=\"node\",mode=\"idle\"}[2m]))), 0, 100)"),
    "memoryPercent" to host("100 * (1 - max(node_memory_MemAvailable_bytes{job=\"node\"}) / max(node_memory_MemTotal_bytes{job=\"node\"}))"),
    "memoryUsedBytes" to host("max(node_memory_MemTotal_bytes{job=\"node\"}) - max(node_memory_MemAvailable_bytes{job=\"node\"})"),
    "memoryTotalBytes" to host("max(node_memory_MemTotal_bytes{job=\"node\"})"),
    "load1" to host("max(node_load1{job=\"node\"})"),
    "diskUsedBytes" to host("max(node_filesystem_size_bytes{job=\"node\",mountpoint=\"/\",fstype!~\"tmpfs|overlay\"}) - max(node_filesystem_avail_bytes{job=\"node\",mountpoint=\"/\",fstype!~\"tmpfs|overlay\"})"),
    "diskTotalBytes" to host("max(node_filesystem_size_bytes{job=\"node\",mountpoint=\"/\",fstype!~\"tmpfs|overlay\"})"),
    "requestRate" to api("sum(rate(zhiv_http_requests_total{job=\"api\"}[2m]))"),
    "errorRate" to api("sum(rate(zhiv_http_errors_total{job=\"api\"}[2m]))"),
    "throttledRate" to api("sum(rate(zhiv_http_throttled_total{job=\"api\"}[2m]))"),
    "p95LatencyMs" to api("1000 * histogram_quantile(0.95, sum by(le)(rate(zhiv_http_request_duration_seconds_bucket{job=\"api\"}[5m])))"),
    "gameAcceptedRate" to api("sum(rate(zhiv_game_taps_total{job=\"api\",result=\"accepted\"}[2m]))"),
    "gameRejectedRate" to api("sum(rate(zhiv_game_taps_total{job=\"api\",result=\"rejected\"}[2m]))"),
    "apiUp" to "max(up{job=\"api\"})",
    "nodeUp" to "max(up{job=\"node\"})",
    "apiUptimeSeconds" to api("max(zhiv_process_uptime_seconds{job=\"api\"})"),
    "jvmHeapUsedBytes" to api("max(zhiv_jvm_heap_used_bytes{job=\"api\"})"),
    "jvmHeapMaxBytes" to api("max(zhiv_jvm_heap_max_bytes{job=\"api\"})"),
)
private fun combinedQuery(names: Set<String>): String = EXPRESSIONS.filterKeys { it in names }.entries.joinToString(" or ") { (key, expression) ->
    "label_replace(($expression), \"key\", \"$key\", \"\", \"\")"
}
private val SUMMARY_QUERY = combinedQuery(SUMMARY_NAMES)
private val HISTORY_QUERY = combinedQuery(HISTORY_NAMES)

private class HttpMonitoringTransport : MonitoringTransport {
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).followRedirects(HttpClient.Redirect.NEVER).build()
    override fun read(uri: URI): String {
        val request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(3)).header("Accept", "application/json").GET().build()
        val body = LimitedBodySubscriber()
        val pending = client.sendAsync(request) { body }
        return try {
            val response = pending.get(4, TimeUnit.SECONDS)
            require(response.statusCode() == 200)
            response.body()
        } catch (error: Exception) {
            body.cancel()
            pending.cancel(true)
            throw error
        }
    }
}

/** Limits memory while streaming and cancels a slow body when the full-response deadline expires. */
private class LimitedBodySubscriber : HttpResponse.BodySubscriber<String> {
    private val result = CompletableFuture<String>()
    private val bytes = ByteArrayOutputStream()
    @Volatile private var subscription: Flow.Subscription? = null
    override fun getBody(): CompletionStage<String> = result
    override fun onSubscribe(value: Flow.Subscription) {
        subscription = value
        if (result.isDone) value.cancel() else value.request(1)
    }
    override fun onNext(items: List<ByteBuffer>) {
        for (item in items) {
            if (item.remaining() > MAX_RESPONSE_BYTES - bytes.size()) {
                cancel()
                return
            }
            val chunk = ByteArray(item.remaining())
            item.get(chunk)
            bytes.write(chunk)
        }
        subscription?.request(1)
    }
    override fun onError(throwable: Throwable) { result.completeExceptionally(throwable) }
    override fun onComplete() { result.complete(bytes.toString(StandardCharsets.UTF_8)) }
    fun cancel() {
        result.completeExceptionally(IllegalStateException("Monitoring response unavailable"))
        subscription?.cancel()
    }
}
