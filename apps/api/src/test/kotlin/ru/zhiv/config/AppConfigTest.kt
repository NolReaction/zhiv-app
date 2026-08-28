package ru.zhiv.config

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class AppConfigTest {
    @Test
    fun `APP_ENV is mandatory`() {
        assertFails {
            AppConfig.fromEnvironment(emptyMap())
        }
        assertFails {
            AppConfig.fromEnvironment(mapOf("APP_ENV" to ""))
        }
    }

    @Test
    fun `production requires database secrets and at least one canonical HTTPS origin`() {
        val base = mapOf(
            "APP_ENV" to "production",
            "DATABASE_URL" to "jdbc:postgresql://db:5432/zhiv",
            "DATABASE_USER" to "zhiv",
            "DATABASE_PASSWORD" to "secret",
        )

        listOf(
            "",
            ",",
            "http://example.test",
            "https://example.test/",
            "https://example.test/path",
            "https://example.test:443",
            "https://EXAMPLE.test",
            "https://example.test.",
        ).forEach { origins ->
            assertFails("Expected ALLOWED_ORIGINS=$origins to fail") {
                AppConfig.fromEnvironment(base + ("ALLOWED_ORIGINS" to origins))
            }
        }
    }

    @Test
    fun `production accepts canonical HTTPS origins`() {
        val config = AppConfig.fromEnvironment(
            mapOf(
                "APP_ENV" to "production",
                "DATABASE_URL" to "jdbc:postgresql://db:5432/zhiv",
                "DATABASE_USER" to "zhiv",
                "DATABASE_PASSWORD" to "secret",
                "ALLOWED_ORIGINS" to "https://example.test, https://api.example.test:8443",
            ),
        )

        assertEquals(
            setOf("https://example.test", "https://api.example.test:8443"),
            config.allowedOrigins,
        )
    }

    @Test
    fun `explicit development environment keeps local defaults`() {
        val config = AppConfig.fromEnvironment(mapOf("APP_ENV" to "development"))

        assertEquals("jdbc:postgresql://localhost:5432/zhiv", config.databaseUrl)
        assertEquals(setOf("http://localhost:3000", "http://localhost:5173"), config.allowedOrigins)
    }
}
