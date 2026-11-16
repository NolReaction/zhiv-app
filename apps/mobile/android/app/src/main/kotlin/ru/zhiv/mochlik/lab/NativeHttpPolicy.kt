package ru.zhiv.mochlik.lab

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/** Restricts the bridge to one compile-time HTTPS backend, never arbitrary URLs. */
internal class NativeHttpPolicy(configuredOrigin: String) {
    private val origin: URI = try {
        val value = URI(configuredOrigin)
        require(
            value.scheme == "https" && value.host != null && value.rawUserInfo == null &&
                value.rawQuery == null && value.rawFragment == null &&
                (value.rawPath.isEmpty() || value.rawPath == "/")
        ) { "Invalid backend origin" }
        URI("https", null, value.host.lowercase(Locale.ROOT), value.port, null, null, null)
    } catch (_: URISyntaxException) {
        throw IllegalArgumentException("Invalid backend origin")
    }

    fun origin(): String = origin.toString()

    fun api(path: String?, internal: Boolean): URI {
        val target = localPath(path)
        val normalized = target.path
        require(normalized.startsWith("/api/v1/")) { "API path required" }
        require(
            internal || (normalized != "/api/v1/auth/mobile" && !normalized.startsWith("/api/v1/auth/mobile/"))
        ) { "Native authentication operation required" }
        return target
    }

    fun website(path: String?): URI {
        val target = localPath(path)
        require(!target.path.startsWith("/api/")) { "Website path required" }
        return target
    }

    private fun localPath(path: String?): URI {
        require(
            path != null && path.length <= 8192 && path.startsWith("/") && !path.startsWith("//") &&
                !path.contains('\\') && !path.contains('#') && path.none { it.code < 32 || it.code == 127 }
        ) { "Invalid path" }
        try {
            val relative = URI(path)
            val raw = relative.rawPath.lowercase(Locale.ROOT)
            require(
                !relative.isAbsolute && relative.rawAuthority == null && relative.rawFragment == null &&
                    !raw.contains("%2f") && !raw.contains("%5c") && !raw.contains("%25") && !raw.contains("%2e") &&
                    relative.normalize() == relative && !raw.contains("//")
            ) { "Invalid path" }
            require(relative.path.none { it.code < 32 || it.code == 127 }) { "Invalid path" }
            require(relative.path.split('/').none { it == "." || it == ".." }) { "Invalid path" }
            val target = origin.resolve(relative)
            require(origin.scheme == target.scheme && origin.rawAuthority == target.rawAuthority) { "Invalid origin" }
            return target
        } catch (_: URISyntaxException) {
            throw IllegalArgumentException("Invalid path")
        }
    }

    companion object {
        const val MAX_REQUEST_BYTES = 6 * 1024 * 1024
        const val MAX_RESPONSE_BYTES = 16 * 1024 * 1024
        private val METHODS = setOf("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE")
        private val REQUEST_HEADERS = setOf(
            "accept", "content-type", "if-none-match", "if-modified-since", "idempotency-key", "x-idempotency-key",
            "x-client-version", "x-game-presence", "x-game-generation", "x-economy-catalog", "x-zhiv-profile", "x-zhiv-fishing-profile"
        )
        private val RESPONSE_HEADERS = setOf(
            "content-type", "content-length", "etag", "last-modified", "cache-control", "retry-after", "x-request-id",
            "x-economy-catalog", "x-zhiv-profile", "x-zhiv-fishing-profile"
        )

        fun method(value: String?): String {
            require(value != null && value in METHODS) { "Unsupported method" }
            return value
        }

        fun allowedRequestHeader(name: String?, value: String?): Boolean =
            name != null && value != null && name.lowercase(Locale.ROOT) in REQUEST_HEADERS &&
                value.length <= 8192 && value.none { it.code < 32 || it.code == 127 }

        fun allowedResponseHeader(name: String?): Boolean =
            name != null && name.lowercase(Locale.ROOT) in RESPONSE_HEADERS
    }
}
