package ru.zhiv.config

import java.nio.file.Files
import java.nio.file.Path

/** Server-only credential. Its value must never appear in configuration diagnostics. */
class MapTilerServiceToken private constructor(private val raw: String) {
    internal fun authorization(): String = "Token $raw"
    override fun toString(): String = "[redacted]"

    companion object {
        fun fromFile(file: String): MapTilerServiceToken {
            val bytes = try {
                Files.newInputStream(Path.of(file)).use { it.readNBytes(8193) }
            } catch (_: Exception) {
                throw IllegalArgumentException("Cannot read MAPTILER_SERVICE_TOKEN_FILE")
            }
            require(bytes.size <= 8192) { "Invalid MAPTILER_SERVICE_TOKEN_FILE" }
            val token = bytes.toString(Charsets.UTF_8).trim()
            require(token.length in 1..4096 && token.all { it.code in 33..126 }) {
                "Invalid MAPTILER_SERVICE_TOKEN_FILE"
            }
            return MapTilerServiceToken(token)
        }
    }
}
