package ru.zhiv.http

import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.Hook
import io.ktor.server.application.call
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.isHandled
import io.ktor.server.request.path
import io.ktor.util.AttributeKey
import io.ktor.util.pipeline.PipelinePhase
import ru.zhiv.auth.AuthFailure
import ru.zhiv.auth.isMobileToken

private val mobileSessionKey = AttributeKey<String>("zhiv.verified-mobile-session")

class MobileSessionAuthenticationConfig {
    var cookieName: String = ""
    var validate: suspend (String) -> Boolean = { false }
}

fun ApplicationCall.verifiedMobileToken(): String? = attributes.getOrNull(mobileSessionKey)

private object MobileAuthenticationPhase : Hook<suspend (ApplicationCall) -> Unit> {
    private val phase = PipelinePhase("MobileSessionAuthentication")

    override fun install(pipeline: ApplicationCallPipeline, handler: suspend (ApplicationCall) -> Unit) {
        // Ktor's global limiter runs in Plugins and responds without finishing the
        // pipeline. Run after that entire phase, but before route-specific buckets.
        pipeline.insertPhaseAfter(ApplicationCallPipeline.Plugins, phase)
        pipeline.intercept(phase) {
            if (!call.isHandled) handler(call)
        }
    }
}

/** Browser cookies and native bearer sessions have deliberately disjoint token namespaces. */
val MobileSessionAuthentication = createApplicationPlugin("MobileSessionAuthentication", ::MobileSessionAuthenticationConfig) {
    val validate = pluginConfig.validate
    val cookieName = pluginConfig.cookieName
    on(MobileAuthenticationPhase) { call ->
        if (!call.request.path().startsWith("/api/v1/")) return@on
        val authorization = call.request.headers[HttpHeaders.Authorization] ?: return@on
        val token = authorization.removePrefix("Bearer ")
        if (!authorization.startsWith("Bearer ") || !isMobileToken(token) || call.request.cookies[cookieName] != null || !validate(token)) {
            throw AuthFailure("UNAUTHORIZED", "Сеанс приложения завершён. Войдите снова.", 401)
        }
        call.attributes.put(mobileSessionKey, token)
    }
}
