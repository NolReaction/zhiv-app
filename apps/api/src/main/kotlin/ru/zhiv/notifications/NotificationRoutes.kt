package ru.zhiv.notifications

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
import ru.zhiv.http.parsePublicId
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec

private fun ApplicationCall.notificationSession(config: AppConfig, codec: TokenCodec, write: Boolean): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    response.header("X-Robots-Tag", "noindex, nofollow")
    if (write && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    return sessionCookie(config)?.let(codec::hash) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
}
private fun owner(raw: String): String = parsePublicId(raw) ?: invalidNotification()
fun Route.notificationRoutes(repository: NotificationRepository, codec: TokenCodec, config: AppConfig) {
    route("/api/v1/notifications") {
        install(RequestBodyLimit) { bodyLimit { 4096 } }
        rateLimit(RateLimitName("notifications-read")) {
            get {
                val hash = call.notificationSession(config, codec, false)
                val expected = call.request.queryParameters.getAll("expectedOwnerPublicId")?.singleOrNull() ?: invalidNotification()
                call.respond(repository.snapshot(hash, owner(expected)))
            }
        }
        rateLimit(RateLimitName("notifications-write")) {
            put("/preferences") {
                val hash = call.notificationSession(config, codec, true)
                val request = call.receive<NotificationPreferencesRequest>()
                validateNotificationPreferences(request.preferences)
                call.respond(repository.preferences(hash, owner(request.expectedOwnerPublicId), request.preferences))
            }
            post("/subscriptions") {
                val hash = call.notificationSession(config, codec, true)
                val request = call.receive<NotificationSubscribeRequest>()
                validatePushSubscription(request.subscription)
                call.respond(repository.subscribe(hash, owner(request.expectedOwnerPublicId), request.subscription))
            }
            delete("/subscriptions") {
                val hash = call.notificationSession(config, codec, true)
                val request = call.receive<NotificationUnsubscribeRequest>()
                validatePushEndpoint(request.endpoint)
                call.respond(repository.unsubscribe(hash, owner(request.expectedOwnerPublicId), request.endpoint))
            }
        }
        rateLimit(RateLimitName("notifications-presence")) {
            post("/presence") {
                val hash = call.notificationSession(config, codec, true)
                val request = call.receive<NotificationPresenceRequest>()
                repository.presence(hash, owner(request.expectedOwnerPublicId))
                call.respond(NotificationPresenceResponse())
            }
        }
    }
}
