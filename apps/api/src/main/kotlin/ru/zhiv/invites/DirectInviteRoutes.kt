package ru.zhiv.invites

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
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
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.CapabilityTokenRequest
import ru.zhiv.http.DirectInviteLinkResponse
import ru.zhiv.http.DirectInvitePreviewResponse
import ru.zhiv.http.DirectInviteRedeemResponse
import ru.zhiv.http.PersonDto
import ru.zhiv.http.PublicUserDto
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.relationships.PersonSnapshot
import ru.zhiv.security.TokenCodec

private val capabilityToken = Regex("^[A-Za-z0-9_-]{43}$")

fun Route.directInviteRoutes(
    repository: DirectInviteRepository,
    tokenCodec: TokenCodec,
    config: AppConfig,
) {
    rateLimit(RateLimitName("relationships")) {
        route("/api/v1/direct-invite-links") {
            install(RequestBodyLimit) {
                bodyLimit { 2_048 }
            }

        post {
            call.response.header(HttpHeaders.CacheControl, "no-store")
            if (!call.isTrustedWrite(config)) {
                call.respond(HttpStatusCode.Forbidden, ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"))
                return@post
            }
            val key = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
            if (key == null) {
                call.respond(
                    HttpStatusCode.BadRequest,
                    ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"),
                )
                return@post
            }
            val session = call.sessionCookie(config)
            val body = call.receive<CapabilityTokenRequest>()
            if (!capabilityToken.matches(body.token)) {
                call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_INVITE", "Некорректная ссылка"))
                return@post
            }
            if (session == null) {
                call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                return@post
            }
            when (val result = repository.create(tokenCodec.hash(session), tokenCodec.hash(body.token), key)) {
                is DirectInviteResult.Success -> call.respond(
                    if (result.value.replayed) HttpStatusCode.OK else HttpStatusCode.Created,
                    result.value.toDto(),
                )
                else -> call.respondInviteError(result)
            }
        }

        post("/preview") {
            call.response.header(HttpHeaders.CacheControl, "no-store")
            if (!call.isTrustedWrite(config)) {
                call.respond(HttpStatusCode.Forbidden, ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"))
                return@post
            }
            val body = call.receive<CapabilityTokenRequest>()
            if (!capabilityToken.matches(body.token)) {
                call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_INVITE", "Некорректная ссылка"))
                return@post
            }
            when (val result = repository.preview(tokenCodec.hash(body.token))) {
                is DirectInviteResult.Success -> call.respond(result.value.toDto())
                else -> call.respondInviteError(result)
            }
        }

            post("/redeem") {
            call.response.header(HttpHeaders.CacheControl, "no-store")
            if (!call.isTrustedWrite(config)) {
                call.respond(HttpStatusCode.Forbidden, ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"))
                return@post
            }
            val key = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
            if (key == null) {
                call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"))
                return@post
            }
            val session = call.sessionCookie(config)
            val body = call.receive<CapabilityTokenRequest>()
            if (session == null) {
                call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                return@post
            }
            if (!capabilityToken.matches(body.token)) {
                call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_INVITE", "Некорректная ссылка"))
                return@post
            }
            when (val result = repository.redeem(tokenCodec.hash(session), tokenCodec.hash(body.token), key)) {
                is DirectInviteResult.Success -> call.respond(result.value.toDto())
                else -> call.respondInviteError(result)
            }
            }
        }
    }
}

private suspend fun io.ktor.server.application.ApplicationCall.respondInviteError(result: DirectInviteResult<*>) {
    val error = when (result) {
        DirectInviteResult.Unauthorized -> Triple(HttpStatusCode.Unauthorized, "UNAUTHORIZED", "Сессия не найдена")
        DirectInviteResult.NotFound -> Triple(HttpStatusCode.NotFound, "INVITE_NOT_FOUND", "Приглашение не найдено")
        DirectInviteResult.Self -> Triple(HttpStatusCode.Conflict, "CANNOT_ADD_SELF", "Нельзя принять свою ссылку")
        DirectInviteResult.Expired -> Triple(HttpStatusCode.Gone, "INVITE_EXPIRED", "Ссылка уже недействительна")
        DirectInviteResult.Conflict -> Triple(HttpStatusCode.Conflict, "INVITE_CONFLICT", "Ссылка уже использована")
        is DirectInviteResult.Success -> error("success is not an error")
    }
    respond(error.first, ApiErrorResponse(error.second, error.third))
}

private fun DirectInviteLinkSnapshot.toDto() = DirectInviteLinkResponse(
    inviteId.toString(), expiresAt.toInstant().toString(), replayed, serverTime.toInstant().toString(),
)
private fun DirectInvitePreviewSnapshot.toDto() = DirectInvitePreviewResponse(
    PublicUserDto(inviter.publicId, inviter.displayName), expiresAt.toInstant().toString(),
    serverTime.toInstant().toString(),
)
private fun DirectInviteRedeemSnapshot.toDto() = DirectInviteRedeemResponse(
    person.toDto(), replayed, serverTime.toInstant().toString(),
)
private fun PersonSnapshot.toDto() = PersonDto(
    circleId = circleId.toString(),
    user = PublicUserDto(user.publicId, user.displayName),
    connectedAt = connectedAt.toInstant().toString(),
    mySharingMode = mySharingMode.name,
    theirSharingMode = theirSharingMode.name,
    checkInState = checkInState.name,
    lastCheckInAt = lastCheckInAt?.toInstant()?.toString(),
    status = statusText?.let { text -> statusUpdatedAt?.let { ru.zhiv.http.UserStatusDto(text, it.toInstant().toString()) } },
)
