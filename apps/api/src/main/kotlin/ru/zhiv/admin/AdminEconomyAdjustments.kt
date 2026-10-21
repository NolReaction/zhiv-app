package ru.zhiv.admin

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.ECONOMY_MAX_BALANCE
import ru.zhiv.economy.ECONOMY_MAX_PEARLS
import ru.zhiv.economy.ECONOMY_MAX_REVISION
import ru.zhiv.economy.EconomyState
import ru.zhiv.mail.PlayerMailMessage

/** Signed visible whole units; an existing half pearl is preserved exactly. */
@Serializable data class AdminEconomyAdjustmentRequest(
    val requestId: String, val confirmationPublicId: String, val reason: String, val expectedRevision: Long,
    val coinsDelta: Long = 0, val pearlsDelta: Long = 0,
    val delivery: String = "silent", val playerMessage: PlayerMailMessage? = null,
)

object AdminEconomyAdjustments {
    fun validate(request: AdminEconomyAdjustmentRequest) {
        if (!validAdminReason(request.reason) || request.expectedRevision !in 0..ECONOMY_MAX_REVISION ||
            request.coinsDelta !in -1_000_000_000L..1_000_000_000L || request.pearlsDelta !in -1_000_000_000L..1_000_000_000L ||
            request.coinsDelta == 0L && request.pearlsDelta == 0L)
            throw AuthFailure("INVALID_ADMIN_ADJUSTMENT", "Укажите ненулевую целую поправку кошелька, актуальную версию и причину.", 400)
        validateAdminDelivery(request.delivery, request.playerMessage)
    }

    fun apply(state: EconomyState, request: AdminEconomyAdjustmentRequest): EconomyState {
        validate(request)
        val pearlUnits = request.pearlsDelta * 2L
        if (request.coinsDelta < -state.wallet.coins || pearlUnits < -state.wallet.pearls)
            throw AuthFailure("ADMIN_ADJUSTMENT_INSUFFICIENT_BALANCE", "Поправка сделает баланс отрицательным. Обновите карточку игрока и уменьшите списание.", 409)
        if (request.coinsDelta > ECONOMY_MAX_BALANCE - state.wallet.coins || pearlUnits > ECONOMY_MAX_PEARLS - state.wallet.pearls)
            throw AuthFailure("ECONOMY_CAPACITY", "Поправка превышает предельный баланс кошелька.", 409)
        return state.copy(wallet = state.wallet.copy(coins = state.wallet.coins + request.coinsDelta, pearls = state.wallet.pearls + pearlUnits))
    }
}
