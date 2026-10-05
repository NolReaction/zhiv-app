package ru.zhiv.economy

const val ECONOMY_CURRENCY_SCALE = 10L
const val ECONOMY_PEARL_SCALE = 50L
const val ECONOMY_MAX_ITEMS = 1_000_000_000L
const val ECONOMY_MAX_PEARLS = 50_000_000_000L

object EconomyMoney {
    /** Preserve audit/receipt values and project each currency using its own stored scale. */
    fun nominal(amount: Long, storedScale: Int = 1): Long = convert(amount, storedScale, ECONOMY_CURRENCY_SCALE)
    fun pearls(amount: Long, storedScale: Int = 1): Long = convert(amount, storedScale, ECONOMY_PEARL_SCALE)
    private fun convert(amount: Long, storedScale: Int, targetScale: Long): Long {
        require(storedScale == 1 || storedScale == 10 || storedScale == targetScale.toInt())
        return Math.multiplyExact(amount, targetScale / storedScale)
    }
    fun redenominate(state: EconomyState): EconomyState {
        if (state.currencyScale == ECONOMY_CURRENCY_SCALE.toInt() && state.pearlScale == ECONOMY_PEARL_SCALE.toInt()) return state
        val pearlScale = state.pearlScale ?: state.currencyScale
        return state.copy(currencyScale = ECONOMY_CURRENCY_SCALE.toInt(), pearlScale = ECONOMY_PEARL_SCALE.toInt(),
            wallet = EconomyWallet(nominal(state.wallet.coins, state.currencyScale), pearls(state.wallet.pearls, pearlScale)),
            migration = state.migration.copy(coinsGranted = nominal(state.migration.coinsGranted, state.currencyScale)),
            jobs = state.jobs.map { it.copy(cost = it.cost.copy(coins = nominal(it.cost.coins, state.currencyScale))) })
    }
}
