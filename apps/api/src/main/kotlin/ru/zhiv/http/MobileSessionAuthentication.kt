package ru.zhiv.http

import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.request.path
import io.ktor.util.AttributeKey
import ru.zhiv.auth.AuthFailure
import ru.zhiv.auth.isMobileToken

private val mobileSessionKey = AttributeKey<String>("zhiv.verified-mobile-session")

class MobileSessionAuthenticationConfig {
    var cookieName: String = ""
    var validate: suspend (String) -> Boolean = { false }
}

fun ApplicationCall.verifiedMobileToken(): String? = attributes.getOrNull(mobileSessionKey)

/** Browser cookies and native bearer sessions have deliberately disjoint token namespaces. */
val MobileSessionAuthentication = createApplicationPlugin("MobileSessionAuthentication", ::MobileSessionAuthenticationConfig) {
    val validate = pluginConfig.validate
    val cookieName = pluginConfig.cookieName
    onCall { call ->
        if (!call.request.path().startsWith("/api/v1/")) return@onCall
        val authorization = call.request.headers[HttpHeaders.Authorization] ?: return@onCall
        val token = authorization.removePrefix("Bearer ")
        if (!authorization.startsWith("Bearer ") || !isMobileToken(token) || call.request.cookies[cookieName] != null || !validate(token)) {
            throw AuthFailure("UNAUTHORIZED", "Сеанс приложения завершён. Войдите снова.", 401)
        }
        call.attributes.put(mobileSessionKey, token)
    }
}
