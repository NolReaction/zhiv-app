package ru.zhiv.admin

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

private fun invalidAnalytics(): Nothing = throw AuthFailure("INVALID_ADMIN_QUERY", "Проверьте параметры аналитики", 400)
private val analyticsDate = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
private val analyticsId = Regex("[a-z][a-z0-9_]{0,79}")

/** Raw query values are validated again behind repository authentication. */
data class AdminAnalyticsQuery(val from: String? = null, val to: String? = null, val q: String = "", val scope: String = "players") {
    fun resolve(now: Instant): AdminAnalyticsWindow {
        if ((from == null) != (to == null) || q.length > 100 || q.any(Char::isISOControl) || scope !in setOf("players", "all")) invalidAnalytics()
        val today = now.atOffset(ZoneOffset.UTC).toLocalDate()
        fun date(value: String): LocalDate {
            if (!analyticsDate.matches(value)) invalidAnalytics()
            return try { LocalDate.parse(value) } catch (_: Exception) { invalidAnalytics() }
        }
        val first = from?.let(::date) ?: today.minusDays(29)
        val last = to?.let(::date) ?: today
        if (first.year < 1 || last.year < 1 || last > today || first > last || ChronoUnit.DAYS.between(first, last) >= 366) invalidAnalytics()
        val start = first.atStartOfDay().toInstant(ZoneOffset.UTC)
        val end = minOf(last.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC), now)
        return AdminAnalyticsWindow(first, last, start, end, q.trim(), scope)
    }
}

data class AdminAnalyticsWindow(val from: LocalDate, val to: LocalDate, val startAt: Instant, val endAt: Instant, val q: String, val scope: String)
data class AdminAnalyticsEventsQuery(
    val query: AdminAnalyticsQuery = AdminAnalyticsQuery(), val kind: String = "", val resource: String = "",
    val direction: String = "all", val offset: Int = 0, val limit: Int = 25, val at: String? = null,
) {
    fun resolve(now: Instant): AdminAnalyticsWindow {
        if (offset !in 0..100_000 || limit !in 1..100 || direction !in setOf("all", "in", "out") ||
            (kind.isNotEmpty() && !analyticsId.matches(kind)) || (resource.isNotEmpty() && !analyticsId.matches(resource))) invalidAnalytics()
        val window = query.resolve(now)
        val anchor = at?.let {
            if (it.length > 40) invalidAnalytics()
            try { Instant.parse(it) } catch (_: Exception) { invalidAnalytics() }
        }
        if (anchor != null && (anchor < window.startAt || anchor > now)) invalidAnalytics()
        return window.copy(endAt = anchor?.let { minOf(it, window.endAt) } ?: window.endAt)
    }
}

@Serializable data class AdminAnalyticsSummary(val activePlayers: Long, val events: Long, val spendingPlayers: Long,
    val constructionStarts: Long, val constructionClaims: Long, val constructionPlayers: Long)
@Serializable data class AdminAnalyticsDaily(val date: String, val players: Long, val events: Long, val constructionStarts: Long)
@Serializable data class AdminAnalyticsResource(val resourceId: String, val received: Long, val spent: Long,
    val reserved: Long, val returned: Long, val net: Long, val players: Long)
@Serializable data class AdminAnalyticsFlow(val kind: String, val targetId: String?, val resourceId: String, val category: String,
    val received: Long, val spent: Long, val players: Long, val events: Long)
@Serializable data class AdminAnalyticsAction(val kind: String, val targetId: String?, val events: Long, val players: Long)
@Serializable data class AdminAnalyticsConstruction(val buildingId: String, val starts: Long, val claims: Long, val players: Long)
@Serializable data class AdminAnalyticsFirstConstruction(val buildingId: String?, val players: Long)
@Serializable data class AdminAnalyticsBuildingLevel(val buildingId: String, val level: Int, val players: Long)
@Serializable data class AdminAnalyticsGameplay(val mealsConsumed: Long, val foodPlayers: Long, val ordersCompleted: Long,
    val orderPlayers: Long, val orderCoinsEarned: Long, val orderReplacements: Long, val paidOrderReplacements: Long, val orderPearlsSpent: Long)
@Serializable data class AdminAnalyticsMeal(val itemId: String, val heroPortions: Long, val builderPortions: Long, val players: Long)
@Serializable data class AdminAnalyticsOrder(val templateId: String?, val completed: Long, val replacements: Long,
    val paidReplacements: Long, val coinsEarned: Long, val pearlsSpent: Long, val players: Long)
@Serializable data class AdminAnalyticsPresenceDay(val date: String, val players: Long, val onlineSeconds: Long, val flaggedPlayers: Long)
@Serializable data class AdminAnalyticsPresenceReview(val publicId: String, val displayName: String, val date: String,
    val onlineSeconds: Long, val flaggedAt: String, val watchlisted: Boolean)
@Serializable data class AdminAnalyticsPresence(val coverageFrom: String?, val players: Long, val onlineSeconds: Long,
    val flaggedPlayers: Long, val daily: List<AdminAnalyticsPresenceDay>, val reviewDays: List<AdminAnalyticsPresenceReview>, val reviewDaysTruncated: Boolean)
@Serializable data class AdminAnalyticsCoverage(val firstRecordedAt: String?, val unattributedEvents: Long,
    val matchingPlayers: Long, val initializedPlayers: Long, val flowsTruncated: Boolean, val actionsTruncated: Boolean, val ordersTruncated: Boolean)
@Serializable data class AdminAnalyticsProgressionStage(val id: String, val players: Long, val medianSeconds: Long?)
@Serializable data class AdminAnalyticsProgressionCohort(val players: Long, val initializedPlayers: Long,
    val home2Players: Long, val playersWithEvents: Long, val firstRecordedAt: String?, val stages: List<AdminAnalyticsProgressionStage>)
@Serializable data class AdminAnalyticsProgressionReview(val publicId: String, val displayName: String, val homeLevel: Int?,
    val lastActionAt: String?, val readySince: String?, val awaitingCollectionSince: String?, val signals: List<String>)
@Serializable data class AdminAnalyticsProgressionSnapshot(val matchingPlayers: Long, val initializedPlayers: Long,
    val unknownHistoryPlayers: Long, val noAction72hPlayers: Long, val ready24hPlayers: Long, val awaitingCollection24hPlayers: Long,
    val review: List<AdminAnalyticsProgressionReview>, val reviewTruncated: Boolean)
@Serializable data class AdminAnalyticsProgression(val observedUntil: String, val cohort: AdminAnalyticsProgressionCohort,
    val snapshot: AdminAnalyticsProgressionSnapshot)
@Serializable data class AdminAnalytics(
    val serverTime: String, val from: String, val to: String, val startAt: String, val endAt: String, val q: String, val scope: String,
    val summary: AdminAnalyticsSummary, val daily: List<AdminAnalyticsDaily>, val resources: List<AdminAnalyticsResource>,
    val flows: List<AdminAnalyticsFlow>, val actions: List<AdminAnalyticsAction>, val construction: List<AdminAnalyticsConstruction>,
    val firstConstructions: List<AdminAnalyticsFirstConstruction>, val buildingLevels: List<AdminAnalyticsBuildingLevel>,
    val coverage: AdminAnalyticsCoverage, val gameplay: AdminAnalyticsGameplay, val meals: List<AdminAnalyticsMeal>,
    val orders: List<AdminAnalyticsOrder>, val presence: AdminAnalyticsPresence,
    val progression: AdminAnalyticsProgression? = null,
)
@Serializable data class AdminAnalyticsEvent(
    val id: String, val publicId: String, val displayName: String, val createdAt: String, val kind: String, val targetId: String?,
    val quantity: Long?, val contextKnown: Boolean, val category: String, val coins: Long, val pearls: Long, val items: Map<String, Long>,
)
@Serializable data class AdminAnalyticsEvents(
    val serverTime: String, val from: String, val to: String, val startAt: String, val endAt: String, val q: String, val scope: String,
    val kind: String, val resource: String, val direction: String, val at: String?, val offset: Int, val limit: Int, val total: Long,
    val events: List<AdminAnalyticsEvent>,
)
