package ru.zhiv.mochlik.lab;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.*;

public final class NativePushPayloadTest {
    private Map<String, String> payload() {
        Map<String, String> value = new HashMap<>();
        value.put("source", "mochlik-remote"); value.put("ownerPublicId", "AAAA-0000-0001");
        value.put("target", "mailbox"); value.put("eventId", "11111111-1111-4111-8111-111111111111");
        return value;
    }
    @Test public void acceptsOnlyAccountScopedNonMutatingDestinations() {
        Map<String, String> data = payload();
        assertNotNull(NativePushPayload.parse(data));
        data.put("target", "checkin"); assertNotNull(NativePushPayload.parse(data));
        for (String target : new String[]{ "construction", "production", "https://evil.test", "logout", "" }) {
            data.put("target", target); assertNull(NativePushPayload.parse(data));
        }
    }
    @Test public void rejectsMalformedUnownedMessages() {
        assertNull(NativePushPayload.parse(null));
        for (String key : new String[]{ "source", "ownerPublicId", "target", "eventId" }) {
            Map<String, String> data = payload(); data.remove(key); assertNull(NativePushPayload.parse(data));
        }
        for (String owner : new String[]{ "AAAA-OOOO-0001", "owner", "AAAA-0000-0001\n", "" }) {
            Map<String, String> data = payload(); data.put("ownerPublicId", owner); assertNull(NativePushPayload.parse(data));
        }
        Map<String, String> data = payload(); data.put("eventId", "not-a-uuid"); assertNull(NativePushPayload.parse(data));
    }
    @Test public void visibleTextNeverUsesPrivatePayloadFields() {
        Map<String, String> data = payload(); data.put("body", "Private message"); data.put("latitude", "55.0");
        assertEquals("В приложении есть новое письмо.", NativePushPayload.parse(data).body());
        data.put("target", "checkin"); assertEquals("Откройте приложение, чтобы проверить отметку.", NativePushPayload.parse(data).body());
    }
}
