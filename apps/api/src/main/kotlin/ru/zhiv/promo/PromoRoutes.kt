package ru.zhiv.promo

import io.ktor.http.HttpHeaders
import io.ktor.server.application.install
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.*
import kotlinx.serialization.json.JsonElement
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.sessionCookie
import ru.zhiv.presence.PresenceRepository
import ru.zhiv.presence.requireGameplayPresence
import ru.zhiv.security.TokenCodec

fun Route.promoRoutes(repository: PromoRepository, codec: TokenCodec, config: AppConfig, presence: PresenceRepository? = null) {
    route("/api/v1/economy/promo") {
        install(RequestBodyLimit) { bodyLimit { 1_024 } }
        rateLimit(RateLimitName("promo-write")) {
            post {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                if (!call.isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
                val hash = codec.hash(call.sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401))
                call.requireGameplayPresence(presence, hash)
                val body = call.receive<JsonElement>()
                val request = decodePromoRequest(body)
                call.respond(repository.redeem(hash, request))
            }
        }
    }
}
