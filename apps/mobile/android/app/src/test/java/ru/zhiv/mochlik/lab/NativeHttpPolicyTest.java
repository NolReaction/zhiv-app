package ru.zhiv.mochlik.lab;

import org.junit.Test;
import static org.junit.Assert.*;

public final class NativeHttpPolicyTest {
    private final NativeHttpPolicy policy = new NativeHttpPolicy("https://example.com");

    @Test public void onlyPinnedHttpsOriginIsAccepted() {
        assertEquals("https://example.com/api/v1/me", policy.api("/api/v1/me", false).toString());
        for (String invalid : new String[]{"http://example.com", "https://example.com/path", "https://user@example.com", "https://example.com?x=1", "file:///tmp/app"}) {
            assertThrows(IllegalArgumentException.class, () -> new NativeHttpPolicy(invalid));
        }
    }

    @Test public void refusesAuthorityAndPathNormalizationAttacks() {
        for (String path : new String[]{"https://evil.example/api/v1/me", "//evil.example/api/v1/me", "/api/v1/../auth", "/api/v1/%2e%2e/auth",
            "/api/v1/a%2fb", "/api/v1/a%5cb", "/api/v1/a%252fb", "/api/v1/a%00b", "/api/v1/a\\b", "/api/v1//me", "/api/v1/me#x"}) {
            assertThrows(path, IllegalArgumentException.class, () -> policy.api(path, false));
        }
        assertEquals("https://example.com/api/v1/search?q=hello%20world", policy.api("/api/v1/search?q=hello%20world", false).toString());
    }

    @Test public void tokenExchangeIsNeverExposedToJavascript() {
        assertThrows(IllegalArgumentException.class, () -> policy.api("/api/v1/auth/mobile/exchange", false));
        assertThrows(IllegalArgumentException.class, () -> policy.api("/api/v1/auth/mobile?x=1", false));
        assertEquals("/api/v1/auth/mobile/exchange", policy.api("/api/v1/auth/mobile/exchange", true).getPath());
    }

    @Test public void credentialsAndHeaderInjectionAreNotAccepted() {
        assertTrue(NativeHttpPolicy.allowedRequestHeader("X-Game-Presence", "opaque-session"));
        assertTrue(NativeHttpPolicy.allowedRequestHeader("Content-Type", "application/json"));
        assertFalse(NativeHttpPolicy.allowedRequestHeader("Authorization", "Bearer anything"));
        assertFalse(NativeHttpPolicy.allowedRequestHeader("Cookie", "session=x"));
        assertFalse(NativeHttpPolicy.allowedRequestHeader("Origin", "https://example.com"));
        assertFalse(NativeHttpPolicy.allowedRequestHeader("Content-Type", "application/json\r\nX-Forged: yes"));
        assertFalse(NativeHttpPolicy.allowedResponseHeader("Set-Cookie"));
        assertFalse(NativeHttpPolicy.allowedResponseHeader("Authorization"));
        assertTrue(NativeHttpPolicy.allowedResponseHeader("Retry-After"));
    }

    @Test public void websiteLinksCannotBecomeApiOrExternalRequests() {
        assertEquals("https://example.com/?tab=profile", policy.website("/?tab=profile").toString());
        assertThrows(IllegalArgumentException.class, () -> policy.website("/api/v1/auth/logout"));
        assertThrows(IllegalArgumentException.class, () -> policy.website("//evil.example/"));
        assertThrows(IllegalArgumentException.class, () -> policy.website("javascript:alert(1)"));
    }

    @Test public void onlyExplicitHttpMethodsAreAccepted() {
        assertEquals("PATCH", NativeHttpPolicy.method("PATCH"));
        assertThrows(IllegalArgumentException.class, () -> NativeHttpPolicy.method("CONNECT"));
        assertThrows(IllegalArgumentException.class, () -> NativeHttpPolicy.method("get"));
        assertThrows(IllegalArgumentException.class, () -> NativeHttpPolicy.method(null));
    }
}
