package ru.zhiv.notifications

internal data class NotificationMessage(val title: String, val body: String)

/** The browser/OS supplies the app identity separately from the event title. */
internal fun notificationMessage(categories: Set<String>, mineOnly: Boolean = false): NotificationMessage {
    if (mineOnly && categories == setOf("exploration"))
        return NotificationMessage("Шахтёр завершил смену", "Работа в шахте завершена. Можно забрать добычу.")
    return when (categories.singleOrNull()) {
        "exploration" -> NotificationMessage("Мохлик вернулся", "Путешествие завершено. Можно разобрать находки.")
        "construction" -> NotificationMessage("Стройка завершена", "Улучшение готово. Загляните на полянку.")
        "production" -> NotificationMessage("Ресурсы готовы", "Производство завершено. Можно забрать результат.")
        "checkin" -> NotificationMessage("Пора отметиться", "С последней отметки прошло больше суток.")
        else -> NotificationMessage("Новости полянки", buildList {
            if ("exploration" in categories) add("Мохлик вернулся из путешествия")
            if ("construction" in categories) add("Стройка завершена")
            if ("production" in categories) add("Ресурсы готовы")
            if ("checkin" in categories) add("Можно отметиться: с последней отметки прошло больше суток")
        }.joinToString(". ", postfix = "."))
    }
}
