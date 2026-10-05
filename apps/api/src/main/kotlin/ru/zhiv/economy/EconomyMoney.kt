package ru.zhiv.economy

const val ECONOMY_CURRENCY_SCALE = 10L
const val ECONOMY_MAX_ITEMS = 1_000_000_000L

object EconomyMoney {
    /** Preserve original audit/receipt amounts; project their stored denomination for current readers. */
    fun nominal(amount: Long,storedScale: Int=1): Long {
        require(storedScale==1 || storedScale==ECONOMY_CURRENCY_SCALE.toInt())
        return Math.multiplyExact(amount,ECONOMY_CURRENCY_SCALE/storedScale)
    }
    fun redenominate(state: EconomyState): EconomyState {
        if(state.currencyScale==ECONOMY_CURRENCY_SCALE.toInt()) return state
        require(state.currencyScale==1)
        return state.copy(currencyScale=ECONOMY_CURRENCY_SCALE.toInt(),
            wallet=EconomyWallet(nominal(state.wallet.coins),nominal(state.wallet.pearls)),
            migration=state.migration.copy(coinsGranted=nominal(state.migration.coinsGranted)),
            jobs=state.jobs.map { it.copy(cost=it.cost.copy(coins=nominal(it.cost.coins))) })
    }
}
