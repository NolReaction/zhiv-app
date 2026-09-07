package ru.zhiv.observability

import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.hooks.CallSetup
import io.ktor.server.application.hooks.ResponseSent
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import io.ktor.util.AttributeKey
import java.lang.management.ManagementFactory
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.DoubleAdder
import java.util.concurrent.atomic.LongAdder

/** In-process counters, intentionally reset when this API instance restarts. No user labels. */
class RuntimeMetrics {
    private data class ResponseKey(val method: String, val operation: String, val status: String)
    private val requests = LongAdder()
    private val errors = LongAdder()
    private val responses = ConcurrentHashMap<ResponseKey, LongAdder>()
    private val durationSum = DoubleAdder()
    private val durationBuckets = BOUNDS.map { LongAdder() }
    private val gameAccepted = LongAdder()
    private val gameRejected = LongAdder()
    private val gameCommitted = LongAdder()
    private val gameReplayed = LongAdder()

    fun recordRequest(method: String, path: String, status: Int, elapsedNanos: Long) {
        if (path in setOf("/healthz", "/readyz", "/internal/metrics") || status !in 100..599) return
        val key = ResponseKey(method.takeIf { it in METHODS } ?: "OTHER", diagnosticOperation(path), "${status / 100}xx")
        responses.computeIfAbsent(key) { LongAdder() }.increment()
        requests.increment()
        if (status >= 500) errors.increment()
        val seconds = elapsedNanos.coerceAtLeast(0).toDouble() / 1_000_000_000
        durationSum.add(seconds)
        BOUNDS.forEachIndexed { index, bound -> if (seconds <= bound) durationBuckets[index].increment() }
    }

    /** Invoke after transaction commit; retries are separate receipts, never new taps. */
    fun recordGameBatch(acceptedTaps: Int, rejectedTaps: Int, replayed: Boolean) {
        if (replayed) {
            gameReplayed.increment()
            return
        }
        if (acceptedTaps < 0 || rejectedTaps < 0 || acceptedTaps.toLong() + rejectedTaps > 60) return
        gameCommitted.increment()
        gameAccepted.add(acceptedTaps.toLong())
        gameRejected.add(rejectedTaps.toLong())
    }

    fun exposition(): String = buildString {
        append("# HELP zhiv_http_requests_total Completed application HTTP requests excluding health and scrape probes.\n")
        append("# TYPE zhiv_http_requests_total counter\nzhiv_http_requests_total ${requests.sum()}\n")
        append("# HELP zhiv_http_errors_total Completed HTTP responses with 5xx status.\n")
        append("# TYPE zhiv_http_errors_total counter\nzhiv_http_errors_total ${errors.sum()}\n")
        append("# TYPE zhiv_http_responses_total counter\n")
        responses.entries.sortedBy { "${it.key.operation}:${it.key.method}:${it.key.status}" }.forEach { (key, count) ->
            append("zhiv_http_responses_total{method=\"${key.method}\",operation=\"${key.operation}\",status=\"${key.status}\"} ${count.sum()}\n")
        }
        append("# HELP zhiv_http_request_duration_seconds Application response duration excluding probes.\n")
        append("# TYPE zhiv_http_request_duration_seconds histogram\n")
        BOUNDS.forEachIndexed { index, bound ->
            append("zhiv_http_request_duration_seconds_bucket{le=\"$bound\"} ${durationBuckets[index].sum()}\n")
        }
        append("zhiv_http_request_duration_seconds_bucket{le=\"+Inf\"} ${requests.sum()}\n")
        append("zhiv_http_request_duration_seconds_count ${requests.sum()}\n")
        append("zhiv_http_request_duration_seconds_sum ${durationSum.sum()}\n")
        append("# HELP zhiv_game_taps_total Committed gameplay taps excluding replayed receipts.\n")
        append("# TYPE zhiv_game_taps_total counter\n")
        append("zhiv_game_taps_total{result=\"accepted\"} ${gameAccepted.sum()}\n")
        append("zhiv_game_taps_total{result=\"rejected\"} ${gameRejected.sum()}\n")
        append("# TYPE zhiv_game_batches_total counter\n")
        append("zhiv_game_batches_total{result=\"committed\"} ${gameCommitted.sum()}\n")
        append("zhiv_game_batches_total{result=\"replayed\"} ${gameReplayed.sum()}\n")
        val runtime = ManagementFactory.getRuntimeMXBean()
        val memory = ManagementFactory.getMemoryMXBean()
        append("# TYPE zhiv_process_uptime_seconds gauge\nzhiv_process_uptime_seconds ${runtime.uptime / 1000.0}\n")
        append("# TYPE zhiv_jvm_heap_used_bytes gauge\nzhiv_jvm_heap_used_bytes ${memory.heapMemoryUsage.used}\n")
        memory.heapMemoryUsage.max.takeIf { it >= 0 }?.let {
            append("# TYPE zhiv_jvm_heap_max_bytes gauge\nzhiv_jvm_heap_max_bytes $it\n")
        }
        append("# TYPE zhiv_jvm_threads gauge\nzhiv_jvm_threads ${ManagementFactory.getThreadMXBean().threadCount}\n")
    }

    companion object {
        private val METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
        private val BOUNDS = listOf(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0)
        val shared = RuntimeMetrics()
    }
}

class RequestMetricsConfig { var metrics: RuntimeMetrics = RuntimeMetrics.shared }
private val metricStart = AttributeKey<Long>("zhiv.metric-start")
private val metricRecorded = AttributeKey<Boolean>("zhiv.metric-recorded")

val RequestMetrics = createApplicationPlugin("RequestMetrics", ::RequestMetricsConfig) {
    val metrics = pluginConfig.metrics
    on(CallSetup) { call -> call.attributes.put(metricStart, System.nanoTime()) }
    on(ResponseSent) { call ->
        if (call.attributes.getOrNull(metricRecorded) == true) return@on
        call.attributes.put(metricRecorded, true)
        val start = call.attributes.getOrNull(metricStart) ?: return@on
        metrics.recordRequest(call.request.httpMethod.value, call.request.path(), call.response.status()?.value ?: 200, System.nanoTime() - start)
    }
}
