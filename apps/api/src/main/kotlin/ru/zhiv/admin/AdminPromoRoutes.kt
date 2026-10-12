package ru.zhiv.admin

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

private fun ApplicationCall.promoAdminHash(config: AppConfig, codec: TokenCodec, writing: Boolean = false): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    response.header("X-Robots-Tag", "noindex, nofollow")
    if (writing && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    return codec.hash(sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401))
}

fun Route.adminPromoRoutes(repository: AdminPromoRepository, codec: TokenCodec, config: AppConfig) {
    route("/api/v1/admin/promos") {
        install(RequestBodyLimit) { bodyLimit { 16_384 } }
        rateLimit(RateLimitName("admin-read")) {
            get { call.respond(repository.list(call.promoAdminHash(config, codec))) }
        }
        rateLimit(RateLimitName("admin-write")) {
            post("/manage") {
                val hash = call.promoAdminHash(config, codec, writing = true)
                call.respond(repository.manage(hash, decodeAdminPromo(call.receive<JsonElement>())))
            }
        }
    }
}
