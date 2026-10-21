package ru.zhiv.relationships

import io.ktor.http.HttpHeaders
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import kotlinx.serialization.json.*
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
            val profile = repository.profile(codec.hash(token), circleId)
            // Preserve the strict legacy projection, even when the owner shares records.
            val encoded = Json.encodeToJsonElement(profile).jsonObject
            val extended = call.request.headers.getAll("X-Zhiv-Profile")?.singleOrNull() == "tap-stats-v1"
            call.respond(JsonObject(if (extended) encoded + ("tapStats" to
                (profile.tapStats?.let { Json.encodeToJsonElement(it) } ?: JsonNull)) else encoded - "tapStats"))
        }
    }
}
