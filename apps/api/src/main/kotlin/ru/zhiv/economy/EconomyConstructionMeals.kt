package ru.zhiv.economy

import java.math.BigInteger

/** Exact integer counterpart of construction-meal.ts; old servings have no budget. */
internal object EconomyConstructionMeals {
    private val scale = BigInteger.valueOf(100_000_000L)
    private fun validate(duration: Long, foodBps: Int, tradeBps: Int, work: Long?, skillBps: Int) {
        require(duration >= 0 && foodBps in 0..10000 && tradeBps in 0..1000 && skillBps in 0..500)
        require(work == null || work >= 0)
    }
    fun duration(seconds: Long, foodBps: Int, tradeBps: Int, workSeconds: Long?, skillBps: Int): Long {
        validate(seconds, foodBps, tradeBps, workSeconds, skillBps)
        val work = BigInteger.valueOf(seconds)
        val covered = BigInteger.valueOf(minOf(seconds, workSeconds ?: seconds))
        val trade = BigInteger.valueOf(10000L + tradeBps)
        val fed = BigInteger.valueOf(10000L + tradeBps + foodBps)
        val skill = BigInteger.valueOf(10000L + skillBps)
        val numerator = ((work - covered) * fed + covered * trade) * scale
        val denominator = trade * fed * skill
        return ((numerator + denominator - BigInteger.ONE) / denominator).longValueExact()
    }
    fun remaining(duration: Long, foodBps: Int, tradeBps: Int, workBudget: Long?, skillBps: Int): Long {
        validate(duration, foodBps, tradeBps, workBudget, skillBps)
        val time = BigInteger.valueOf(duration)
        val trade = BigInteger.valueOf(10000L + tradeBps)
        val fed = BigInteger.valueOf(10000L + tradeBps + foodBps)
        val skill = BigInteger.valueOf(10000L + skillBps)
        val remainingWork = time * trade * skill
        val covered = minOf(remainingWork, workBudget?.let { BigInteger.valueOf(it) * scale } ?: remainingWork)
        val saved = covered * BigInteger.valueOf(foodBps.toLong()) / (trade * fed * skill)
        return (time - saved).longValueExact()
    }

    fun coveredSeconds(remainingMs: Long, tradeBps: Int, skillBps: Int, workSeconds: Long): Long {
        validate(remainingMs, 0, tradeBps, workSeconds, skillBps)
        val numerator = BigInteger.valueOf(remainingMs) * BigInteger.valueOf(10000L + tradeBps) * BigInteger.valueOf(10000L + skillBps)
        val denominator = scale * BigInteger.valueOf(1000L)
        return minOf(BigInteger.valueOf(workSeconds), (numerator + denominator - BigInteger.ONE) / denominator).longValueExact()
    }
}
