package ru.zhiv.game

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.install
import io.ktor.server.application.log
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.ClickerSeriesEventRequest
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.observability.ClickerSeriesFinishedEvent
import ru.zhiv.observability.GameEventSink
import ru.zhiv.security.TokenCodec

private const val MAX_TAPS = 100_000L
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val MAX_DURATION_MS = 7L * 24 * 60 * 60 * 1_000
private val storyIds = setOf(
    "clicker", // v0.4.6 neutral series; legacy IDs below accept already queued events
    "space", "lab", "hike", "arcade", "garden", "ocean", "magic", "time",
    "cinema", "future", "observatory", "bakery", "detective", "orchestra",
    "express", "lighthouse", "robots", "polar", "library", "weather", "radio",
    "museum", "dragons", "volcano",
)

fun Route.gameEventRoutes(
    identities: IdentityRepository,
    tokenCodec: TokenCodec,
    config: AppConfig,
    events: GameEventSink,
) {
    rateLimit(RateLimitName("game-events")) {
        route("/api/v1/game-events") {
            install(RequestBodyLimit) {
                bodyLimit { 2_048 }
            }
            post {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
                    return@post
                }

                val rawToken = call.sessionCookie(config)
                val identity = rawToken?.let { identities.findBySession(tokenCodec.hash(it)) }
                if (identity == null) {
                    call.respond(
                        HttpStatusCode.Unauthorized,
                        ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"),
                    )
                    return@post
                }

                val request = call.receive<ClickerSeriesEventRequest>()
                val eventId = parseCanonicalUuidV4(request.eventId)
                if (eventId == null || !request.isValid()) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_GAME_EVENT", "Некорректное игровое событие"),
                    )
                    return@post
                }

                runCatching {
                    events.record(
                        ClickerSeriesFinishedEvent(
                            eventId = eventId,
                            tapCount = request.tapCount,
                            bestSeries = request.bestSeries,
                            lifetimeTaps = request.lifetimeTaps,
                            level = request.level,
                            storyId = request.storyId,
                            durationMs = request.durationMs,
                            reason = request.reason,
                        ),
                    )
                }.onFailure { cause ->
                    call.application.log.warn("Game event sink failed", cause)
                }
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}

private fun ClickerSeriesEventRequest.isValid(): Boolean {
    if (
        type != "CLICKER_SERIES_FINISHED" ||
        tapCount !in 1L..MAX_TAPS ||
        bestSeries !in tapCount..MAX_TAPS ||
        storyId !in storyIds ||
        durationMs !in 0L..MAX_DURATION_MS ||
        reason != "IDLE_TIMEOUT"
    ) return false

    val lifetime = lifetimeTaps
    return if (lifetime == null) {
        level == legacyLevelFor(bestSeries)
    } else {
        lifetime in bestSeries..MAX_SAFE_INTEGER && level == lifetimeLevelFor(lifetime)
    }
}

private fun lifetimeLevelFor(lifetimeTaps: Long): Int = when {
    lifetimeTaps >= 5_000 -> 10
    lifetimeTaps >= 2_500 -> 9
    lifetimeTaps >= 1_000 -> 8
    lifetimeTaps >= 500 -> 7
    lifetimeTaps >= 250 -> 6
    lifetimeTaps >= 100 -> 5
    lifetimeTaps >= 50 -> 4
    lifetimeTaps >= 25 -> 3
    lifetimeTaps >= 10 -> 2
    else -> 1
}

private fun legacyLevelFor(bestSeries: Long): Int = when {
    bestSeries >= 100_000 -> 10
    bestSeries >= 10_000 -> 9
    bestSeries >= 1_000 -> 8
    bestSeries >= 500 -> 7
    bestSeries >= 100 -> 6
    bestSeries >= 50 -> 5
    bestSeries >= 20 -> 4
    bestSeries >= 10 -> 3
    bestSeries >= 5 -> 2
    else -> 1
}
