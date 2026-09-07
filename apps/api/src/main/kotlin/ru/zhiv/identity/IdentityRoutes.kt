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
import io.ktor.server.routing.put
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.BootstrapRequest
import ru.zhiv.http.DailyStreakDto
import ru.zhiv.http.DisplayNameCooldownResponse
import ru.zhiv.http.MeResponse
import ru.zhiv.http.ProfileStateDto
import ru.zhiv.http.PublicUserDto
import ru.zhiv.http.UpdateDisplayNameRequest
import ru.zhiv.http.UpdateStatusRequest
import ru.zhiv.http.UserStatusDto
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
    allowLegacyBootstrap: Boolean = true,
) {
    rateLimit(RateLimitName("relationships")) {
        route("/api/v1/me/time-zone") {
            install(RequestBodyLimit) { bodyLimit { 2_048 } }
            patch {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                if (!call.isTrustedWrite(config)) {
                    call.respond(HttpStatusCode.Forbidden, ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"))
                    return@patch
                }
                val rawToken = call.sessionCookie(config)
                if (rawToken == null) {
                    call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                    return@patch
                }
                val key = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
                if (key == null) {
                    call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"))
                    return@patch
                }
                val body = call.receive<ru.zhiv.http.UpdateTimeZoneRequest>()
                val timeZone = validTimeZone(body.timeZone)
                if (timeZone == null) {
                    call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_TIME_ZONE", "Выберите часовой пояс из списка"))
                    return@patch
                }
                when (val result = repository.updateTimeZone(tokenCodec.hash(rawToken), timeZone, key)) {
                    is TimeZoneUpdateResult.Success -> call.respond(result.user.toResponse())
                    TimeZoneUpdateResult.Unauthorized -> call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                    TimeZoneUpdateResult.Invalid -> call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_TIME_ZONE", "Выберите часовой пояс из списка"))
                    TimeZoneUpdateResult.IdempotencyConflict -> call.respond(HttpStatusCode.Conflict, ApiErrorResponse("IDEMPOTENCY_CONFLICT", "Ключ уже использован для другого часового пояса"))
                }
            }
        }
    }
    rateLimit(RateLimitName("relationships")) {
        route("/api/v1/me/status") {
            install(RequestBodyLimit) { bodyLimit { 2_048 } }
            put {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                if (!call.isTrustedWrite(config)) {
                    call.respond(HttpStatusCode.Forbidden, ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"))
                    return@put
                }
                val rawToken = call.sessionCookie(config)
                if (rawToken == null) {
                    call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                    return@put
                }
                val key = parseCanonicalUuidV4(call.request.headers["Idempotency-Key"])
                if (key == null) {
                    call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"))
                    return@put
                }
                val body = call.receive<UpdateStatusRequest>()
                val text = validStatus(body.text)
                // Preserve the JSON token type: the default Int decoder also accepts quoted numbers.
                val rawDuration = body.expiresInMinutes?.takeUnless { it == JsonNull }
                val duration = (rawDuration as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
                if (rawDuration != null && (duration == null || duration !in setOf(60, 120, 240, 480, 1440))) {
                    call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_STATUS_DURATION", "Выберите срок из списка"))
                    return@put
                }
                if (text == null) {
                    call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_STATUS", "До 120 символов, без управляющих символов"))
                    return@put
                }
                when (val result = repository.updateStatus(tokenCodec.hash(rawToken), text, key, duration)) {
                    is DisplayNameUpdateResult.Success -> call.respond(result.user.toResponse())
                    DisplayNameUpdateResult.Unauthorized -> call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
                    else -> call.respond(HttpStatusCode.Conflict, ApiErrorResponse("IDEMPOTENCY_CONFLICT", "Повторите сохранение"))
                }
            }
        }
    }
    rateLimit(RateLimitName("bootstrap")) {
        route("/api/v1/bootstrap") {
            install(RequestBodyLimit) {
                bodyLimit { 2_048 }
            }
            post {
                call.response.header(HttpHeaders.CacheControl, "no-store")
                if (!allowLegacyBootstrap) {
                    call.respond(
                        HttpStatusCode.Gone,
                        ApiErrorResponse("AUTH_REQUIRED", "Обновите приложение и войдите через доступный способ входа"),
                    )
                    return@post
                }
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

                val timeZone = validTimeZone(request.timeZone)
                if (timeZone == null) {
                    call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_TIME_ZONE", "Выберите часовой пояс из списка"))
                    return@post
                }
                val token = tokenCodec.issue()
                val user = try {
                    repository.bootstrap(
                        displayName = displayName,
                        bootstrapKeyHash = tokenCodec.hash(bootstrapKey.toString()),
                        sessionTokenHash = token.hash,
                        sessionLifetimeDays = config.sessionDays,
                        timeZone = timeZone,
                    )
                } catch (_: InvalidTimeZoneException) {
                    call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_TIME_ZONE", "Выберите часовой пояс из списка"))
                    return@post
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

    rateLimit(RateLimitName("profile-read")) {
    get("/api/v1/me/calendar") {
        call.response.header(HttpHeaders.CacheControl, "no-store")
        val values = call.request.queryParameters.getAll("month")
        val month = values?.singleOrNull()?.let(::parseCalendarMonth)
        if (values != null && (values.size != 1 || month == null)) {
            call.respond(HttpStatusCode.BadRequest, ApiErrorResponse("INVALID_MONTH", "Укажите месяц в формате ГГГГ-ММ"))
            return@get
        }
        val token = call.sessionCookie(config)
        val calendar = token?.let { repository.calendar(tokenCodec.hash(it), month) }
        if (calendar == null) {
            call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
            return@get
        }
        call.respond(ru.zhiv.http.CheckInCalendarResponse(
            month = calendar.month.toString(), today = calendar.today.toString(),
            timeZone = calendar.timeZone, firstMonth = calendar.firstMonth.toString(),
            days = calendar.days.map { ru.zhiv.http.CalendarDayDto(it.date.toString(), it.count) },
            serverTime = calendar.serverTime.toInstant().toString(),
            nextDayAt = calendar.nextDayAt.toInstant().toString(),
            lastMonth = calendar.lastMonth.toString(),
        ))
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

internal fun UserSnapshot.toResponse() = MeResponse(
    status = statusText?.let { text -> statusUpdatedAt?.let { UserStatusDto(text, it.toInstant().toString(), statusExpiresAt?.toInstant()?.toString()) } },
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
        timeZone = timeZone,
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

internal fun validStatus(raw: String): String? {
    if (raw.any { it.isISOControl() || it in '\u202a'..'\u202e' || it in '\u2066'..'\u2069' }) return null
    val text = raw.trim { it.isWhitespace() || Character.isSpaceChar(it) }.replace(Regex("[\\s\\p{Z}]+"), " ")
    return text.takeIf { it.codePointCount(0, it.length) <= 120 }
}
