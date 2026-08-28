package ru.zhiv.http

import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
import ru.zhiv.config.AppConfig
import java.net.URI
import java.util.UUID

fun ApplicationCall.isTrustedWrite(config: AppConfig): Boolean {
    val origin = request.headers[HttpHeaders.Origin] ?: return !config.production
    val normalized = runCatching {
        val uri = URI(origin)
        require(uri.scheme in setOf("http", "https"))
        require(uri.host != null && uri.userInfo == null)
        require(uri.rawQuery == null && uri.rawFragment == null)
        require(uri.path.isNullOrEmpty() || uri.path == "/")
        val defaultPort = (uri.scheme == "https" && uri.port == 443) ||
            (uri.scheme == "http" && uri.port == 80)
        if (uri.port == -1 || defaultPort) "${uri.scheme}://${uri.host}"
        else "${uri.scheme}://${uri.host}:${uri.port}"
    }.getOrNull() ?: return false
    return normalized in config.allowedOrigins
}

fun ApplicationCall.sessionCookie(config: AppConfig): String? =
    request.cookies[config.cookieName]

fun sessionCookieHeader(config: AppConfig, rawToken: String): String = buildString {
    append(config.cookieName)
    append('=')
    append(rawToken)
    append("; Max-Age=")
    append(config.sessionDays * 24 * 60 * 60)
    append("; Path=/; HttpOnly; SameSite=Lax")
    if (config.production) append("; Secure")
}

private val canonicalUuid = Regex(
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
)

fun parseCanonicalUuid(raw: String?): UUID? {
    if (raw == null || !canonicalUuid.matches(raw)) return null
    val parsed = runCatching { UUID.fromString(raw) }.getOrNull() ?: return null
    return parsed.takeIf { it.toString().equals(raw, ignoreCase = true) }
}

fun parseCanonicalUuidV4(raw: String?): UUID? =
    parseCanonicalUuid(raw)?.takeIf { it.version() == 4 && it.variant() == 2 }
