package ru.zhiv.config

import java.net.URI

data class AppConfig(
    val databaseUrl: String,
    val databaseUser: String,
    val databasePassword: String,
    val production: Boolean,
    val allowedOrigins: Set<String>,
    val sessionDays: Long = 365,
) {
    val cookieName: String = if (production) "__Host-zhiv_session" else "zhiv_session_dev"

    companion object {
        fun fromEnvironment(environment: Map<String, String> = System.getenv()): AppConfig {
            val appEnvironment = environment["APP_ENV"]
                ?.takeIf(String::isNotBlank)
                ?: error("APP_ENV is required")
            require(appEnvironment in setOf("development", "test", "production")) {
                "APP_ENV must be development, test, or production"
            }
            val production = appEnvironment == "production"

            fun value(name: String, developmentDefault: String): String =
                environment[name]?.takeIf(String::isNotBlank)
                    ?: if (production) error("$name is required in production") else developmentDefault

            val originsValue = environment["ALLOWED_ORIGINS"]
                ?.takeIf(String::isNotBlank)
                ?: if (production) error("ALLOWED_ORIGINS is required in production")
                else "http://localhost:3000,http://localhost:5173"
            val allowedOrigins = parseAllowedOrigins(originsValue, production)

            return AppConfig(
                databaseUrl = value("DATABASE_URL", "jdbc:postgresql://localhost:5432/zhiv"),
                databaseUser = value("DATABASE_USER", "zhiv"),
                databasePassword = value("DATABASE_PASSWORD", "zhiv"),
                production = production,
                allowedOrigins = allowedOrigins,
            )
        }

        private fun parseAllowedOrigins(raw: String, production: Boolean): Set<String> {
            val values = raw.split(',').map(String::trim)
            require(values.isNotEmpty() && values.all(String::isNotEmpty)) {
                "ALLOWED_ORIGINS must contain one or more origins"
            }

            return values.map { value ->
                val uri = runCatching { URI(value) }
                    .getOrElse { throw IllegalArgumentException("Invalid ALLOWED_ORIGINS entry: $value", it) }
                val scheme = uri.scheme
                val host = uri.host
                require(scheme in setOf("http", "https") && host != null) {
                    "Invalid ALLOWED_ORIGINS entry: $value"
                }
                require(uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
                    "ALLOWED_ORIGINS entries must be origins without credentials, query, or fragment"
                }
                require(uri.rawPath.isNullOrEmpty()) {
                    "ALLOWED_ORIGINS entries must not contain a path"
                }
                require(uri.port == -1 || uri.port in 1..65_535) {
                    "Invalid port in ALLOWED_ORIGINS entry: $value"
                }
                val canonicalHost = host.lowercase()
                require(!canonicalHost.endsWith('.')) {
                    "ALLOWED_ORIGINS hosts must not end with a dot"
                }
                if (production) {
                    require(scheme == "https") {
                        "Production ALLOWED_ORIGINS must use HTTPS"
                    }
                }

                val hostPart = if (':' in canonicalHost && !canonicalHost.startsWith("[")) {
                    "[$canonicalHost]"
                } else {
                    canonicalHost
                }
                val defaultPort = (scheme == "https" && uri.port == 443) ||
                    (scheme == "http" && uri.port == 80)
                val canonical = buildString {
                    append(scheme)
                    append("://")
                    append(hostPart)
                    if (uri.port != -1 && !defaultPort) append(":${uri.port}")
                }
                require(value == canonical) {
                    "ALLOWED_ORIGINS entry must be canonical: $canonical"
                }
                canonical
            }.toSet()
        }
    }
}
