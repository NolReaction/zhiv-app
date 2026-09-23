package ru.zhiv.feedback

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
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
import ru.zhiv.http.parseCanonicalUuid
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec
import java.time.Duration

private fun invalid(): Nothing = throw AuthFailure("INVALID_FEEDBACK", "Проверьте параметры сообщения", 400)
private fun ApplicationCall.feedbackSession(config: AppConfig, codec: TokenCodec, write: Boolean = false): ByteArray {
    response.header(HttpHeaders.CacheControl, "no-store")
    response.header("X-Robots-Tag", "noindex, nofollow")
    if (write && !isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Источник запроса не разрешён", 403)
    val raw = sessionCookie(config) ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    return codec.hash(raw)
}
private fun ApplicationCall.parameter(name: String, default: String): String =
    request.queryParameters.getAll(name)?.let { it.singleOrNull() ?: invalid() } ?: default

fun Route.feedbackRoutes(repository: FeedbackRepository, codec: TokenCodec, config: AppConfig) {
    route("/api/v1/feedback") {
        // 3000 characters may use four UTF-8 bytes each; allow bounded JSON overhead.
        install(RequestBodyLimit) { bodyLimit { 16_384 } }
        rateLimit(RateLimitName("feedback-read")) {
            get {
                val hash = call.feedbackSession(config, codec)
                val expectedOwner = parsePublicId(call.parameter("expectedOwnerPublicId", "")) ?: invalid()
                call.respond(repository.availability(hash, expectedOwner))
            }
        }
        rateLimit(RateLimitName("feedback-write")) {
            post {
                val hash = call.feedbackSession(config, codec, write = true)
                val request = call.receive<FeedbackRequest>()
                val requestId = parseCanonicalUuidV4(request.clientRequestId) ?: invalid()
                val expectedOwner = parsePublicId(request.expectedOwnerPublicId) ?: invalid()
                val message = validatedFeedbackMessage(request.category, request.message)
                try {
                    call.respond(repository.submit(hash, expectedOwner, requestId, request.category, message))
                } catch (cooldown: FeedbackCooldown) {
                    val seconds = Duration.between(cooldown.serverTime, cooldown.nextAllowedAt).seconds + 1
                    call.response.header(HttpHeaders.RetryAfter, seconds.coerceAtLeast(1).toString())
                    call.respond(HttpStatusCode.TooManyRequests, FeedbackCooldownResponse(
                        nextAllowedAt = cooldown.nextAllowedAt.toInstant().toString(), serverTime = cooldown.serverTime.toInstant().toString(),
                    ))
                }
            }
        }
    }
    route("/api/v1/admin/feedback") {
        install(RequestBodyLimit) { bodyLimit { 2_048 } }
        rateLimit(RateLimitName("admin-read")) {
            get {
                val hash = call.feedbackSession(config, codec)
                val status = call.parameter("status", "all").takeIf { it == "all" || it in FEEDBACK_STATUSES } ?: invalid()
                val category = call.parameter("category", "all").takeIf { it == "all" || it in FEEDBACK_CATEGORIES } ?: invalid()
                val offset = call.parameter("offset", "0").toIntOrNull()?.takeIf { it in 0..100_000 } ?: invalid()
                val limit = call.parameter("limit", "25").toIntOrNull()?.takeIf { it in 1..100 } ?: invalid()
                call.respond(repository.list(hash, status, category, offset, limit))
            }
        }
        rateLimit(RateLimitName("admin-write")) {
            post("/{id}/status") {
                val hash = call.feedbackSession(config, codec, write = true)
                val id = parseCanonicalUuid(call.parameters["id"]) ?: invalid()
                val request = call.receive<FeedbackStatusRequest>()
                val requestId = parseCanonicalUuidV4(request.requestId) ?: invalid()
                if (request.status !in FEEDBACK_STATUSES) invalid()
                call.respond(repository.changeStatus(hash, id, requestId, request.status))
            }
        }
    }
}
