package ru.zhiv.groups

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
import ru.zhiv.http.CreateGroupInviteRequest
import ru.zhiv.http.CreateGroupRequest
import ru.zhiv.http.GroupDto
import ru.zhiv.http.GroupInviteDto
import ru.zhiv.http.GroupMemberDto
import ru.zhiv.http.GroupMutationResponse
import ru.zhiv.http.GroupsResponse
import ru.zhiv.http.PublicUserDto
import ru.zhiv.http.UpdateGroupRequest
import ru.zhiv.http.UpdateSharingRequest
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuid
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.relationships.SharingMode
import ru.zhiv.relationships.UserReference
import ru.zhiv.security.TokenCodec
import java.util.UUID

fun Route.groupRoutes(
    repository: GroupRepository,
    tokenCodec: TokenCodec,
    config: AppConfig,
) {
    rateLimit(RateLimitName("relationships")) {
        route("/api/v1/groups") {
            install(RequestBodyLimit) { bodyLimit { 2_048 } }

            get {
                call.noStore()
                val sessionHash = call.sessionHash(config, tokenCodec) ?: return@get
                when (val result = repository.listGroups(sessionHash)) {
                    is GroupResult.Success -> call.respond(result.value.toDto())
                    else -> call.respondGroupError(result)
                }
            }

            post {
                call.noStore()
                if (!call.requireTrustedWrite(config)) return@post
                val idempotencyKey = call.requireIdempotencyKey() ?: return@post
                val sessionHash = call.sessionHash(config, tokenCodec) ?: return@post
                val body = call.receive<CreateGroupRequest>()
                val title = body.title.trim().replace(Regex("\\s+"), " ")
                val emoji = body.emoji?.trim()?.ifEmpty { null }
                if (!validTitle(title) || !validEmoji(emoji) || body.inviteeCircleIds.size > 20) {
                    call.respondError(
                        HttpStatusCode.BadRequest,
                        "INVALID_GROUP",
                        "Проверьте название и выбранных людей",
                    )
                    return@post
                }
                val inviteeCircleIds = body.inviteeCircleIds.mapNotNull(::parseCanonicalUuid)
                if (inviteeCircleIds.size != body.inviteeCircleIds.size) {
                    call.respondError(
                        HttpStatusCode.BadRequest,
                        "INVALID_GROUP",
                        "Некорректный человек в приглашениях",
                    )
                    return@post
                }
                when (
                    val result = repository.createGroup(
                        sessionHash,
                        title,
                        emoji,
                        inviteeCircleIds.distinct(),
                        idempotencyKey,
                    )
                ) {
                    is GroupResult.Success -> call.respond(
                        if (result.value.replayed) HttpStatusCode.OK else HttpStatusCode.Created,
                        result.value.toDto(),
                    )
                    else -> call.respondGroupError(result)
                }
            }
        }

        route("/api/v1/groups/{groupId}") {
            install(RequestBodyLimit) { bodyLimit { 1_024 } }

            patch {
                call.noStore()
                if (!call.requireTrustedWrite(config)) return@patch
                if (call.requireIdempotencyKey() == null) return@patch
                val sessionHash = call.sessionHash(config, tokenCodec) ?: return@patch
                val groupId = call.groupId() ?: return@patch
                val body = call.receive<UpdateGroupRequest>()
                val title = body.title.trim().replace(Regex("\\s+"), " ")
                val emoji = body.emoji?.trim()?.ifEmpty { null }
                if (!validTitle(title) || !validEmoji(emoji)) {
                    call.respondError(HttpStatusCode.BadRequest, "INVALID_GROUP", "Проверьте название группы")
                    return@patch
                }
                when (val result = repository.updateGroup(sessionHash, groupId, title, emoji)) {
                    is GroupResult.Success -> call.respond(result.value.toDto())
                    else -> call.respondGroupError(result)
                }
            }

            delete {
                call.noStore()
                if (!call.requireTrustedWrite(config)) return@delete
                if (call.requireIdempotencyKey() == null) return@delete
                val sessionHash = call.sessionHash(config, tokenCodec) ?: return@delete
                val groupId = call.groupId() ?: return@delete
                when (val result = repository.archiveGroup(sessionHash, groupId)) {
                    is GroupResult.Success -> call.respond(HttpStatusCode.NoContent)
                    else -> call.respondGroupError(result)
                }
            }
        }

        route("/api/v1/groups/{groupId}/sharing") {
            install(RequestBodyLimit) { bodyLimit { 1_024 } }
            patch {
                call.noStore()
                if (!call.requireTrustedWrite(config)) return@patch
                if (call.requireIdempotencyKey() == null) return@patch
                val sessionHash = call.sessionHash(config, tokenCodec) ?: return@patch
                val groupId = call.groupId() ?: return@patch
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
                when (val result = repository.updateSharing(sessionHash, groupId, sharingMode)) {
                    is GroupResult.Success -> call.respond(result.value.toDto())
                    else -> call.respondGroupError(result)
                }
            }
        }

        route("/api/v1/groups/{groupId}/invites") {
            install(RequestBodyLimit) { bodyLimit { 1_024 } }
            post {
                call.noStore()
                if (!call.requireTrustedWrite(config)) return@post
                val idempotencyKey = call.requireIdempotencyKey() ?: return@post
                val sessionHash = call.sessionHash(config, tokenCodec) ?: return@post
                val groupId = call.groupId() ?: return@post
                val body = call.receive<CreateGroupInviteRequest>()
                val personCircleId = parseCanonicalUuid(body.personCircleId)
                if (personCircleId == null) {
                    call.respondError(
                        HttpStatusCode.BadRequest,
                        "INVALID_GROUP_INVITE",
                        "Некорректный человек",
                    )
                    return@post
                }
                when (
                    val result = repository.inviteMember(
                        sessionHash,
                        groupId,
                        personCircleId,
                        idempotencyKey,
                    )
                ) {
                    is GroupResult.Success -> call.respond(
                        if (result.value.replayed) HttpStatusCode.OK else HttpStatusCode.Created,
                        result.value.toDto(),
                    )
                    else -> call.respondGroupError(result)
                }
            }
        }

        delete("/api/v1/groups/{groupId}/invites/{inviteId}") {
            call.noStore()
            if (!call.requireTrustedWrite(config)) return@delete
            if (call.requireIdempotencyKey() == null) return@delete
            val sessionHash = call.sessionHash(config, tokenCodec) ?: return@delete
            val groupId = call.groupId() ?: return@delete
            val inviteId = parseCanonicalUuid(call.parameters["inviteId"])
            if (inviteId == null) {
                call.respondError(HttpStatusCode.BadRequest, "INVALID_GROUP_INVITE", "Некорректное приглашение")
                return@delete
            }
            when (val result = repository.revokeInvite(sessionHash, groupId, inviteId)) {
                is GroupResult.Success -> call.respond(HttpStatusCode.NoContent)
                else -> call.respondGroupError(result)
            }
        }

        delete("/api/v1/groups/{groupId}/members/{membershipId}") {
            call.noStore()
            if (!call.requireTrustedWrite(config)) return@delete
            if (call.requireIdempotencyKey() == null) return@delete
            val sessionHash = call.sessionHash(config, tokenCodec) ?: return@delete
            val groupId = call.groupId() ?: return@delete
            val membershipId = parseCanonicalUuid(call.parameters["membershipId"])
            if (membershipId == null) {
                call.respondError(HttpStatusCode.BadRequest, "INVALID_GROUP_MEMBER", "Некорректный участник")
                return@delete
            }
            when (val result = repository.removeMember(sessionHash, groupId, membershipId)) {
                is GroupResult.Success -> call.respond(HttpStatusCode.NoContent)
                else -> call.respondGroupError(result)
            }
        }

        groupInviteActionRoute("accept", GroupInviteAction.ACCEPTED, repository, tokenCodec, config)
        groupInviteActionRoute("reject", GroupInviteAction.REVOKED, repository, tokenCodec, config)
    }
}

private fun Route.groupInviteActionRoute(
    pathAction: String,
    action: GroupInviteAction,
    repository: GroupRepository,
    tokenCodec: TokenCodec,
    config: AppConfig,
) {
    post("/api/v1/group-invites/{inviteId}/$pathAction") {
        call.noStore()
        if (!call.requireTrustedWrite(config)) return@post
        if (call.requireIdempotencyKey() == null) return@post
        val sessionHash = call.sessionHash(config, tokenCodec) ?: return@post
        val inviteId = parseCanonicalUuid(call.parameters["inviteId"])
        if (inviteId == null) {
            call.respondError(HttpStatusCode.BadRequest, "INVALID_GROUP_INVITE", "Некорректное приглашение")
            return@post
        }
        when (val result = repository.actOnInvite(sessionHash, inviteId, action)) {
            is GroupResult.Success -> call.respond(result.value.toDto())
            else -> call.respondGroupError(result)
        }
    }
}

private fun validTitle(title: String): Boolean =
    title.codePointCount(0, title.length) in 1..64 && title.none(Char::isISOControl)

private fun validEmoji(emoji: String?): Boolean = emoji == null || (
    emoji.codePointCount(0, emoji.length) <= 16 && emoji.none(Char::isISOControl)
)

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
        respondError(HttpStatusCode.BadRequest, "INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса")
    }
    return key
}

private suspend fun ApplicationCall.groupId(): UUID? {
    val id = parseCanonicalUuid(parameters["groupId"])
    if (id == null) respondError(HttpStatusCode.BadRequest, "INVALID_GROUP_ID", "Некорректная группа")
    return id
}

private suspend fun ApplicationCall.respondGroupError(result: GroupResult<*>) {
    when (result) {
        GroupResult.Unauthorized -> respondError(HttpStatusCode.Unauthorized, "UNAUTHORIZED", "Сессия не найдена")
        GroupResult.NotFound -> respondError(HttpStatusCode.NotFound, "GROUP_NOT_FOUND", "Группа не найдена")
        GroupResult.Forbidden -> respondError(HttpStatusCode.Forbidden, "GROUP_FORBIDDEN", "Действие недоступно")
        GroupResult.Conflict -> respondError(HttpStatusCode.Conflict, "GROUP_CONFLICT", "Состояние уже изменилось")
        GroupResult.Expired -> respondError(HttpStatusCode.Conflict, "GROUP_INVITE_EXPIRED", "Срок приглашения истёк")
        is GroupResult.Success -> error("Success is not an error")
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

private fun GroupMemberSnapshot.toDto() = GroupMemberDto(
    membershipId = membershipId.toString(),
    user = user.toDto(),
    role = role.name,
    sharingMode = sharingMode.name,
    lastCheckInAt = lastCheckInAt?.toInstant()?.toString(),
    joinedAt = joinedAt.toInstant().toString(),
    isMe = isMe,
)

private fun GroupInviteSnapshot.toDto() = GroupInviteDto(
    inviteId = inviteId.toString(),
    direction = direction.name,
    groupId = groupId.toString(),
    groupTitle = groupTitle,
    groupEmoji = groupEmoji,
    user = user.toDto(),
    createdAt = createdAt.toInstant().toString(),
    expiresAt = expiresAt.toInstant().toString(),
)

private fun GroupSnapshot.toDto() = GroupDto(
    groupId = groupId.toString(),
    title = title,
    emoji = emoji,
    myRole = myRole.name,
    mySharingMode = mySharingMode.name,
    createdAt = createdAt.toInstant().toString(),
    members = members.map { it.toDto() },
    pendingInvites = pendingInvites.map { it.toDto() },
)

private fun GroupsSnapshot.toDto() = GroupsResponse(
    groups = groups.map { it.toDto() },
    incomingInvites = incomingInvites.map { it.toDto() },
    outgoingInvites = outgoingInvites.map { it.toDto() },
    serverTime = serverTime.toInstant().toString(),
)

private fun GroupMutationSnapshot.toDto() = GroupMutationResponse(
    groupId = groupId.toString(),
    replayed = replayed,
    serverTime = serverTime.toInstant().toString(),
)
