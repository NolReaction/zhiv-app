package ru.zhiv.economy

import ru.zhiv.auth.AuthFailure
import kotlinx.serialization.Serializable
import java.time.Duration
import java.time.Instant

/** One worker, saved per-unit terms, and a bounded offline queue. */
@Serializable private data class MiningBatchCatalog(val version: Int, val maxUnitsByQuarryLevel: List<Int>, val maxBaseSeconds: Long)
object EconomyMiningBatches {
    private val limits = economyJson.decodeFromString<MiningBatchCatalog>(
        checkNotNull(EconomyMiningBatches::class.java.getResourceAsStream("/world/mining-batch-catalog.json"))
            .bufferedReader().use { it.readText() }).also {
        require(it.version == 1 && it.maxUnitsByQuarryLevel.isNotEmpty() && it.maxUnitsByQuarryLevel.all { amount -> amount in 1..100 } && it.maxBaseSeconds > 0)
    }
    fun limit(quarryLevel: Int, unitSeconds: Long): Int = minOf(
        limits.maxUnitsByQuarryLevel[(quarryLevel - 1).coerceIn(0, limits.maxUnitsByQuarryLevel.lastIndex)],
        (limits.maxBaseSeconds / unitSeconds.coerceAtLeast(1)).coerceAtLeast(1).toInt())
    fun completed(job: EconomyJob, now: Instant): Int {
        val batch = checkNotNull(job.miningBatch)
        return (Duration.between(Instant.parse(job.startedAt), now).toMillis().coerceAtLeast(0) / (batch.unitSeconds * 1000))
            .coerceAtMost(batch.quantity.toLong()).toInt()
    }

    fun claim(state: EconomyState, saved: EconomyJob, now: Instant, reservedItems: Map<String, Long>, requestedQuantity: Int? = null): Pair<EconomyState, String> {
        val initial = checkNotNull(saved.miningBatch)
        val ready = completed(saved, now) - initial.claimed
        if (ready <= 0) economyFailure("ECONOMY_JOB_NOT_READY", "Следующая единица добычи ещё не готова")
        var next = state
        var current = saved
        var received = 0
        repeat(minOf(ready, requestedQuantity ?: ready)) {
            val batch = checkNotNull(current.miningBatch)
            val start = Instant.parse(current.startedAt).plusSeconds(batch.claimed * batch.unitSeconds)
            val delivered = EconomyExpeditionLoot.delivery(current).copy(miningBatch = null,
                startedAt = start.toString(), finishesAt = start.plusSeconds(batch.unitSeconds).toString())
            val inventory = try {
                val candidate = next.copy(inventory = EconomyRules.addItems(next.inventory, delivered.rewards))
                EconomyRules.assertStorageTransition(next, candidate, reservedItems)
                candidate.inventory
            } catch (error: AuthFailure) {
                if (received == 0 || error.code !in setOf("ECONOMY_STORAGE_FULL", "ECONOMY_CAPACITY")) throw error
                return next to "Добыча получена: $received. Остальные находки ждут свободного места"
            }
            next = EconomyItemUnlocks.delivered(next.copy(inventory = inventory,
                progression = EconomyCollectionProgress.advance(next.progression, delivered)), delivered.rewards)
            current.rareDrop?.let { next = next.copy(minerRareDropState = EconomyRareDrops.settle(next.minerRareDropState, it,
                checkNotNull(EconomyRules.catalog.rareDrops))) }
            received++
            val claimed = batch.claimed + 1
            if (claimed == batch.quantity) return next.copy(jobs = next.jobs.filterNot { it.id == saved.id }) to "Заказ добычи завершён: получено $received"
            val rare = EconomyRules.catalog.rareDrops?.takeIf { (next.buildings["home"] ?: 1) >= it.requiredHomeLevel }
                ?.let { EconomyRareDrops.prepare(next.minerRareDropState, batch.unitSeconds, it) }
            val route = EconomyRules.catalog.explorations.find { it.id == current.targetId }
            current = current.copy(miningBatch = batch.copy(claimed = claimed), rewards = batch.unitRewards + rare?.rewards.orEmpty(),
                rareDrop = rare?.delivery, expeditionFinds = route?.finds?.let { EconomyExpeditionLoot.draw(it) })
            next = next.copy(jobs = next.jobs.map { if (it.id == saved.id) current else it }, minerRareDropState = rare?.clock ?: next.minerRareDropState)
        }
        return next to "Добыча получена: $received. Остаток заказа сохранён"
    }

    fun cancel(state: EconomyState, job: EconomyJob, now: Instant, reservedItems: Map<String, Long>): Pair<EconomyState, String> {
        val batch = checkNotNull(job.miningBatch)
        val completed = completed(job, now)
        val remaining = batch.quantity - completed
        if (remaining == 0) economyFailure("ECONOMY_CANCEL_READY", "Вся добыча уже готова. Заберите результат")
        val refund = EconomyCost(job.cost.coins / batch.quantity * remaining,
            job.cost.items.mapValues { (_, count) -> count / batch.quantity * remaining })
        if (refund.coins > ECONOMY_MAX_BALANCE - state.wallet.coins) economyFailure("ECONOMY_CAPACITY", "Кошелёк заполнен")
        val next = state.copy(wallet = state.wallet.copy(coins = state.wallet.coins + refund.coins), inventory = EconomyRules.addItems(state.inventory, refund.items),
            jobs = state.jobs.flatMap { current -> when {
                current.id != job.id -> listOf(current)
                completed <= batch.claimed -> emptyList()
                else -> listOf(job.copy(miningBatch = batch.copy(quantity = completed),
                    finishesAt = Instant.parse(job.startedAt).plusSeconds(completed * batch.unitSeconds).toString(),
                    cost = EconomyCost(job.cost.coins - refund.coins, job.cost.items.mapValues { (id, count) -> count - (refund.items[id] ?: 0) })))
            } })
        EconomyRules.assertStorageTransition(state, next, reservedItems)
        return next to if (completed > batch.claimed) "Остаток заказа остановлен. Готовая добыча ждёт получения" else "Остаток добычи остановлен"
    }
}
