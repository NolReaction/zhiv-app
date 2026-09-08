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
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec

private fun badQuery(): Nothing = throw AuthFailure("INVALID_ADMIN_QUERY", "Проверьте параметры поиска", 400)
private fun ApplicationCall.parameter(name: String, default: String): String =
    request.queryParameters.getAll(name)?.let { it.singleOrNull() ?: badQuery() } ?: default
private fun ApplicationCall.page(): Pair<Int, Int> {
    val offset = parameter("offset", "0").toIntOrNull()?.takeIf { it in 0..100_000 } ?: badQuery()
    val limit = parameter("limit", "25").toIntOrNull()?.takeIf { it in 1..100 } ?: badQuery()
    return offset to limit
}
private fun ApplicationCall.adminSessionHash(config: AppConfig, codec: TokenCodec, writing: Boolean = false): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    response.header("X-Robots-Tag", "noindex, nofollow")
    if (writing && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    val raw = sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    return codec.hash(raw)
}

fun Route.adminRoutes(repository: AdminRepository, codec: TokenCodec, config: AppConfig) {
    route("/api/v1/admin") {
        install(RequestBodyLimit) { bodyLimit { 2_048 } }
        rateLimit(RateLimitName("admin-read")) {
            get("/access") { call.respond(repository.access(call.adminSessionHash(config, codec))) }
            get("/overview") {
                val hash = call.adminSessionHash(config, codec)
                val days = call.parameter("days", "30").toIntOrNull()?.takeIf { it in setOf(7, 30, 90) } ?: badQuery()
                call.respond(repository.overview(hash, days))
            }
            get("/users") {
                val hash = call.adminSessionHash(config, codec)
                val (offset, limit) = call.page()
                val query = call.parameter("q", "").trim().takeIf { it.length <= 100 && it.none(Char::isISOControl) } ?: badQuery()
                val sort = call.parameter("sort", "created").takeIf { it in setOf("created", "activity", "taps") } ?: badQuery()
                call.respond(repository.users(hash, query, sort, offset, limit))
            }
            get("/users/{publicId}/rewards") {
                val hash = call.adminSessionHash(config, codec)
                val target = parsePublicId(call.parameters["publicId"]) ?: badQuery()
                call.respond(repository.rewards(hash, target))
            }
            get("/audit") {
                val hash = call.adminSessionHash(config, codec)
                val (offset, limit) = call.page()
                call.respond(repository.audit(hash, offset, limit))
            }
        }
        rateLimit(RateLimitName("admin-write")) {
            post("/users/{publicId}/grant-reward") {
                val hash = call.adminSessionHash(config, codec, writing = true)
                val target = parsePublicId(call.parameters["publicId"]) ?: badQuery()
                val request = call.receive<AdminGrantRequest>()
                val id = parseCanonicalUuidV4(request.requestId) ?: badQuery()
                call.respond(repository.grantReward(hash, target, id, request))
            }
            post("/users/{publicId}/revoke-sessions") {
                val hash = call.adminSessionHash(config, codec, writing = true)
                val target = parsePublicId(call.parameters["publicId"]) ?: badQuery()
                val request = call.receive<AdminRevokeRequest>()
                val id = parseCanonicalUuidV4(request.requestId) ?: badQuery()
                call.respond(repository.revokeSessions(hash, target, id, request.confirmationPublicId, request.reason))
            }
        }
    }
}
