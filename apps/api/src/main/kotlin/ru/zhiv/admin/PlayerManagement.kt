package ru.zhiv.admin

import ru.zhiv.identity.PlayerTag
import kotlinx.serialization.Serializable
import ru.zhiv.world.WorldState

@Serializable data class AdminPlayer(
    val publicId: String, val displayName: String, val tag: PlayerTag?, val bannedAt: String?,
    val banReason: String?, val watchlisted: Boolean, val world: WorldState, val revision: Long,
    val serverTime: String, val tapSignalAt: String? = null,
)
@Serializable data class AdminPlayerCommand(
    val requestId: String, val confirmationPublicId: String, val reason: String, val action: String,
    val target: String = "", val amount: Long = 0, val tag: PlayerTag? = null,
)
@Serializable data class AdminPlayerReceipt(
    val requestId: String, val action: String, val changed: Boolean, val affectedSessions: Int, val createdAt: String,
)

object PlayerManagement {
    val colors = setOf("red", "orange", "yellow", "green", "blue", "purple", "pink", "white")
    val actions = setOf("grant_resource", "grant_world_item", "grant_find", "set_tag", "ban", "unban", "watch", "unwatch", "clear_signal")
    fun valid(command: AdminPlayerCommand): Boolean {
        if (command.action !in actions) return false
        if (command.reason.length !in 8..240 || command.reason != command.reason.trim() || command.reason.any(Char::isISOControl)) return false
        if (command.tag != null && (command.action != "set_tag" || command.tag.color !in colors ||
                !Regex("^[A-Za-zА-Яа-яЁё0-9_-]{1,16}$").matches(command.tag.text))) return false
        return when (command.action) {
            "grant_resource" -> command.target in setOf("sparks", "wood", "stone") && command.amount in 1..100_000
            "grant_world_item" -> command.amount == 0L && ru.zhiv.world.WorldRules.catalog.items.any { it.id == command.target }
            "grant_find" -> command.amount == 0L && ru.zhiv.world.WorldRules.catalog.finds.any { it.id == command.target }
            else -> command.amount == 0L && command.target.isEmpty()
        }
    }
}
