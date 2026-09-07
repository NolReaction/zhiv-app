package ru.zhiv.observability

import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.hooks.CallSetup
import io.ktor.server.application.hooks.ResponseSent
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import io.ktor.util.AttributeKey
import org.slf4j.LoggerFactory
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.http.CooldownResponse
import ru.zhiv.http.DisplayNameCooldownResponse
import java.sql.SQLException
import java.util.Collections
import java.util.IdentityHashMap
import java.util.UUID

const val REQUEST_ID_HEADER = "X-Request-ID"
internal const val DIAGNOSTICS_LOGGER = "ru.zhiv.diagnostics"

private class RequestTrace(
    val id: String = UUID.randomUUID().toString(),
    val startedAt: Long = System.nanoTime(),
    var recorded: Boolean = false,
    var responseCode: String? = null,
    var expectedCooldown: Boolean = false,
)

private val traceKey = AttributeKey<RequestTrace>("zhiv.request-diagnostics")
private val logger = LoggerFactory.getLogger(DIAGNOSTICS_LOGGER)

private fun ApplicationCall.trace(): RequestTrace = attributes.getOrNull(traceKey)
    ?: RequestTrace().also { attributes.put(traceKey, it) }

fun ApplicationCall.requestId(): String = trace().id

/** Never trust client correlation headers, which may contain identifiers or log-injection payloads. */
val RequestDiagnostics = createApplicationPlugin("RequestDiagnostics") {
    on(CallSetup) { call ->
        call.response.headers.append(REQUEST_ID_HEADER, call.requestId())
    }
    onCallRespond { call ->
        transformBody { body ->
            when (body) {
                is ApiErrorResponse -> {
                    call.trace().responseCode = safeErrorCode(body.code)
                    body.copy(requestId = call.requestId())
                }
                is CooldownResponse, is DisplayNameCooldownResponse -> {
                    call.trace().expectedCooldown = true
                    body
                }
                else -> body
            }
        }
    }
    on(ResponseSent) { call ->
        val trace = call.trace()
        val status = call.response.status()?.value ?: return@on
        if (trace.recorded || (trace.expectedCooldown && status == 429)) return@on
        // Validation, absent sessions and regular gameplay cooldowns are expected, quiet responses.
        // Ktor's rate limiter has no ApiErrorResponse; keep its body and Retry-After unchanged.
        if (status >= 500 || status == 429 || trace.responseCode == "UNTRUSTED_ORIGIN") {
            val code = trace.responseCode ?: when {
                call.request.path() == "/readyz" -> "READINESS_UNAVAILABLE"
                status == 429 -> "RATE_LIMITED"
                else -> "INTERNAL_ERROR"
            }
            call.recordApiFailure(code, status)
        }
    }
}

/** Called before an error response is serialized, so a failed send cannot hide the original error. */
fun ApplicationCall.recordApiFailure(code: String, status: Int, cause: Throwable? = null, failureStatus: Int = status) {
    val trace = trace()
    if (trace.recorded) return
    trace.recorded = true
    val details = safeExceptionDetails(cause)
    val event = if (failureStatus >= 500) logger.atError() else logger.atWarn()
    event
        .addKeyValue("event", "api_failure")
        .addKeyValue("request_id", trace.id)
        .addKeyValue("operation", diagnosticOperation(request.path()))
        .addKeyValue("method", request.httpMethod.value.takeIf { it in methods } ?: "OTHER")
        .addKeyValue("status", status)
        .addKeyValue("failure_status", failureStatus)
        .addKeyValue("duration_ms", ((System.nanoTime() - trace.startedAt) / 1_000_000).coerceAtLeast(0))
        .addKeyValue("error_code", safeErrorCode(code))
    details.forEach { (key, value) -> event.addKeyValue(key, value) }
    // Do not pass a Throwable, message, URI, SQL, identity, header or request body to SLF4J.
    event.log("api_failure")
}

/** Callback failures still return a 302; failure_status retains the provider/application status. */
fun ApplicationCall.recordAuthFailure(failure: AuthFailure, responseStatus: Int = 302) {
    if (failure.status >= 500 || failure.code in actionableAuthFailures) {
        recordApiFailure(failure.code, responseStatus, failure, failure.status)
    }
}

/** Fixed diagnostic context survives provider wrapping without copying a response or exception message. */
class ProviderFailure(
    val provider: String,
    val stage: String,
    val httpStatus: Int? = null,
    cause: Throwable,
) : RuntimeException(null, cause)

private val methods = setOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
private val actionableAuthFailures = setOf(
    "AUTH_CODE_INVALID", "AUTH_SEND_LIMIT", "AUTH_SESSION_LIMIT", "UNTRUSTED_ORIGIN", "ACCOUNT_BUSY",
    "VK_LOGIN_FAILED", "TELEGRAM_LOGIN_FAILED", "EMAIL_DELIVERY_FAILED", "AUTH_UNAVAILABLE",
)
private val diagnosticErrorCodes = actionableAuthFailures + setOf(
    "AUTH_ALREADY_LINKED", "AUTH_CANCELLED", "AUTH_EXPIRED", "AUTH_NOT_LINKED", "AUTH_REQUIRED",
    "AUTH_USE_LINK", "UNAUTHORIZED", "INVALID_REQUEST", "INVALID_JSON", "PAYLOAD_TOO_LARGE",
    "INTERNAL_ERROR", "DATABASE_BUSY", "READINESS_UNAVAILABLE", "RATE_LIMITED",
    "ACCOUNT_PROOF_REQUIRED", "ACCOUNT_WRONG_PROFILE", "ACCOUNT_OTHER_PROFILE_REQUIRED", "ACCOUNT_EMAIL_IN_USE",
    "ACCOUNT_PREVIEW_EXPIRED", "ACCOUNT_PREVIEW_STALE", "ACCOUNT_MERGE_CONFLICT", "ACCOUNT_BUSY",
    "ACCOUNT_REQUEST_CONFLICT", "CONFIRM_REQUIRED",
)

private fun safeErrorCode(code: String): String = code.takeIf { it in diagnosticErrorCodes } ?: "UNKNOWN_ERROR"

// Only these fixed templates can reach the log. Unknown paths and path parameters are never recorded.
private val operationTemplates = listOf(
    "/healthz", "/readyz", "/api/v1/bootstrap", "/api/v1/me", "/api/v1/me/status", "/api/v1/me/calendar", "/api/v1/me/time-zone",
    "/api/v1/game/progress", "/api/v1/game/sessions", "/api/v1/game/batches",
    "/api/v1/game/visibility", "/api/v1/game/leaderboard",
    "/api/v1/check-ins", "/api/v1/game-events", "/api/v1/recovery-code", "/api/v1/recovery-code/redeem",
    "/api/v1/auth/options", "/api/v1/auth/vk/start", "/api/v1/auth/vk/callback",
    "/api/v1/auth/telegram/start", "/api/v1/auth/telegram/callback", "/api/v1/auth/email/start",
    "/api/v1/auth/email/verify", "/api/v1/auth/registration", "/api/v1/auth/account",
    "/api/v1/auth/sessions/revoke-others", "/api/v1/auth/sessions/{id}", "/api/v1/auth/logout",
    "/api/v1/auth/account/lifecycle", "/api/v1/auth/account/email", "/api/v1/auth/account/merge/preview",
    "/api/v1/auth/account/merge/confirm", "/api/v1/auth/account/profile",
    "/api/v1/users/{publicId}", "/api/v1/people", "/api/v1/people/{circleId}",
    "/api/v1/people/{circleId}/nickname", "/api/v1/people/{circleId}/favorite", "/api/v1/people/{circleId}/sharing",
    "/api/v1/direct-requests", "/api/v1/direct-requests/{requestId}/accept",
    "/api/v1/direct-requests/{requestId}/reject", "/api/v1/direct-requests/{requestId}/cancel",
    "/api/v1/direct-invite-links", "/api/v1/direct-invite-links/preview", "/api/v1/direct-invite-links/redeem",
    "/api/v1/groups", "/api/v1/groups/{groupId}", "/api/v1/groups/{groupId}/sharing",
    "/api/v1/groups/{groupId}/invites", "/api/v1/groups/{groupId}/invites/{inviteId}",
    "/api/v1/groups/{groupId}/members/{membershipId}",
    "/api/v1/group-invites/{inviteId}/accept", "/api/v1/group-invites/{inviteId}/reject",
).map { template ->
    val pattern = template.split('/').joinToString("/") { part ->
        if (part.startsWith('{')) "[^/]+" else Regex.escape(part)
    }
    Regex("^$pattern$") to template
}

internal fun diagnosticOperation(path: String): String =
    operationTemplates.firstOrNull { (pattern, _) -> pattern.matches(path) }?.second ?: "unmatched"

internal fun safeExceptionDetails(cause: Throwable?): Map<String, Any> {
    if (cause == null) return emptyMap()
    val seen = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
    val pending = ArrayDeque<Throwable>().apply { add(cause) }
    val chain = mutableListOf<Throwable>()
    while (pending.isNotEmpty() && chain.size < 8) {
        val current = pending.removeFirst()
        if (!seen.add(current)) continue
        chain.add(current)
        current.cause?.let(pending::addLast)
        // JDBC may put the useful SQLState here rather than in Throwable.cause.
        (current as? SQLException)?.nextException?.let(pending::addLast)
    }
    return buildMap {
        put("exception_class", cause.javaClass.name)
        put("cause_classes", chain.drop(1).joinToString(",") { it.javaClass.name })
        put("source", chain.flatMap { failure ->
            failure.stackTrace.asSequence().filter { it.className.startsWith("ru.zhiv.") }
                .take(2).map { frame ->
                    "${safeSymbol(frame.className)}.${safeSymbol(frame.methodName)}(${safeSymbol(frame.fileName ?: "unknown")}:${frame.lineNumber.coerceAtLeast(0)})"
                }.toList()
        }.distinct().take(8).joinToString(","))
        val sqlExceptions = chain.filterIsInstance<SQLException>()
        if (sqlExceptions.isNotEmpty()) {
            val state = sqlExceptions.firstNotNullOfOrNull { sql ->
                sql.sqlState?.takeIf { Regex("^[0-9A-Z]{5}$").matches(it) }
            }
            put("sql_state", state ?: "unknown")
            put("sql_category", sqlCategory(state))
        }
        chain.filterIsInstance<ProviderFailure>().firstOrNull()?.let { provider ->
            put("provider", provider.provider.takeIf { it in setOf("vk", "telegram", "email") } ?: "unknown")
            put("provider_stage", provider.stage.takeIf { it in setOf("exchange", "user_info", "verify", "delivery") } ?: "unknown")
            provider.httpStatus?.takeIf { it in 100..599 }?.let { put("provider_http_status", it) }
        }
    }
}

private fun safeSymbol(value: String): String = value.take(160).replace(Regex("[^A-Za-z0-9_.$<>-]"), "_")

internal fun sqlCategory(state: String?): String = when (state) {
    "40001" -> "serialization_conflict"
    "40P01" -> "deadlock"
    "55P03" -> "lock_unavailable"
    "57014" -> "query_cancelled"
    else -> when (state?.take(2)) {
        "08" -> "connection_failure"
        "23" -> "integrity_constraint"
        "28" -> "invalid_authentication"
        "42" -> "syntax_or_schema"
        "53" -> "insufficient_resources"
        else -> "unknown"
    }
}
