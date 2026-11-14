package ru.zhiv.mochlik.lab;

import java.util.Map;

/** Pure validation shared by foreground, background and notification-tap paths. */
final class NativePushPayload {
    final String owner;
    final String target;
    final String eventId;
    private NativePushPayload(String owner, String target, String eventId) {
        this.owner = owner; this.target = target; this.eventId = eventId;
    }
    static NativePushPayload parse(Map<String, String> data) {
        if (data == null || !"mochlik-remote".equals(data.get("source"))) return null;
        String owner = data.get("ownerPublicId"), target = data.get("target"), eventId = data.get("eventId");
        if (!validOwner(owner) || !("mailbox".equals(target) || "checkin".equals(target)) || eventId == null
            || !eventId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) return null;
        return new NativePushPayload(owner, target, eventId);
    }
    static boolean validOwner(String value) {
        return value != null && value.matches("[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}");
    }
    String body() { return "mailbox".equals(target) ? "В приложении есть новое письмо." : "Откройте приложение, чтобы проверить отметку."; }
}
