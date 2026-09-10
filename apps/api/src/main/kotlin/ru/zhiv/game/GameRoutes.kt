package ru.zhiv.game

import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuid
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec
import ru.zhiv.observability.RuntimeMetrics

private fun ApplicationCall.gameSessionHash(config: AppConfig, codec: TokenCodec, writing: Boolean = false): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    if (writing && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    val raw = sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    return codec.hash(raw)
}

fun Route.gameRoutes(repository: GameRepository, codec: TokenCodec, config: AppConfig) {
    route("/api/v1/game") {
        install(RequestBodyLimit) { bodyLimit { 2_048 } }
        rateLimit(RateLimitName("game-read")) {
            get("/progress") { call.respond(repository.progress(call.gameSessionHash(config, codec))) }
            get("/leaderboard") {
                val hash = call.gameSessionHash(config, codec)
                val scopes = call.request.queryParameters.getAll("scope")
                val scope = scopes?.singleOrNull() ?: if (scopes == null) "global" else null
                if (scope !in setOf("global", "friends")) throw AuthFailure("INVALID_GAME_SCOPE", "Выберите общий рейтинг или рейтинг друзей", 400)
                val metrics = call.request.queryParameters.getAll("metric")
                val metric = metrics?.singleOrNull() ?: if (metrics == null) "monthly_taps" else null
                if (metric !in setOf("monthly_taps", "best_series")) throw AuthFailure("INVALID_GAME_METRIC", "Выберите вид рейтинга", 400)
                call.respond(repository.leaderboard(hash, checkNotNull(scope), checkNotNull(metric)))
            }
            get("/achievements") {
                val hash = call.gameSessionHash(config, codec)
                val versions = call.request.queryParameters.getAll("catalog")
                val version = versions?.singleOrNull() ?: if (versions == null) "1" else null
                if (version !in setOf("1", "2", "3", "4")) throw AuthFailure("INVALID_GAME_CATALOG", "Неизвестный каталог достижений", 400)
                val result = repository.achievements(hash)
                call.respond(when (version) {
                    "4" -> result
                    "3" -> result.copy(achievements = result.achievements.take(6))
                    else -> result.copy(achievements = result.achievements.take(3))
                })
            }
        }
        rateLimit(RateLimitName("game-session")) {
            post("/sessions") {
                val hash = call.gameSessionHash(config, codec, writing = true)
                val request = call.receive<GameSessionRequest>()
                val requestId = parseCanonicalUuidV4(request.requestId)
                    ?: throw AuthFailure("INVALID_GAME_SESSION", "Некорректный запрос игровой сессии", 400)
                call.respond(repository.openSession(hash, requestId, request.ownerPublicId))
            }
        }
        rateLimit(RateLimitName("game-write")) {
            post("/batches") {
                val hash = call.gameSessionHash(config, codec, writing = true)
                val request = call.receive<GameBatchRequest>()
                val sessionId = parseCanonicalUuid(request.sessionId)
                val runId = parseCanonicalUuidV4(request.runId)
                if (sessionId == null || runId == null || request.sequence !in 1L until 9_007_199_254_740_991L || request.tapCount !in 1..60) {
                    throw AuthFailure("INVALID_GAME_BATCH", "Некорректный игровой пакет", 400)
                }
                val receipt = repository.submitBatch(hash, sessionId, request.sequence, request.tapCount, runId, request.tapTimes)
                RuntimeMetrics.shared.recordGameBatch(receipt.acceptedTaps, receipt.rejectedTaps, receipt.replayed)
                call.respond(receipt)
            }
            patch("/visibility") {
                val hash = call.gameSessionHash(config, codec, writing = true)
                val request = call.receive<GameVisibilityRequest>()
                call.respond(repository.setVisibility(hash, request.leaderboardOptIn, request.expectedVersion, request.ownerPublicId))
            }
        }
    }
}
