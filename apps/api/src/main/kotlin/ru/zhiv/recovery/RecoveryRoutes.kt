package ru.zhiv.recovery

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
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.CapabilityTokenRequest
import ru.zhiv.http.ConfirmRecoveryApprovalRequest
import ru.zhiv.http.CreateRecoveryAttemptRequest
import ru.zhiv.http.CreateRecoveryContactRequest
import ru.zhiv.http.DailyStreakDto
import ru.zhiv.http.MeResponse
import ru.zhiv.http.ProfileStateDto
import ru.zhiv.http.PublicUserDto
import ru.zhiv.http.RecoveryApprovalCandidateDto
import ru.zhiv.http.RecoveryApprovalPreviewResponse
import ru.zhiv.http.RecoveryAttemptResponse
import ru.zhiv.http.RecoveryContactDto
import ru.zhiv.http.RecoveryContactsResponse
import ru.zhiv.http.RecoveryEligibleDto
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuid
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.http.sessionCookieHeader
import ru.zhiv.identity.UserSnapshot
import ru.zhiv.security.TokenCodec
import java.security.MessageDigest
import java.time.Duration
import java.util.Base64
import java.util.UUID

private const val DEVELOPMENT_RECOVERY_COOKIE_NAME = "zhiv_recovery"
private const val DEVELOPMENT_RECOVERY_COOKIE_PATH = "/api/v1/account-recovery"
private const val PRODUCTION_RECOVERY_COOKIE_NAME = "__Host-zhiv_recovery"
private const val PRODUCTION_RECOVERY_COOKIE_PATH = "/"
private const val RECOVERY_COOKIE_TTL_SECONDS = 10 * 60
private val recoveryCapability = Regex("^[A-Za-z0-9_-]{43}$")

fun Route.recoveryRoutes(repository: RecoveryRepository, tokenCodec: TokenCodec, config: AppConfig) {
    rateLimit(RateLimitName("relationships")) {
        route("/api/v1/recovery-contacts") {
            install(RequestBodyLimit) { bodyLimit { 2_048 } }

            get {
                call.noStore()
                val session = call.sessionCookie(config)
                if (session == null) {
                    call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                    return@get
                }
                when (val result = repository.list(tokenCodec.hash(session))) {
                    is RecoveryResult.Success -> call.respond(result.value.toDto())
                    else -> call.respondRecoveryError(result)
                }
            }

            post {
                call.noStore()
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
                    return@post
                }
                val key = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
                val session = call.sessionCookie(config)
                val body = call.receive<CreateRecoveryContactRequest>()
                val circleId = parseCanonicalUuid(body.circleId)
                if (key == null || circleId == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_RECOVERY_CONTACT", "Некорректный доверенный контакт"),
                    )
                    return@post
                }
                if (session == null) {
                    call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                    return@post
                }
                when (val result = repository.add(tokenCodec.hash(session), circleId, key)) {
                    is RecoveryResult.Success -> call.respond(HttpStatusCode.Created, result.value.toDto())
                    else -> call.respondRecoveryError(result)
                }
            }

            delete("/{contactId}") {
                call.noStore()
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
                    return@delete
                }
                val key = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
                val contactId = parseCanonicalUuid(call.parameters["contactId"])
                val session = call.sessionCookie(config)
                if (key == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"),
                    )
                    return@delete
                }
                if (contactId == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_RECOVERY_CONTACT", "Некорректный доверенный контакт"),
                    )
                    return@delete
                }
                if (session == null) {
                    call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                    return@delete
                }
                when (val result = repository.remove(tokenCodec.hash(session), contactId, key)) {
                    is RecoveryResult.Success -> call.respond(result.value.toDto())
                    else -> call.respondRecoveryError(result)
                }
            }
        }
    }

    route("/api/v1/account-recovery") {
        install(RequestBodyLimit) { bodyLimit { 2_048 } }

        rateLimit(RateLimitName("account-recovery-write")) {
            post("/attempts") {
                call.noStore()
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
                    return@post
                }
                val key = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
                val body = call.receive<CreateRecoveryAttemptRequest>()
                if (key == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"),
                    )
                    return@post
                }
                if (!recoveryCapability.matches(body.token)) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_RECOVERY_ATTEMPT", "Некорректный запрос восстановления"),
                    )
                    return@post
                }

                val claimRaw = deriveRecoveryClaim(body.token, key)
                val initiatingSessionHash = call.sessionCookie(config)?.let(tokenCodec::hash)
                when (
                    val result = repository.createAttempt(
                        tokenCodec.hash(body.token),
                        tokenCodec.hash(claimRaw),
                        key,
                        initiatingSessionHash,
                    )
                ) {
                    is RecoveryResult.Success -> {
                        call.response.header(
                            HttpHeaders.SetCookie,
                            recoveryCookieHeader(
                                config,
                                claimRaw,
                                Duration.between(result.value.serverTime, result.value.expiresAt)
                                    .seconds.coerceIn(1, RECOVERY_COOKIE_TTL_SECONDS.toLong()),
                            ),
                        )
                        call.respond(
                            if (result.value.replayed) HttpStatusCode.OK else HttpStatusCode.Created,
                            result.value.toDto(),
                        )
                    }
                    else -> call.respondRecoveryError(result)
                }
            }

            delete("/attempts/current") {
                call.noStore()
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
                    return@delete
                }
                val rawClaim = call.recoveryCookie(config)
                if (rawClaim == null || !recoveryCapability.matches(rawClaim)) {
                    call.response.header(HttpHeaders.SetCookie, clearRecoveryCookieHeader(config))
                    call.respond(HttpStatusCode.NoContent)
                    return@delete
                }
                when (val result = repository.cancelAttempt(tokenCodec.hash(rawClaim))) {
                    is RecoveryResult.Success, RecoveryResult.NotFound, RecoveryResult.Expired -> {
                        call.response.header(HttpHeaders.SetCookie, clearRecoveryCookieHeader(config))
                        call.respond(HttpStatusCode.NoContent)
                    }
                    else -> call.respondRecoveryError(result)
                }
            }

            post("/attempts/current/complete") {
                call.noStore()
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
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
                val rawClaim = call.recoveryCookie(config)
                if (rawClaim == null || !recoveryCapability.matches(rawClaim)) {
                    call.respond(
                        HttpStatusCode.Unauthorized,
                        ApiErrorResponse("RECOVERY_CLAIM_REQUIRED", "Запрос восстановления не найден в этом браузере"),
                    )
                    return@post
                }
                when (
                    val result = repository.completeAttempt(
                        tokenCodec.hash(rawClaim),
                        key,
                        config.sessionDays,
                    )
                ) {
                    is RecoveryResult.Success -> {
                        call.response.header(HttpHeaders.SetCookie, sessionCookieHeader(config, rawClaim))
                        call.response.header(HttpHeaders.SetCookie, clearRecoveryCookieHeader(config))
                        call.respond(result.value.user.toDto())
                    }
                    else -> call.respondRecoveryError(result)
                }
            }

            post("/approval/preview") {
                call.noStore()
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
                    return@post
                }
                val session = call.sessionCookie(config)
                val body = call.receive<CapabilityTokenRequest>()
                if (session == null) {
                    call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                    return@post
                }
                if (!recoveryCapability.matches(body.token)) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_RECOVERY_ATTEMPT", "Некорректный запрос восстановления"),
                    )
                    return@post
                }
                when (val result = repository.previewApproval(tokenCodec.hash(session), tokenCodec.hash(body.token))) {
                    is RecoveryResult.Success -> call.respond(result.value.toDto())
                    else -> call.respondRecoveryError(result)
                }
            }

            post("/approval/confirm") {
                call.noStore()
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
                    return@post
                }
                val key = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
                val session = call.sessionCookie(config)
                val body = call.receive<ConfirmRecoveryApprovalRequest>()
                val contactId = parseCanonicalUuid(body.contactId)
                if (key == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"),
                    )
                    return@post
                }
                if (contactId == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_RECOVERY_CONTACT", "Некорректный доверенный контакт"),
                    )
                    return@post
                }
                if (!recoveryCapability.matches(body.token)) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_RECOVERY_ATTEMPT", "Некорректный запрос восстановления"),
                    )
                    return@post
                }
                if (session == null) {
                    call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                    return@post
                }
                when (
                    val result = repository.confirmApproval(
                        tokenCodec.hash(session),
                        tokenCodec.hash(body.token),
                        contactId,
                        key,
                    )
                ) {
                    is RecoveryResult.Success -> call.respond(result.value.toDto())
                    else -> call.respondRecoveryError(result)
                }
            }
        }

        rateLimit(RateLimitName("account-recovery-read")) {
            get("/attempts/current") {
                call.noStore()
                val rawClaim = call.recoveryCookie(config)
                if (rawClaim == null || !recoveryCapability.matches(rawClaim)) {
                    call.respond(
                        HttpStatusCode.Unauthorized,
                        ApiErrorResponse("RECOVERY_CLAIM_REQUIRED", "Запрос восстановления не найден в этом браузере"),
                    )
                    return@get
                }
                when (val result = repository.currentAttempt(tokenCodec.hash(rawClaim))) {
                    is RecoveryResult.Success -> call.respond(result.value.toDto())
                    else -> call.respondRecoveryError(result)
                }
            }
        }
    }
}

private fun ApplicationCall.noStore() = response.header(HttpHeaders.CacheControl, "no-store")
private fun ApplicationCall.recoveryCookie(config: AppConfig): String? =
    request.cookies[recoveryCookieName(config)]

private fun recoveryCookieName(config: AppConfig): String =
    if (config.production) PRODUCTION_RECOVERY_COOKIE_NAME else DEVELOPMENT_RECOVERY_COOKIE_NAME

private fun recoveryCookiePath(config: AppConfig): String =
    if (config.production) PRODUCTION_RECOVERY_COOKIE_PATH else DEVELOPMENT_RECOVERY_COOKIE_PATH

private fun deriveRecoveryClaim(approvalToken: String, key: UUID): String {
    val framed = "zhiv.account-recovery.claim.v1\u0000$approvalToken\u0000$key"
    val digest = MessageDigest.getInstance("SHA-256").digest(framed.toByteArray(Charsets.UTF_8))
    return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
}

private fun recoveryCookieHeader(config: AppConfig, rawToken: String, maxAgeSeconds: Long): String = buildString {
    append(recoveryCookieName(config))
    append('=')
    append(rawToken)
    append("; Max-Age=")
    append(maxAgeSeconds)
    append("; Path=")
    append(recoveryCookiePath(config))
    append("; HttpOnly; SameSite=Strict")
    if (config.production) append("; Secure")
}

private fun clearRecoveryCookieHeader(config: AppConfig): String = buildString {
    append(recoveryCookieName(config))
    append("=; Max-Age=0; Path=")
    append(recoveryCookiePath(config))
    append("; HttpOnly; SameSite=Strict")
    if (config.production) append("; Secure")
}

private suspend fun ApplicationCall.respondRecoveryError(result: RecoveryResult<*>) {
    val error = when (result) {
        RecoveryResult.Unauthorized -> Triple(HttpStatusCode.Unauthorized, "UNAUTHORIZED", "Сессия не найдена")
        RecoveryResult.NotFound -> Triple(HttpStatusCode.NotFound, "RECOVERY_NOT_FOUND", "Восстановление не найдено")
        RecoveryResult.Forbidden -> Triple(
            HttpStatusCode.Forbidden,
            "RECOVERY_FORBIDDEN",
            "Доверенная связь больше не разрешает восстановление",
        )
        RecoveryResult.Expired -> Triple(HttpStatusCode.Gone, "RECOVERY_EXPIRED", "Запрос восстановления истёк")
        RecoveryResult.Conflict -> Triple(
            HttpStatusCode.Conflict,
            "RECOVERY_CONFLICT",
            "Состояние восстановления уже изменилось",
        )
        RecoveryResult.LimitReached -> Triple(
            HttpStatusCode.Conflict,
            "RECOVERY_CONTACT_LIMIT",
            "Можно выбрать не больше трёх доверенных людей",
        )
        is RecoveryResult.Success -> error("success is not an error")
    }
    respond(error.first, ApiErrorResponse(error.second, error.third))
}

private fun RecoveryContactsSnapshot.toDto() = RecoveryContactsResponse(
    contacts.map {
        RecoveryContactDto(
            it.contactId.toString(),
            it.circleId.toString(),
            PublicUserDto(it.user.publicId, it.user.displayName),
        )
    },
    eligible.map {
        RecoveryEligibleDto(
            it.circleId.toString(),
            PublicUserDto(it.user.publicId, it.user.displayName),
        )
    },
    trustedBy.map {
        RecoveryContactDto(
            it.contactId.toString(),
            it.circleId.toString(),
            PublicUserDto(it.user.publicId, it.user.displayName),
        )
    },
    serverTime.toInstant().toString(),
)

private fun RecoveryAttemptSnapshot.toDto() = RecoveryAttemptResponse(
    attemptId.toString(),
    status.name,
    expiresAt.toInstant().toString(),
    target?.let { PublicUserDto(it.publicId, it.displayName) },
    replayed,
    serverTime.toInstant().toString(),
)

private fun RecoveryApprovalPreviewSnapshot.toDto() = RecoveryApprovalPreviewResponse(
    eligible.map {
        RecoveryApprovalCandidateDto(
            it.contactId.toString(),
            PublicUserDto(it.target.publicId, it.target.displayName),
        )
    },
    expiresAt.toInstant().toString(),
    serverTime.toInstant().toString(),
)

private fun UserSnapshot.toDto() = MeResponse(
    PublicUserDto(publicId, displayName),
    lastCheckInAt?.toInstant()?.toString(),
    checkInCount,
    DailyStreakDto(
        streak.currentDays,
        streak.longestDays,
        streak.isActive,
        streak.renewBy?.toInstant()?.toString(),
    ),
    ProfileStateDto(
        null,
        displayNameChangedAt?.toInstant()?.toString(),
        displayNameChangeAvailableAt?.toInstant()?.toString(),
    ),
    serverTime.toInstant().toString(),
)
