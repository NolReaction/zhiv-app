package ru.zhiv.auth

import io.ktor.http.HttpHeaders
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import ru.zhiv.config.AppConfig
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.verifiedMobileToken
import ru.zhiv.security.TokenCodec

fun Route.mobileAuthRoutes(repository: MobileAuthRepository, tokens: TokenCodec, config: AppConfig) {
    rateLimit(RateLimitName("auth-entry")) {
        route("/api/v1/auth/mobile") {
            install(RequestBodyLimit) { bodyLimit { 2_048 } }
            post("/authorize") {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                call.response.header("Referrer-Policy", "no-referrer")
                // Only an explicit action in the authenticated first-party browser grants a device.
                if (call.verifiedMobileToken() != null || !call.isTrustedWrite(config)) {
                    throw AuthFailure("UNTRUSTED_ORIGIN", "Подключите приложение через сайт", 403)
                }
                val browser = call.request.cookies[config.cookieName]
                    ?.takeIf { it.length <= 128 && !isMobileToken(it) }
                    ?: throw AuthFailure("UNAUTHORIZED", "Сначала войдите в профиль на сайте", 401)
                val body = call.receive<MobileAuthorizeRequest>()
                val code = tokens.issue()
                repository.authorize(tokens.hash(browser), mobileAuthorization(body, code.hash, tokens))
                call.respond(MobileAuthorizeResponse("$MOBILE_AUTH_CALLBACK?code=${code.raw}&state=${body.state}"))
            }
            post("/exchange") {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                call.response.header("Referrer-Policy", "no-referrer")
                // This endpoint consumes a one-use PKCE proof, never a browser cookie or bearer token.
                if (call.request.headers[HttpHeaders.Origin] != null || call.request.headers[HttpHeaders.Authorization] != null || call.request.cookies[config.cookieName] != null) {
                    throw AuthFailure("UNTRUSTED_ORIGIN", "Завершите подключение в приложении", 403)
                }
                val proof = mobileExchangeProof(call.receive<MobileExchangeRequest>(), tokens)
                val token = issueMobileToken(tokens)
                val grant = repository.exchange(proof, tokens.hash(token), config.sessionDays)
                call.respond(MobileSessionResponse(token, grant.expiresAt, grant.userId.toString()))
            }
        }
    }
}
