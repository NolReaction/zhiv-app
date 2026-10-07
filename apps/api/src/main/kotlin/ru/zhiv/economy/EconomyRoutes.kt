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
import ru.zhiv.presence.PresenceRepository
import ru.zhiv.presence.requireGameplayPresence
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec

private fun ApplicationCall.economySession(config: AppConfig, codec: TokenCodec, write: Boolean = false): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    if (write && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    val token = sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    return codec.hash(token)
}
fun Route.economyRoutes(repository: EconomyRepository, codec: TokenCodec, config: AppConfig, presence: PresenceRepository? = null) {
    route("/api/v1/economy") {
        install(RequestBodyLimit) { bodyLimit { 4_096 } }
        rateLimit(RateLimitName("world-read")) {
            get {
                val hash = call.economySession(config, codec)
                if (!call.request.queryParameters.isEmpty()) invalidEconomy()
                call.respond(repository.snapshot(hash))
            }
        }
        rateLimit(RateLimitName("world-write")) {
            post("/commands") {
                val hash = call.economySession(config, codec, true)
                call.requireGameplayPresence(presence, hash)
                call.respond(repository.command(hash, decodeEconomyCommand(call.receive<JsonElement>())))
            }
        }
    }
}
