package ru.zhiv.admin

import kotlinx.serialization.Serializable

/** Facts for human review, never an automatic cheating verdict or penalty. */
enum class SecurityObservationKind(val reason: String, val threshold: Int, val windowMinutes: Int?) {
    ECONOMY_REQUEST_TAMPER("Принятый requestId повторно использован с другим действием или значимыми параметрами", 1, null),
    MARKET_OWNERSHIP_DENIED("Повторные попытки отменить объявление другого игрока", 3, 30),
    BARTER_OWNERSHIP_DENIED("Повторные попытки снять предложение обмена другого игрока", 3, 30),
}

@Serializable data class AdminSecuritySignal(
    val code: String, val reason: String, val severity: String = "review", val status: String,
    val count: Long, val pendingCount: Long, val threshold: Int, val windowMinutes: Int?,
    val firstAt: String, val lastAt: String, val lastAction: String, val lastRequestId: String,
    val reviewedAt: String?,
)

@Serializable data class AdminSecurityObservations(
    val publicId: String, val serverTime: String, val watchlisted: Boolean,
    val manualWatchReason: String?, val tapSignalAt: String?, val securitySignalAt: String?,
    val signals: List<AdminSecuritySignal>,
)
