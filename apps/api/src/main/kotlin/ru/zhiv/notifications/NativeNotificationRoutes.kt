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
import ru.zhiv.http.parsePublicId
import ru.zhiv.http.verifiedMobileToken
import ru.zhiv.security.TokenCodec

private fun ApplicationCall.nativeNotificationSession(codec: TokenCodec): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    response.header("X-Robots-Tag", "noindex, nofollow")
    return verifiedMobileToken()?.let(codec::hash)
        ?: throw AuthFailure("MOBILE_SESSION_REQUIRED", "Подключите аккаунт в приложении", 401)
}
private fun nativeOwner(value: String): String = parsePublicId(value) ?: invalidNotification()

fun Route.nativeNotificationRoutes(repository: NativeNotificationRepository, codec: TokenCodec) {
    route("/api/v1/notifications/native") {
        install(RequestBodyLimit) { bodyLimit { 8192 } }
        rateLimit(RateLimitName("notifications-read")) {
            get {
                val hash = call.nativeNotificationSession(codec)
                val owner = call.request.queryParameters.getAll("expectedOwnerPublicId")?.singleOrNull() ?: invalidNotification()
                val platform = call.request.queryParameters.getAll("platform")?.singleOrNull() ?: invalidNotification()
                validateNativePushPlatform(platform)
                call.respond(repository.snapshot(hash, nativeOwner(owner), platform))
            }
        }
        rateLimit(RateLimitName("notifications-write")) {
            post("/subscriptions") {
                val hash = call.nativeNotificationSession(codec)
                val body = call.receive<NativeNotificationSubscribeRequest>()
                validateNativePushToken(body.platform, body.token)
                call.respond(repository.subscribe(hash, nativeOwner(body.expectedOwnerPublicId), body.platform, body.token))
            }
            delete("/subscriptions") {
                val hash = call.nativeNotificationSession(codec)
                val body = call.receive<NativeNotificationUnsubscribeRequest>()
                validateNativePushPlatform(body.platform)
                call.respond(repository.unsubscribe(hash, nativeOwner(body.expectedOwnerPublicId), body.platform))
            }
        }
    }
}
