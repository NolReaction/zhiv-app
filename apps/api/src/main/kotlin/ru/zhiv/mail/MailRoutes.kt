package ru.zhiv.mail

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
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec
import java.util.UUID

private fun ApplicationCall.mailSession(config: AppConfig,codec: TokenCodec,writing: Boolean = false): ByteArray {
    response.header(HttpHeaders.CacheControl,"no-store")
    response.header("X-Robots-Tag","noindex, nofollow")
    if(writing && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN","Источник запроса не разрешён",403)
    return sessionCookie(config)?.let(codec::hash) ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401)
}
private fun ApplicationCall.parameter(name: String, default: String? = null): String? =
    request.queryParameters.getAll(name)?.let { it.singleOrNull() ?: invalidMail() } ?: default

fun Route.mailRoutes(repository: MailRepository,codec: TokenCodec,config: AppConfig) {
    route("/api/v1/mail") {
        install(RequestBodyLimit) { bodyLimit { 1024 } }
        rateLimit(RateLimitName("mail-read")) { get {
            val hash=call.mailSession(config,codec)
            val owner=call.parameter("expectedOwnerPublicId") ?: invalidMail()
            val limit=call.parameter("limit","20")?.toIntOrNull()?.takeIf { it in 1..50 } ?: invalidMail()
            call.respond(repository.inbox(hash,owner,call.parameter("cursor"),limit))
        } }
        rateLimit(RateLimitName("mail-write")) { post("/{id}/read") {
            val hash=call.mailSession(config,codec,writing=true)
            val id=runCatching { UUID.fromString(call.parameters["id"]) }.getOrNull()
                ?.takeIf { it.toString()==call.parameters["id"] } ?: invalidMail()
            call.respond(repository.read(hash,call.receive<MailReadRequest>().expectedOwnerPublicId,id))
        } }
    }
    route("/api/v1/admin/mail/broadcast") {
        install(RequestBodyLimit) { bodyLimit { 16_384 } }
        rateLimit(RateLimitName("admin-read")) { get {
            val hash=call.mailSession(config,codec)
            val offset=call.parameter("offset","0")?.toIntOrNull()?.takeIf { it in 0..100_000 } ?: invalidMail()
            val limit=call.parameter("limit","20")?.toIntOrNull()?.takeIf { it in 1..50 } ?: invalidMail()
            call.respond(repository.broadcastHistory(hash,offset,limit))
        } }
        rateLimit(RateLimitName("admin-mail-write")) { post {
            val hash=call.mailSession(config,codec,writing=true)
            call.respond(repository.broadcast(hash,call.receive<AdminMailBroadcastRequest>()))
        } }
    }
}
