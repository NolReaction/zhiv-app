package ru.zhiv.mochlik.lab

/** JSON uses Integer for small generations; Capacitor's getLong only accepts Long. */
internal object NativePushGeneration {
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    fun parse(value: Any?): Long? {
        val generation = when (value) {
            is Int -> value.toLong()
            is Long -> value
            else -> return null
        }
        return generation.takeIf { it in 0..MAX_SAFE_INTEGER }
    }
}
