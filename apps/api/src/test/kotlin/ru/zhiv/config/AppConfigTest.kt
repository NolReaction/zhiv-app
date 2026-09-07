package ru.zhiv.config

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class AppConfigTest {
    @Test fun `administrator access is disabled until exact server public IDs are configured`() {
        val base = mapOf("APP_ENV" to "development")
        assertEquals(emptySet(), AppConfig.fromEnvironment(base).adminPublicIds)
        assertEquals(null, AppConfig.fromEnvironment(base).metricsScrapeToken)
        assertEquals(setOf("39QC-QR3A-F92Q"), AppConfig.fromEnvironment(base + ("ADMIN_PUBLIC_IDS" to "39QC-QR3A-F92Q")).adminPublicIds)
        for (value in listOf("*", "admin", "https://example.com", "39qc-qr3a-f92q")) {
            assertFails { AppConfig.fromEnvironment(base + ("ADMIN_PUBLIC_IDS" to value)) }
        }
        for (value in listOf("file:///etc/passwd", "http://user:pass@prometheus:9090", "http://prometheus:9090/api?query=secret")) {
            assertFails { AppConfig.fromEnvironment(base + ("MONITORING_URL" to value)) }
        }
    }
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
