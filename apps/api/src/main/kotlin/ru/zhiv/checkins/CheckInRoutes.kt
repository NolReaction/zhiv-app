package ru.zhiv.checkins

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.CheckInResponse
import ru.zhiv.http.CooldownResponse
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.parseCanonicalUuid
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec
import java.time.Duration

fun Route.checkInRoutes(
    repository: CheckInRepository,
    tokenCodec: TokenCodec,
    config: AppConfig,
) {
    post("/api/v1/check-ins") {
        call.response.header(HttpHeaders.CacheControl, "no-store")
        if (!call.isTrustedWrite(config)) {
            call.respond(HttpStatusCode.Forbidden, ApiErrorResponse("UNTRUSTED_ORIGIN", "Источник запроса не разрешён"))
            return@post
        }

        val idempotencyKey = parseCanonicalUuid(call.request.headers["Idempotency-Key"])
        if (idempotencyKey == null) {
            call.respond(
                HttpStatusCode.BadRequest,
                ApiErrorResponse("INVALID_IDEMPOTENCY_KEY", "Некорректный ключ запроса"),
            )
            return@post
        }

        val rawToken = call.sessionCookie(config)
        if (rawToken == null) {
            call.respond(HttpStatusCode.Unauthorized, ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"))
            return@post
        }

        when (val result = repository.record(tokenCodec.hash(rawToken), idempotencyKey)) {
            CheckInResult.Unauthorized -> call.respond(
                HttpStatusCode.Unauthorized,
                ApiErrorResponse("UNAUTHORIZED", "Сессия не найдена"),
            )

            is CheckInResult.Accepted -> call.respond(
                CheckInResponse(
                    eventId = result.eventId.toString(),
                    checkedAt = result.checkedAt.toInstant().toString(),
                    serverTime = result.serverTime.toInstant().toString(),
                    nextAllowedAt = result.nextAllowedAt.toInstant().toString(),
                    replayed = result.replayed,
                ),
            )

            is CheckInResult.Cooldown -> {
                val remainingMillis = Duration.between(result.serverTime, result.nextAllowedAt)
                    .toMillis().coerceAtLeast(1)
                val retryAfter = ((remainingMillis + 999) / 1_000).coerceAtLeast(1)
                call.response.header(HttpHeaders.RetryAfter, retryAfter.toString())
                call.respond(
                    HttpStatusCode.TooManyRequests,
                    CooldownResponse(
                        checkedAt = result.checkedAt.toInstant().toString(),
                        serverTime = result.serverTime.toInstant().toString(),
                        nextAllowedAt = result.nextAllowedAt.toInstant().toString(),
                    ),
                )
            }
        }
    }
}
