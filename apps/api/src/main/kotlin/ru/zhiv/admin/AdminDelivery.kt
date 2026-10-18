package ru.zhiv.admin

import ru.zhiv.auth.AuthFailure
import ru.zhiv.mail.PlayerMailMessage
import ru.zhiv.mail.validPlayerMailMessage

/** The audit reason is deliberately absent from the player-facing message. */
internal fun validateAdminDelivery(delivery: String, message: PlayerMailMessage?) {
    if (delivery !in setOf("silent", "notify") || delivery == "silent" && message != null ||
        message != null && !validPlayerMailMessage(message))
        throw AuthFailure("INVALID_ADMIN_DELIVERY", "Выберите тихую выдачу или уведомление с корректным текстом для игрока.", 400)
}
