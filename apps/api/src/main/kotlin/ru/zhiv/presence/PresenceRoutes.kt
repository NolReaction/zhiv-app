package ru.zhiv.presence

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
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec

private fun ApplicationCall.presenceSession(config: AppConfig, codec: TokenCodec): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    if (!isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    return codec.hash(sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401))
}

fun Route.presenceRoutes(repository: PresenceRepository, codec: TokenCodec, config: AppConfig) {
    route("/api/v1/presence") {
        install(RequestBodyLimit) { bodyLimit { 1_024 } }
        rateLimit(RateLimitName("presence-write")) {
            post {
                val hash = call.presenceSession(config, codec)
                if (!call.request.queryParameters.isEmpty()) throw AuthFailure("INVALID_PRESENCE", "Некорректный запрос игровой активности", 400)
                val request = call.receive<PresenceRequest>()
                validatePresenceRequest(request)
                call.respond(repository.update(hash, request, call.gameplayGeneration()))
            }
        }
    }
}

/** Run inside the matched mutation handler, so alternate URL encodings cannot
 * bypass a string-based path filter. The production composition supplies this
 * repository for every gameplay writer. */
suspend fun ApplicationCall.requireGameplayPresence(repository: PresenceRepository?, sessionHash: ByteArray) {
    if (repository == null) return
    val id = parseCanonicalUuidV4(request.headers[PRESENCE_HEADER])
    repository.requireActive(sessionHash, id, gameplayGeneration())
}

/** Service check-ins and welcome gifts need the reset fence without an active
 * game lease. Missing headers identify legacy clients in generation zero only. */
suspend fun ApplicationCall.requireGameplayGeneration(repository: PresenceRepository?, sessionHash: ByteArray) {
    repository?.requireGeneration(sessionHash, gameplayGeneration())
}

private fun ApplicationCall.gameplayGeneration(): Long {
    val values = request.headers.getAll(GAMEPLAY_GENERATION_HEADER) ?: return 0
    val value = values.singleOrNull()
    return value?.takeIf { Regex("0|[1-9][0-9]{0,15}").matches(it) }?.toLongOrNull()
        ?.takeIf { it <= 9_007_199_254_740_990L }
        ?: throw AuthFailure("GAME_PROGRESS_RESET", "Игра началась заново. Обновите страницу", 409)
}
