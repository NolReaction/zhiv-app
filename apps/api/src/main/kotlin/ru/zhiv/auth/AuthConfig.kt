package ru.zhiv.auth

import java.nio.file.Files
import java.nio.file.Path

data class AuthConfig(
    val origin: String = "",
    val telegramClientId: String = "",
    val telegramClientSecret: String = "",
    val smtpHost: String = "",
    val smtpPort: Int = 587,
    val smtpUser: String = "",
    val smtpPassword: String = "",
    val smtpFrom: String = "",
    val smtpImplicitTls: Boolean = false,
    val codeSecret: String = "",
    val vkClientId: String = "",
) {
    val telegramEnabled get() = telegramClientId.isNotEmpty() && telegramClientSecret.isNotEmpty()
    val emailEnabled get() = smtpHost.isNotEmpty() && smtpFrom.isNotEmpty() && codeSecret.isNotEmpty()
    val callback get() = "$origin/api/v1/auth/telegram/callback"
    val vkEnabled get() = vkClientId.isNotEmpty()
    val vkCallback get() = "$origin/api/v1/auth/vk/callback"

    companion object {
        fun fromEnvironment(env: Map<String, String>, origins: Set<String>): AuthConfig {
            fun value(key: String) = env[key].orEmpty().trim()
            fun secret(key: String): String {
                val file = value("${key}_FILE")
                require(file.isEmpty() || value(key).isEmpty()) { "Set $key or ${key}_FILE, not both" }
                return if (file.isNotEmpty()) Files.readString(Path.of(file)).trim() else value(key)
            }
            val config = AuthConfig(
                origin = value("AUTH_PUBLIC_ORIGIN").ifEmpty { origins.singleOrNull().orEmpty() },
                telegramClientId = value("TELEGRAM_CLIENT_ID"), telegramClientSecret = secret("TELEGRAM_CLIENT_SECRET"),
                smtpHost = value("SMTP_HOST"), smtpPort = value("SMTP_PORT").ifEmpty { "587" }.toInt(),
                smtpUser = value("SMTP_USER"), smtpPassword = secret("SMTP_PASSWORD"), smtpFrom = value("SMTP_FROM"),
                smtpImplicitTls = value("SMTP_TLS_MODE").ifEmpty { "starttls" }.also { require(it in setOf("starttls", "implicit")) }.equals("implicit"),
                codeSecret = secret("AUTH_CODE_SECRET"),
                vkClientId = value("VK_CLIENT_ID"),
            )
            require(config.telegramClientId.isEmpty() == config.telegramClientSecret.isEmpty()) { "Telegram configuration is incomplete" }
            if (config.smtpHost.isNotEmpty()) {
                require(config.emailEnabled && config.codeSecret.length >= 32) { "SMTP_FROM and AUTH_CODE_SECRET (32+ characters) are required" }
                require(normalizedEmail(config.smtpFrom) != null && config.smtpPort in 1..65535) { "Invalid SMTP configuration" }
                require(config.smtpUser.isEmpty() == config.smtpPassword.isEmpty()) { "SMTP credentials are incomplete" }
            }
            require(config.vkClientId.isEmpty() || Regex("^[1-9][0-9]{0,18}$").matches(config.vkClientId)) { "Invalid VK_CLIENT_ID" }
            if (config.telegramEnabled || config.emailEnabled || config.vkEnabled) require(config.origin in origins) { "AUTH_PUBLIC_ORIGIN must match ALLOWED_ORIGINS" }
            return config
        }
    }
}
