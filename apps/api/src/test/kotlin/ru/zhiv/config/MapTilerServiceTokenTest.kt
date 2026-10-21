package ru.zhiv.config

import java.nio.file.Files
import kotlin.test.*

class MapTilerServiceTokenTest {
    @Test fun `optional private token is file-only and redacted from config diagnostics`() {
        val base = mapOf("APP_ENV" to "development")
        assertNull(AppConfig.fromEnvironment(base).maptilerServiceToken)
        assertNull(AppConfig.fromEnvironment(base + ("MAPTILER_SERVICE_TOKEN_FILE" to "")).maptilerServiceToken)
        assertNull(AppConfig.fromEnvironment(base + ("NEXT_PUBLIC_MAPTILER_KEY" to "public-browser-key")).maptilerServiceToken)
        val file = Files.createTempFile("private-maptiler-", ".txt")
        try {
            Files.writeString(file, "SENSITIVE_PRIVATE_FIXTURE\n")
            val config = AppConfig.fromEnvironment(base + ("MAPTILER_SERVICE_TOKEN_FILE" to file.toString()))
            assertNotNull(config.maptilerServiceToken)
            assertFalse(config.toString().contains("SENSITIVE"))
            for (value in listOf("", "SENSITIVE\nINJECTED", "SENSITIVE\u0000", "SENSITIVE " + "x".repeat(9000))) {
                Files.writeString(file, value)
                val failure = assertFails { AppConfig.fromEnvironment(base + ("MAPTILER_SERVICE_TOKEN_FILE" to file.toString())) }
                assertFalse(failure.toString().contains("SENSITIVE"))
            }
        } finally { Files.deleteIfExists(file) }
        val missing = assertFails { MapTilerServiceToken.fromFile("missing-SENSITIVE-file") }
        assertFalse(missing.toString().contains("SENSITIVE"))
    }
}
