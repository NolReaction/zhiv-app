package ru.zhiv.economy

import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
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
import ru.zhiv.security.TokenCodec

private fun ApplicationCall.barterSession(config: AppConfig, codec: TokenCodec, write: Boolean = false): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    if (write && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    val token = sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    return codec.hash(token)
}

fun Route.economyBarterRoutes(repository: EconomyBarterRepository, codec: TokenCodec, config: AppConfig) {
    route("/api/v1/economy/barter") {
        install(RequestBodyLimit) { bodyLimit { 2_048 } }
        rateLimit(RateLimitName("world-read")) {
            get {
                val hash = call.barterSession(config, codec)
                if (!call.request.queryParameters.isEmpty())
                    throw AuthFailure("INVALID_ECONOMY_QUERY", "Витрина обмена не содержит дополнительных страниц", 400)
                call.respond(repository.barter(hash))
            }
        }
        rateLimit(RateLimitName("world-write")) {
            post("/commands") {
                val hash = call.barterSession(config, codec, true)
                call.respond(repository.command(hash, decodeEconomyBarterCommand(call.receive<JsonElement>())))
            }
        }
    }
}
