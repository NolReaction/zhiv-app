package ru.zhiv.mochlik.lab;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Restricts the bridge to one compile-time HTTPS backend, never arbitrary URLs. */
final class NativeHttpPolicy {
    static final int MAX_REQUEST_BYTES = 6 * 1024 * 1024;
    static final int MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
    private static final Set<String> METHODS = new HashSet<>(Arrays.asList("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"));
    private static final Set<String> REQUEST_HEADERS = new HashSet<>(Arrays.asList(
        "accept", "content-type", "if-none-match", "if-modified-since", "idempotency-key", "x-idempotency-key",
        "x-client-version", "x-game-presence", "x-game-generation", "x-economy-catalog", "x-zhiv-profile", "x-zhiv-fishing-profile"
    ));
    private static final Set<String> RESPONSE_HEADERS = new HashSet<>(Arrays.asList(
        "content-type", "content-length", "etag", "last-modified", "cache-control", "retry-after", "x-request-id",
        "x-economy-catalog", "x-zhiv-profile", "x-zhiv-fishing-profile"
    ));
    private final URI origin;

    NativeHttpPolicy(String configuredOrigin) {
        try {
            URI value = new URI(configuredOrigin);
            if (!"https".equals(value.getScheme()) || value.getHost() == null || value.getRawUserInfo() != null ||
                value.getRawQuery() != null || value.getRawFragment() != null ||
                !(value.getRawPath().isEmpty() || value.getRawPath().equals("/"))) throw new IllegalArgumentException("Invalid backend origin");
            origin = new URI("https", null, value.getHost().toLowerCase(Locale.ROOT), value.getPort(), null, null, null);
        } catch (URISyntaxException error) { throw new IllegalArgumentException("Invalid backend origin"); }
    }

    String origin() { return origin.toString(); }

    URI api(String path, boolean internal) {
        URI target = localPath(path);
        String normalized = target.getPath();
        if (!normalized.startsWith("/api/v1/")) throw new IllegalArgumentException("API path required");
        if (!internal && (normalized.equals("/api/v1/auth/mobile") || normalized.startsWith("/api/v1/auth/mobile/"))) {
            throw new IllegalArgumentException("Native authentication operation required");
        }
        return target;
    }

    URI website(String path) {
        URI target = localPath(path);
        if (target.getPath().startsWith("/api/")) throw new IllegalArgumentException("Website path required");
        return target;
    }

    private URI localPath(String path) {
        if (path == null || path.length() > 8192 || !path.startsWith("/") || path.startsWith("//") || path.contains("\\") || path.indexOf('#') >= 0 ||
            path.chars().anyMatch(c -> c < 32 || c == 127)) throw new IllegalArgumentException("Invalid path");
        try {
            URI relative = new URI(path);
            String raw = relative.getRawPath().toLowerCase(Locale.ROOT);
            if (relative.isAbsolute() || relative.getRawAuthority() != null || relative.getRawFragment() != null ||
                raw.contains("%2f") || raw.contains("%5c") || raw.contains("%25") || raw.contains("%2e") ||
                !relative.normalize().equals(relative) || raw.contains("//")) throw new IllegalArgumentException("Invalid path");
            if (relative.getPath().chars().anyMatch(c -> c < 32 || c == 127)) throw new IllegalArgumentException("Invalid path");
            for (String segment : relative.getPath().split("/")) if (segment.equals(".") || segment.equals("..")) throw new IllegalArgumentException("Invalid path");
            URI target = origin.resolve(relative);
            if (!origin.getScheme().equals(target.getScheme()) || !origin.getRawAuthority().equals(target.getRawAuthority())) throw new IllegalArgumentException("Invalid origin");
            return target;
        } catch (URISyntaxException error) { throw new IllegalArgumentException("Invalid path"); }
    }

    static String method(String value) {
        if (value == null || !METHODS.contains(value)) throw new IllegalArgumentException("Unsupported method");
        return value;
    }

    static boolean allowedRequestHeader(String name, String value) {
        return name != null && value != null && REQUEST_HEADERS.contains(name.toLowerCase(Locale.ROOT)) && value.length() <= 8192 &&
            value.chars().noneMatch(c -> c < 32 || c == 127);
    }

    static boolean allowedResponseHeader(String name) { return name != null && RESPONSE_HEADERS.contains(name.toLowerCase(Locale.ROOT)); }
}
