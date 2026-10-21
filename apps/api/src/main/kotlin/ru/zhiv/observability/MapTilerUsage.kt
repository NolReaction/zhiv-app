package ru.zhiv.observability

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import ru.zhiv.config.MapTilerServiceToken
import java.net.URI
import java.time.Clock
import java.time.LocalDate
import java.time.temporal.ChronoUnit

val MAPTILER_USAGE_PERIODS = setOf("current_billing_period", "past_30_days", "past_90_days")
private val GROUPS = listOf("request", "session", "export")
internal const val USAGE_RESPONSE_LIMIT = 2 * 1024 * 1024
private const val MAX_VALUE = 9_007_199_254_740_991.0

@Serializable
data class MapTilerUsagePoint(val date: String, val value: Double)
@Serializable
data class MapTilerUsageGroup(
    val group: String, val total: Double?, val daily: List<MapTilerUsagePoint>, val estimated: List<MapTilerUsagePoint>,
)
@Serializable
data class MapTilerUsageSnapshot(
    val configured: Boolean, val available: Boolean, val error: String? = null,
    val period: String, val scope: String = "account", val since: String? = null, val until: String? = null,
    val updatedAt: String? = null, val groups: List<MapTilerUsageGroup> = emptyList(),
)

data class UsageProviderResponse(val status: Int, val body: String)
fun interface UsageProviderTransport { fun read(uri: URI, token: MapTilerServiceToken): UsageProviderResponse }

/** Official account-wide analytics. No browser reports, key labels, URLs or billing guesses. */
class MapTilerUsageService(
    private val token: MapTilerServiceToken?,
    private val clock: Clock = Clock.systemUTC(),
    private val transport: UsageProviderTransport = HttpUsageProviderTransport(),
    private val elapsedNanos: () -> Long = System::nanoTime,
) {
    private val mutex = Mutex()
    private val cache = mutableMapOf<String, Pair<Long, MapTilerUsageSnapshot>>()

    suspend fun snapshot(period: String = "current_billing_period"): MapTilerUsageSnapshot {
        require(period in MAPTILER_USAGE_PERIODS)
        if (token == null) return unavailable(period, "MAPTILER_DISABLED", false)
        return mutex.withLock {
            cache[period]?.let { (at, value) ->
                val age = elapsedNanos() - at
                if (age >= 0 && age < if (value.available) 300_000_000_000L else 60_000_000_000L) return@withLock value
            }
            val result = withContext(Dispatchers.IO) { load(period, token) }
            cache[period] = elapsedNanos() to result
            result
        }
    }

    private fun load(period: String, credential: MapTilerServiceToken): MapTilerUsageSnapshot = try {
        // The period is an allowlisted enum. The service token is only an HTTP header.
        val uri = URI("https://service.maptiler.com/v1/analytics/api_usage/timeline?period=$period&classifier=services&format=json")
        val response = transport.read(uri, credential)
        when (response.status) {
            200 -> {
                require(response.body.toByteArray(Charsets.UTF_8).size <= USAGE_RESPONSE_LIMIT)
                parseMapTilerUsage(response.body, period, clock.instant().toString())
            }
            401, 403 -> unavailable(period, "MAPTILER_ACCESS_DENIED")
            429 -> unavailable(period, "MAPTILER_RATE_LIMITED")
            400 -> unavailable(period, "MAPTILER_PERIOD_UNAVAILABLE")
            else -> unavailable(period, "MAPTILER_UNAVAILABLE")
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        unavailable(period, "MAPTILER_UNAVAILABLE")
    }

    private fun unavailable(period: String, error: String, configured: Boolean = true) =
        MapTilerUsageSnapshot(configured, false, error, period)
}

/** Reject the complete response if any counted dataset is malformed or unknown. */
internal fun parseMapTilerUsage(body: String, period: String, updatedAt: String): MapTilerUsageSnapshot {
    require(period in MAPTILER_USAGE_PERIODS)
    val root = Json.parseToJsonElement(body) as? JsonObject ?: error("Invalid usage")
    fun date(value: String): LocalDate = LocalDate.parse(value).also { require(it.toString() == value && it.year in 1970..9999) }
    fun text(objectValue: JsonObject, key: String): String =
        (objectValue[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: error("Invalid usage")
    val since = text(root, "since")
    val until = text(root, "until")
    val first = date(since)
    val last = date(until)
    require(!last.isBefore(first) && ChronoUnit.DAYS.between(first, last) <= 366)
    val datasets = (root["datasets"] as? JsonArray)?.also { require(it.size <= 128) } ?: error("Invalid usage")
    val actual = mutableMapOf<String, MutableMap<String, Double>>()
    val estimates = mutableMapOf<String, MutableMap<String, Double>>()
    val seen = mutableSetOf<Pair<String, String>>()
    fun point(element: kotlinx.serialization.json.JsonElement, estimated: Boolean): MapTilerUsagePoint {
        val item = element as? JsonObject ?: error("Invalid usage")
        val day = text(item, "date")
        val parsed = date(day)
        if (!estimated) require(!parsed.isBefore(first) && !parsed.isAfter(last))
        val number = (item["value"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            ?.takeIf { it.isFinite() && it >= 0 && it <= MAX_VALUE } ?: error("Invalid usage")
        return MapTilerUsagePoint(day, number)
    }
    fun add(target: MutableMap<String, MutableMap<String, Double>>, group: String, item: MapTilerUsagePoint) {
        val days = target.getOrPut(group) { mutableMapOf() }
        val sum = (days[item.date] ?: 0.0) + item.value
        require(sum.isFinite() && sum <= MAX_VALUE)
        days[item.date] = sum
    }
    for (element in datasets) {
        val dataset = element as? JsonObject ?: error("Invalid usage")
        val group = text(dataset, "group_id").also { require(it in GROUPS) }
        val itemId = text(dataset, "item_id").also { require(it.length in 1..128 && it.none(Char::isISOControl)) }
        require(seen.add(group to itemId))
        val data = (dataset["data"] as? JsonArray)?.also { require(it.size <= 366) } ?: error("Invalid usage")
        val dates = mutableSetOf<String>()
        for (sample in data) {
            val item = point(sample, false)
            require(dates.add(item.date))
            add(actual, group, item)
        }
        dataset["estimated_data"]?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.let {
            add(estimates, group, point(it, true))
        }
    }
    fun points(values: Map<String, Double>?) = values.orEmpty().entries.sortedBy { it.key }.map { MapTilerUsagePoint(it.key, it.value) }
    val groups = GROUPS.mapNotNull { group ->
        val daily = points(actual[group])
        val estimated = points(estimates[group])
        if (daily.isEmpty() && estimated.isEmpty()) null else {
            require(daily.size <= 366 && estimated.size <= 366)
            val total = daily.takeIf { it.isNotEmpty() }?.sumOf { it.value }
                ?.also { require(it.isFinite() && it <= MAX_VALUE) }
            MapTilerUsageGroup(group, total, daily, estimated)
        }
    }
    return MapTilerUsageSnapshot(true, true, period = period, since = since, until = until, updatedAt = updatedAt, groups = groups)
}
