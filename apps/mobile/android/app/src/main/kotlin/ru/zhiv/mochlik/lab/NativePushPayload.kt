package ru.zhiv.mochlik.lab

/** Pure validation shared by foreground, background and notification-tap paths. */
internal class NativePushPayload private constructor(
    val owner: String,
    val target: String,
    val eventId: String,
) {
    fun body(): String = if (target == "mailbox") {
        "В приложении есть новое письмо."
    } else {
        "Откройте приложение, чтобы проверить отметку."
    }

    companion object {
        private val ownerPattern = Regex("[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}")
        private val eventIdPattern = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

        fun parse(data: Map<String, String?>?): NativePushPayload? {
            if (data == null || data["source"] != "mochlik-remote") return null
            val owner = data["ownerPublicId"] ?: return null
            val target = data["target"] ?: return null
            val eventId = data["eventId"] ?: return null
            if (!validOwner(owner) || (target != "mailbox" && target != "checkin") || !eventIdPattern.matches(eventId)) {
                return null
            }
            return NativePushPayload(owner, target, eventId)
        }

        fun validOwner(value: String?): Boolean = value != null && ownerPattern.matches(value)
    }
}
