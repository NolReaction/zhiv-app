package ru.zhiv.relationships

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
import ru.zhiv.economy.decodeEconomyCommand
import ru.zhiv.economy.EconomyMarketRules
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuid
import ru.zhiv.http.sessionCookie
import ru.zhiv.presence.PresenceRepository
import ru.zhiv.presence.requireGameplayPresence
import ru.zhiv.security.TokenCodec

fun Route.guestWorldRoutes(repository: GuestWorldRepository, codec: TokenCodec, config: AppConfig, presence: PresenceRepository? = null) {
    route("/api/v1/people/{circleId}/world") {
        install(RequestBodyLimit) { bodyLimit { 2_048 } }
        fun io.ktor.server.application.ApplicationCall.context(): Pair<ByteArray,java.util.UUID> {
            response.header(HttpHeaders.CacheControl,"no-store")
            val token = sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401)
            val circle = parseCanonicalUuid(parameters["circleId"]) ?: throw AuthFailure("INVALID_CIRCLE_ID","Некорректная связь",400)
            if (!request.queryParameters.isEmpty()) throw AuthFailure("INVALID_GUEST_WORLD_QUERY","Лишние параметры мира",400)
            return codec.hash(token) to circle
        }
        rateLimit(RateLimitName("world-read")) {
            get {
                val (hash,circle) = call.context()
                call.respond(repository.world(hash,circle))
            }
        }
        rateLimit(RateLimitName("world-write")) {
            post("/market/commands") {
                val (hash,circle) = call.context()
                if (!call.isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN","Источник запроса не разрешён",403)
                call.requireGameplayPresence(presence,hash)
                val command = decodeEconomyCommand(call.receive<JsonElement>())
                EconomyMarketRules.validate(command)
                if (command.action != "buy_listing") throw AuthFailure("INVALID_ECONOMY_COMMAND","В лавке друга можно купить выставленную партию",400)
                call.respond(repository.purchase(hash,circle,command))
            }
        }
    }
}
