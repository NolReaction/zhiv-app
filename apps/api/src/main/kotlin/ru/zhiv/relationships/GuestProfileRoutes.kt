package ru.zhiv.relationships

import io.ktor.http.HttpHeaders
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.parseCanonicalUuid
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec

fun Route.guestProfileRoutes(repository: GuestProfileRepository, codec: TokenCodec, config: AppConfig) {
    rateLimit(RateLimitName("relationships")) {
        get("/api/v1/people/{circleId}/game-profile") {
            call.response.header(HttpHeaders.CacheControl, "no-store")
            val token = call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
            val circleId = parseCanonicalUuid(call.parameters["circleId"])
                ?: throw AuthFailure("INVALID_CIRCLE_ID", "Некорректная связь", 400)
            if (!call.request.queryParameters.isEmpty()) throw AuthFailure("INVALID_GUEST_PROFILE_QUERY", "Лишние параметры профиля", 400)
            call.respond(repository.profile(codec.hash(token), circleId))
        }
    }
}
