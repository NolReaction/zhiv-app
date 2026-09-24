package ru.zhiv.forest

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
import ru.zhiv.http.parsePublicId
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec

private fun ApplicationCall.forestSession(config: AppConfig, codec: TokenCodec, write: Boolean = false): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    if (write && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    val raw = sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    return codec.hash(raw)
}

fun Route.forestMemoryRoutes(repository: ForestMemoryRepository, codec: TokenCodec, config: AppConfig) {
    route("/api/v1/world/forest-memory") {
        install(RequestBodyLimit) { bodyLimit { 65_536 } }
        rateLimit(RateLimitName("forest-memory-read")) {
            get {
                val hash = call.forestSession(config, codec)
                val query = call.request.queryParameters
                if (query.names() != setOf("expectedOwnerPublicId", "clientId")) invalidForestMemory()
                val rawOwner = query.getAll("expectedOwnerPublicId")?.singleOrNull()
                val owner = parsePublicId(rawOwner)?.takeIf { it == rawOwner } ?: invalidForestMemory()
                val clientId = parseForestMemoryClientId(query.getAll("clientId")?.singleOrNull()) ?: invalidForestMemory()
                call.respond(repository.read(hash, owner, clientId))
            }
        }
        rateLimit(RateLimitName("forest-memory-write")) {
            post("/commands") {
                val hash = call.forestSession(config, codec, write = true)
                val command = decodeForestMemoryCommand(call.receive<JsonElement>())
                call.respond(repository.command(hash, command))
            }
        }
    }
}
