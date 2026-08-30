package ru.zhiv.identity

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
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.BootstrapRequest
import ru.zhiv.http.DailyStreakDto
import ru.zhiv.http.DisplayNameCooldownResponse
import ru.zhiv.http.MeResponse
import ru.zhiv.http.ProfileStateDto
import ru.zhiv.http.PublicUserDto
import ru.zhiv.http.UpdateDisplayNameRequest
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.sessionCookie
import ru.zhiv.http.sessionCookieHeader
import ru.zhiv.security.TokenCodec
import java.time.Duration

fun Route.identityRoutes(
    repository: IdentityRepository,
    tokenCodec: TokenCodec,
    config: AppConfig,
) {
    rateLimit(RateLimitName("bootstrap")) {
        route("/api/v1/bootstrap") {
            install(RequestBodyLimit) {
                bodyLimit { 2_048 }
            }
            post {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
                    return@post
                }

                val bootstrapKey = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
                if (bootstrapKey == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"),
                    )
                    return@post
                }

                val currentToken = call.sessionCookie(config)
                val currentUser = currentToken?.let { repository.findBySession(tokenCodec.hash(it)) }
                if (currentUser != null) {
                    call.respond(currentUser.toResponse())
                    return@post
                }

                val request = call.receive<BootstrapRequest>()
                val displayName = validDisplayName(request.displayName)
                if (displayName == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_DISPLAY_NAME", "Введите имя длиной до 50 символов"),
                    )
                    return@post
                }

                val token = tokenCodec.issue()
                val user = try {
                    repository.bootstrap(
                        displayName = displayName,
                        bootstrapKeyHash = tokenCodec.hash(bootstrapKey.toString()),
                        sessionTokenHash = token.hash,
                        sessionLifetimeDays = config.sessionDays,
                    )
                } catch (_: BootstrapKeyExpiredException) {
                    call.respond(
                        HttpStatusCode.Conflict,
                        ApiErrorResponse("BOOTSTRAP_KEY_EXPIRED", "Повторите создание профиля"),
                    )
                    return@post
                }
                call.response.header(HttpHeaders.SetCookie, sessionCookieHeader(config, token.raw))
                call.respond(HttpStatusCode.Created, user.toResponse())
            }
        }
    }

    get("/api/v1/me") {
        call.response.header(HttpHeaders.CacheControl, "no-store")
        val rawToken = call.sessionCookie(config)
        val user = rawToken?.let { repository.findBySession(tokenCodec.hash(it)) }
        if (user == null) {
            call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
            return@get
        }
        call.respond(user.toResponse())
    }

    rateLimit(RateLimitName("relationships")) {
        route("/api/v1/me") {
            install(RequestBodyLimit) {
                bodyLimit { 2_048 }
            }
            patch {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                if (!call.isTrustedWrite(config)) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"),
                    )
                    return@patch
                }

                val idempotencyKey = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
                if (idempotencyKey == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"),
                    )
                    return@patch
                }

                val request = call.receive<UpdateDisplayNameRequest>()
                val displayName = validDisplayName(request.displayName)
                if (displayName == null) {
                    call.respond(
                        HttpStatusCode.BadRequest,
                        ApiErrorResponse("INVALID_DISPLAY_NAME", "Введите имя длиной до 50 символов"),
                    )
                    return@patch
                }

                val rawToken = call.sessionCookie(config)
                if (rawToken == null) {
                    call.respond(
                        HttpStatusCode.Unauthorized,
                        ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"),
                    )
                    return@patch
                }

                when (
                    val result = repository.updateDisplayName(
                        tokenCodec.hash(rawToken),
                        displayName,
                        idempotencyKey,
                    )
                ) {
                    DisplayNameUpdateResult.Unauthorized -> call.respond(
                        HttpStatusCode.Unauthorized,
                        ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"),
                    )

                    DisplayNameUpdateResult.IdempotencyConflict -> call.respond(
                        HttpStatusCode.Conflict,
                        ApiErrorResponse(
                            "IDEMPOTENCY_CONFLICT",
                            "Ключ уже использован для другого имени",
                        ),
                    )

                    is DisplayNameUpdateResult.Cooldown -> {
                        val remainingMillis = Duration.between(
                            result.serverTime,
                            result.availableAt,
                        ).toMillis().coerceAtLeast(1)
                        call.response.header(
                            HttpHeaders.RetryAfter,
                            ((remainingMillis + 999) / 1_000).coerceAtLeast(1).toString(),
                        )
                        call.respond(
                            HttpStatusCode.TooManyRequests,
                            DisplayNameCooldownResponse(
                                availableAt = result.availableAt.toInstant().toString(),
                                serverTime = result.serverTime.toInstant().toString(),
                            ),
                        )
                    }

                    is DisplayNameUpdateResult.Success -> call.respond(result.user.toResponse())
                }
            }
        }
    }
}

private fun UserSnapshot.toResponse() = MeResponse(
    user = PublicUserDto(publicId = publicId, displayName = displayName),
    lastCheckInAt = lastCheckInAt?.toInstant()?.toString(),
    checkInCount = checkInCount,
    streak = DailyStreakDto(
        currentDays = streak.currentDays,
        longestDays = streak.longestDays,
        isActive = streak.isActive,
        renewBy = streak.renewBy?.toInstant()?.toString(),
    ),
    profile = ProfileStateDto(
        avatarUrl = null,
        displayNameChangedAt = displayNameChangedAt?.toInstant()?.toString(),
        displayNameChangeAvailableAt = displayNameChangeAvailableAt?.toInstant()?.toString(),
    ),
    serverTime = serverTime.toInstant().toString(),
)

private fun validDisplayName(raw: String): String? {
    if (raw.any(Char::isISOControl)) return null
    val normalized = raw
        .trim { it.isWhitespace() || Character.isSpaceChar(it) }
        .replace(Regex("[\\s\\p{Z}]+"), " ")
    val codePoints = normalized.codePointCount(0, normalized.length)
    return normalized.takeIf {
        codePoints in 1..50
    }
}
