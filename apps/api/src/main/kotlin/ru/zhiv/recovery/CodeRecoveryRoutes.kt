
package ru.zhiv.recovery

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.install
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import ru.zhiv.config.AppConfig
import ru.zhiv.http.*
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.toResponse
import ru.zhiv.security.TokenCodec
import java.util.Base64

@Serializable data class RecoveryCodeState(val active: Boolean)
@Serializable data class ActivateRecoveryCode(val code: String)
@Serializable data class RedeemRecoveryCode(val code: String, val retrySecret: String)

private val rawPattern=Regex("^[A-Za-z0-9_-]{43}$")
private fun codeValue(value: String): String? =
    value.trim().takeIf { it.startsWith("ZHIV-R1-") }?.removePrefix("ZHIV-R1-")?.takeIf(rawPattern::matches)

fun Route.codeRecoveryRoutes(repository: CodeRecoveryRepository, identities: IdentityRepository, codec: TokenCodec, config: AppConfig) {
    rateLimit(RateLimitName("account-recovery-read")) {
        get("/api/v1/recovery-code") {
            call.response.header(HttpHeaders.CacheControl,"no-store")
            val state=call.sessionCookie(config)?.let { repository.hasCode(codec.hash(it)) }
            if (state==null) call.respond(HttpStatusCode.Unauthorized,ApiErrorResponse("UNAUTHORIZED","Сессия не найдена"))
            else call.respond(RecoveryCodeState(state))
        }
    }
    rateLimit(RateLimitName("account-recovery-write")) {
        route("/api/v1/recovery-code") {
            install(RequestBodyLimit) { bodyLimit { 1_024 } }
            put {
                call.response.header(HttpHeaders.CacheControl,"no-store")
                if (!call.isTrustedWrite(config)) {
                    call.respond(HttpStatusCode.Forbidden,ApiErrorResponse("UNTRUSTED_ORIGIN","Источник запроса не разрешён")); return@put
                }
                val session=call.sessionCookie(config)
                if (session==null || identities.findBySession(codec.hash(session))==null) {
                    call.respond(HttpStatusCode.Unauthorized,ApiErrorResponse("UNAUTHORIZED","Сессия не найдена")); return@put
                }
                val code=codeValue(call.receive<ActivateRecoveryCode>().code)
                if (code==null) {
                    call.respond(HttpStatusCode.BadRequest,ApiErrorResponse("INVALID_CODE","Создайте новый код в приложении")); return@put
                }
                if (repository.activate(codec.hash(session),codec.hash("zhiv.recovery-code.v1:"+code))) call.respond(RecoveryCodeState(true))
                else call.respond(HttpStatusCode.Conflict,ApiErrorResponse("CODE_CONFLICT","Код не активирован. Проверьте сессию и создайте новый."))
            }
            post("/redeem") {
                call.response.header(HttpHeaders.CacheControl,"no-store")
                if (!call.isTrustedWrite(config)) {
                    call.respond(HttpStatusCode.Forbidden,ApiErrorResponse("UNTRUSTED_ORIGIN","Источник запроса не разрешён")); return@post
                }
                val request=call.receive<RedeemRecoveryCode>()
                val code=codeValue(request.code)
                if (code==null || !rawPattern.matches(request.retrySecret)) {
                    call.respond(HttpStatusCode.BadRequest,ApiErrorResponse("INVALID_CODE","Проверьте код восстановления")); return@post
                }
                val rawSession=Base64.getUrlEncoder().withoutPadding().encodeToString(
                    codec.hash("zhiv.recovery-session.v1:"+code+":"+request.retrySecret))
                val sessionHash=codec.hash(rawSession)
                val success=repository.redeem(codec.hash("zhiv.recovery-code.v1:"+code),codec.hash(request.retrySecret),sessionHash,config.sessionDays)
                val user=if(success) identities.findBySession(sessionHash) else null
                if(user==null) {
                    call.respond(HttpStatusCode.Unauthorized,ApiErrorResponse("INVALID_CODE","Код неверен, заменён или уже использован")); return@post
                }
                call.response.header(HttpHeaders.SetCookie,sessionCookieHeader(config,rawSession))
                call.respond(user.toResponse())
            }
        }
    }
}
