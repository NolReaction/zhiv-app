package ru.zhiv.relationships

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.CreateDirectRequestRequest
import ru.zhiv.http.DirectRequestActionResponse
import ru.zhiv.http.DirectRequestDto
import ru.zhiv.http.DirectRequestResponse
import ru.zhiv.http.DirectRequestsResponse
import ru.zhiv.http.PeopleResponse
import ru.zhiv.http.PersonDto
import ru.zhiv.http.PublicUserDto
import ru.zhiv.http.SharingResponse
import ru.zhiv.http.UpdateSharingRequest
import ru.zhiv.http.UserLookupResponse
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuid
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec
import java.util.UUID

fun Route.relationshipRoutes(
    repository: RelationshipRepository,
    tokenCodec: TokenCodec,
    config: AppConfig,
) {
    rateLimit(RateLimitName("relationships")) {
        get("/api/v1/users/{publicId}") {
            call.noStore()
            val publicId = parsePublicId(call.parameters["publicId"])
            if (publicId == null) {
                call.respondError(HttpStatusCode.BadRequest, "INVALID_PUBLIC_ID", "Введите ID полностью")
                return@get
            }
            val sessionHash = call.sessionHash(config, tokenCodec) ?: return@get
            when (val result = repository.lookup(sessionHash, publicId)) {
                is RelationshipResult.Success -> call.respond(result.value.toDto())
                else -> call.respondRelationshipError(result)
            }
        }

        get("/api/v1/people") {
            call.noStore()
            val sessionHash = call.sessionHash(config, tokenCodec) ?: return@get
            when (val result = repository.listPeople(sessionHash)) {
                is RelationshipResult.Success -> call.respond(result.value.toDto())
                else -> call.respondRelationshipError(result)
            }
        }

        route("/api/v1/direct-requests") {
            install(RequestBodyLimit) {
                bodyLimit { 2_048 }
            }

            get {
                call.noStore()
                val sessionHash = call.sessionHash(config, tokenCodec) ?: return@get
                when (val result = repository.listPeople(sessionHash)) {
                    is RelationshipResult.Success -> call.respond(
                        DirectRequestsResponse(
                            incomingRequests = result.value.incomingRequests.map { it.toDto() },
                            outgoingRequests = result.value.outgoingRequests.map { it.toDto() },
                            serverTime = result.value.serverTime.toInstant().toString(),
                        ),
                    )
                    else -> call.respondRelationshipError(result)
                }
            }

            post {
                call.noStore()
                if (!call.requireTrustedWrite(config)) return@post
                val idempotencyKey = call.requireIdempotencyKey() ?: return@post
                val sessionHash = call.sessionHash(config, tokenCodec) ?: return@post
                val body = call.receive<CreateDirectRequestRequest>()
                val publicId = parsePublicId(body.publicId)
                if (publicId == null) {
                    call.respondError(HttpStatusCode.BadRequest, "INVALID_PUBLIC_ID", "Введите ID полностью")
                    return@post
                }
                when (val result = repository.sendRequest(sessionHash, publicId, idempotencyKey)) {
                    is RelationshipResult.Success -> call.respond(
                        if (result.value.replayed) HttpStatusCode.OK else HttpStatusCode.Created,
                        result.value.toDto(),
                    )
                    else -> call.respondRelationshipError(result)
                }
            }
        }

        requestActionRoute("accept", RequestAction.ACCEPTED, repository, tokenCodec, config)
        requestActionRoute("reject", RequestAction.REJECTED, repository, tokenCodec, config)
        requestActionRoute("cancel", RequestAction.CANCELLED, repository, tokenCodec, config)

        route("/api/v1/people/{circleId}/sharing") {
            install(RequestBodyLimit) {
                bodyLimit { 1_024 }
            }
            patch {
                call.noStore()
                if (!call.requireTrustedWrite(config)) return@patch
                if (call.requireIdempotencyKey() == null) return@patch
                val sessionHash = call.sessionHash(config, tokenCodec) ?: return@patch
                val circleId = parseCanonicalUuid(call.parameters["circleId"])
                if (circleId == null) {
                    call.respondError(HttpStatusCode.BadRequest, "INVALID_CIRCLE_ID", "Некорректная связь")
                    return@patch
                }
                val body = call.receive<UpdateSharingRequest>()
                val sharingMode = runCatching { SharingMode.valueOf(body.sharingMode) }.getOrNull()
                if (sharingMode == null) {
                    call.respondError(
                        HttpStatusCode.BadRequest,
                        "INVALID_SHARING_MODE",
                        "Некорректная настройка показа",
                    )
                    return@patch
                }
                when (val result = repository.updateSharing(sessionHash, circleId, sharingMode)) {
                    is RelationshipResult.Success -> call.respond(result.value.toDto())
                    else -> call.respondRelationshipError(result)
                }
            }
        }

        delete("/api/v1/people/{circleId}") {
            call.noStore()
            if (!call.requireTrustedWrite(config)) return@delete
            if (call.requireIdempotencyKey() == null) return@delete
            val sessionHash = call.sessionHash(config, tokenCodec) ?: return@delete
            val circleId = parseCanonicalUuid(call.parameters["circleId"])
            if (circleId == null) {
                call.respondError(HttpStatusCode.BadRequest, "INVALID_CIRCLE_ID", "Некорректная связь")
                return@delete
            }
            when (val result = repository.removePerson(sessionHash, circleId)) {
                is RelationshipResult.Success -> call.respond(HttpStatusCode.NoContent)
                else -> call.respondRelationshipError(result)
            }
        }
    }
}

private fun Route.requestActionRoute(
    pathAction: String,
    action: RequestAction,
    repository: RelationshipRepository,
    tokenCodec: TokenCodec,
    config: AppConfig,
) {
    post("/api/v1/direct-requests/{requestId}/$pathAction") {
        call.noStore()
        if (!call.requireTrustedWrite(config)) return@post
        if (call.requireIdempotencyKey() == null) return@post
        val sessionHash = call.sessionHash(config, tokenCodec) ?: return@post
        val requestId = parseCanonicalUuid(call.parameters["requestId"])
        if (requestId == null) {
            call.respondError(HttpStatusCode.BadRequest, "INVALID_REQUEST_ID", "Некорректная заявка")
            return@post
        }
        when (val result = repository.actOnRequest(sessionHash, requestId, action)) {
            is RelationshipResult.Success -> call.respond(result.value.toDto())
            else -> call.respondRelationshipError(result)
        }
    }
}

private fun ApplicationCall.noStore() {
    response.header(HttpHeaders.CacheControl, "no-store")
}

private suspend fun ApplicationCall.sessionHash(
    config: AppConfig,
    tokenCodec: TokenCodec,
): ByteArray? {
    val rawToken = sessionCookie(config)
    if (rawToken == null) {
        respondError(HttpStatusCode.Unauthorized, "UNAUTHORIZED", "Сессия не найдена")
        return null
    }
    return tokenCodec.hash(rawToken)
}

private suspend fun ApplicationCall.requireTrustedWrite(config: AppConfig): Boolean {
    if (isTrustedWrite(config)) return true
    respondError(HttpStatusCode.Forbidden, "UNTRUSTED_ORIGIN", "Источник запроса не разрешён")
    return false
}

private suspend fun ApplicationCall.requireIdempotencyKey(): UUID? {
    val key = parseCanonicalUuidV4(request.headers["Idempotency-Key"])
    if (key == null) {
        respondError(
            HttpStatusCode.BadRequest,
            "INVALID_IDEMPOTENCY_KEY",
            "Некорректный ключ запроса",
        )
    }
    return key
}

private suspend fun ApplicationCall.respondRelationshipError(result: RelationshipResult<*>) {
    when (result) {
        RelationshipResult.Unauthorized -> respondError(
            HttpStatusCode.Unauthorized,
            "UNAUTHORIZED",
            "Сессия не найдена",
        )
        RelationshipResult.NotFound -> respondError(
            HttpStatusCode.NotFound,
            "NOT_FOUND",
            "Объект не найден",
        )
        RelationshipResult.Self -> respondError(
            HttpStatusCode.Conflict,
            "CANNOT_ADD_SELF",
            "Это ваш ID 😄",
        )
        RelationshipResult.AlreadyConnected -> respondError(
            HttpStatusCode.Conflict,
            "ALREADY_CONNECTED",
            "Вы уже на связи с этим человеком",
        )
        RelationshipResult.Forbidden -> respondError(
            HttpStatusCode.Forbidden,
            "FORBIDDEN",
            "Действие недоступно",
        )
        RelationshipResult.Expired -> respondError(
            HttpStatusCode.Conflict,
            "DIRECT_REQUEST_EXPIRED",
            "Срок заявки истёк",
        )
        RelationshipResult.Conflict -> respondError(
            HttpStatusCode.Conflict,
            "RELATIONSHIP_CONFLICT",
            "Состояние уже изменилось",
        )
        is RelationshipResult.Success -> error("Success is not an error")
    }
}

private suspend fun ApplicationCall.respondError(
    status: HttpStatusCode,
    code: String,
    message: String,
) {
    respond(status, ApiErrorResponse(code, message))
}

private fun UserReference.toDto() = PublicUserDto(publicId = publicId, displayName = displayName)

private fun UserLookupSnapshot.toDto() = UserLookupResponse(
    user = user.toDto(),
    relationshipState = relationshipState.name,
    serverTime = serverTime.toInstant().toString(),
)

private fun DirectRequestSnapshot.toDto() = DirectRequestDto(
    requestId = requestId.toString(),
    direction = direction.name,
    user = user.toDto(),
    createdAt = createdAt.toInstant().toString(),
    expiresAt = expiresAt.toInstant().toString(),
)

private fun PersonSnapshot.toDto() = PersonDto(
    circleId = circleId.toString(),
    user = user.toDto(),
    connectedAt = connectedAt.toInstant().toString(),
    mySharingMode = mySharingMode.name,
    theirSharingMode = theirSharingMode.name,
    checkInState = checkInState.name,
    lastCheckInAt = lastCheckInAt?.toInstant()?.toString(),
)

private fun PeopleSnapshot.toDto() = PeopleResponse(
    people = people.map { it.toDto() },
    incomingRequests = incomingRequests.map { it.toDto() },
    outgoingRequests = outgoingRequests.map { it.toDto() },
    audienceCount = audienceCount,
    serverTime = serverTime.toInstant().toString(),
)

private fun DirectRequestMutationSnapshot.toDto() = DirectRequestResponse(
    request = request.toDto(),
    replayed = replayed,
    serverTime = serverTime.toInstant().toString(),
)

private fun DirectRequestActionSnapshot.toDto() = DirectRequestActionResponse(
    requestId = requestId.toString(),
    status = status.name,
    person = person?.toDto(),
    replayed = replayed,
    serverTime = serverTime.toInstant().toString(),
)

private fun SharingSnapshot.toDto() = SharingResponse(
    circleId = circleId.toString(),
    sharingMode = sharingMode.name,
    serverTime = serverTime.toInstant().toString(),
)
