package ru.zhiv.world

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
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec

private fun ApplicationCall.worldSession(config: AppConfig, codec: TokenCodec, write: Boolean=false): ByteArray {
    response.header(HttpHeaders.CacheControl,"no-store")
    if(write && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN","Источник запроса не разрешён",403)
    val token=sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401)
    return codec.hash(token)
}
fun Route.worldRoutes(repository: WorldRepository, codec: TokenCodec, config: AppConfig) {
    route("/api/v1/world") {
        install(RequestBodyLimit) { bodyLimit { 2_048 } }
        rateLimit(RateLimitName("world-read")) {
            get { call.respond(repository.snapshot(call.worldSession(config,codec))) }
        }
        rateLimit(RateLimitName("world-write")) {
            post("/commands") {
                val hash=call.worldSession(config,codec,true)
                val command=call.receive<WorldCommand>()
                if(parseCanonicalUuidV4(command.requestId)==null || command.expectedRevision !in 0L until 9_007_199_254_740_991L || command.target.length>80 || command.action.length>40)
                    throw AuthFailure("INVALID_WORLD_COMMAND","Некорректный запрос мира",400)
                call.respond(repository.command(hash,command))
            }
        }
    }
}
