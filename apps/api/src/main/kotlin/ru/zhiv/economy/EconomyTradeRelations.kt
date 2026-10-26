package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant

internal val tradeResidentIds = listOf("plesk", "builder", "lopukh", "kamneshmyg", "leaftail")
private fun validTradeCounts(values: Map<String, Long>) = values.size <= 5 && values.all { (id, value) ->
    id in tradeResidentIds && value in 0L..1_000_000L
}

@Serializable data class EconomyTradeRank(val id: String, val name: String, val requiredXp: Long, val bonusBps: Int)
@Serializable data class EconomyTradeActivity(val pointsBps: Int, val updatedAt: String) {
    init { require(pointsBps in 0..10000); Instant.parse(updatedAt) }
}
@Serializable data class EconomyTradeActivityConfig(val graceSeconds: Long, val decaySeconds: Long, val recoveryBps: Int)
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyWeeklyStageTemplate(
    val id: String, val name: String, val description: String, val items: Map<String, Long>, val coins: Long,
    val reputationXp: Int, val effortSeconds: Long, val manufacturingSeconds: Long, val fishingUncertain: Boolean,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val pearls: Long = 0,
)
@Serializable data class EconomyWeeklyTemplate(
    val id: String, val residentId: String, val name: String, val description: String,
    val requiredHomeLevel: Int, val requiredBuildings: Map<String, Int> = emptyMap(),
    val stages: List<EconomyWeeklyStageTemplate>,
)
@Serializable data class EconomyWeeklyConfig(val durationSeconds: Long = 604800, val templates: List<EconomyWeeklyTemplate>)
@Serializable data class EconomyTradeRelationsCatalog(
    val version: Int = 1, val maxBonusBps: Int = 1000, val ranks: List<EconomyTradeRank>,
    val dailyOrderXpCap: Int = 60, val purchaseXp: Int = 1, val dailyPurchaseXpCap: Int = 2,
    val weekly: EconomyWeeklyConfig,
    val activity: EconomyTradeActivityConfig? = null,
)
@Serializable data class EconomyWeeklyProgress(
    val id: String, val templateId: String, val residentId: String, val name: String, val description: String? = null,
    val stages: List<EconomyResidentOrderTemplate>, val stage: Int = 0, val acceptedAt: String, val expiresAt: String,
) {
    init {
        require(id.length in 1..80 && templateId.length in 1..40 && residentId in tradeResidentIds)
        require(stages.size == 3 && stage in 0..2 && stages.all { it.residentId == residentId })
        require(Instant.parse(expiresAt).isAfter(Instant.parse(acceptedAt)))
    }
}
@Serializable data class EconomyTradeRelationsState(
    val version: Int = 1, val reputation: Map<String, Long> = emptyMap(), val dailyCycle: Long = -1,
    val dailyOrderXp: Map<String, Long> = emptyMap(), val dailyPurchaseXp: Map<String, Long> = emptyMap(),
    val weekly: EconomyWeeklyProgress? = null, val weeklyAvailableAt: String? = null, val completedWeekly: Long = 0,
    val activity: Map<String, EconomyTradeActivity> = emptyMap(),
) {
    init {
        require(version == 1 && dailyCycle in -1L..ECONOMY_MAX_REVISION && completedWeekly in 0L..ECONOMY_MAX_REVISION)
        require(validTradeCounts(reputation) && validTradeCounts(dailyOrderXp) && validTradeCounts(dailyPurchaseXp))
        require(activity.size <= 5 && activity.keys.all { it in tradeResidentIds })
        weeklyAvailableAt?.let(Instant::parse)
    }
}
data class EconomyWeeklyOffer(
    val id: String, val templateId: String, val residentId: String, val name: String, val description: String,
    val stages: List<EconomyResidentOrderTemplate>, val coins: Long, val reputationXp: Int,
    val effortSeconds: Long, val manufacturingSeconds: Long, val fishingUncertain: Boolean,
    val pearls: Long = 0,
)
data class EconomyWeeklyBoard(
    val offers: List<EconomyWeeklyOffer>, val active: EconomyResidentOrderOffer?, val progress: EconomyWeeklyProgress?,
    val availableAt: String?, val canChoose: Boolean,
)

/** Account-owned friendship. Reads never award experience or start a weekly. */
object EconomyTradeRelations {
    fun validateCatalog(catalog: EconomyCatalog) {
        val config = catalog.tradeRelations ?: return
        require(config.version == 1 && config.maxBonusBps in 0..1000)
        require(config.ranks.size == 5 && config.ranks.first().requiredXp == 0L && config.ranks.first().bonusBps == 0)
        require(config.ranks.map { it.id }.distinct().size == config.ranks.size)
        require(config.ranks.all { it.id.length in 1..80 && it.name.isNotBlank() && it.requiredXp in 0L..ECONOMY_MAX_ITEMS && it.bonusBps in 0..config.maxBonusBps })
        require(config.ranks.zipWithNext().all { (a, b) -> a.requiredXp < b.requiredXp && a.bonusBps <= b.bonusBps })
        require(config.dailyOrderXpCap in 1..1000 && config.purchaseXp in 0..10 && config.dailyPurchaseXpCap in 0..100)
        config.activity?.let { require(it.graceSeconds in 1..31_536_000L && it.decaySeconds in 1..31_536_000L && it.recoveryBps in 1..10000) }
        require(config.weekly.durationSeconds == 604800L && config.weekly.templates.size in 1..100)
        require(config.weekly.templates.map { it.id }.distinct().size == config.weekly.templates.size)
        val itemIds = catalog.items.map { it.id }.toSet()
        require(config.weekly.templates.all { template ->
            template.id.matches(Regex("[a-z0-9_]{1,40}")) && template.residentId in tradeResidentIds &&
                template.requiredHomeLevel in 1..5 && template.name.isNotBlank() && template.description.length <= 280 &&
                template.requiredBuildings.all { (id, level) -> catalog.buildings.any { it.id == id && it.levels.any { it.level == level } } } &&
                template.stages.size == 3 && template.stages.map { it.id }.distinct().size == 3 && template.stages.withIndex().all { (index, stage) ->
                    stage.id.matches(Regex("[a-z0-9_]{1,40}")) && stage.name.isNotBlank() && stage.description.length <= 280 &&
                        stage.items.isNotEmpty() && stage.items.all { (id, amount) -> id in itemIds && amount in 1L..100L } &&
                        stage.coins in 1L..ECONOMY_MAX_BALANCE && stage.reputationXp in 1..1000 &&
                        stage.effortSeconds in 0L..31_536_000L && stage.manufacturingSeconds in 0L..stage.effortSeconds &&
                        stage.pearls in 0L..140L && stage.pearls % 2L == 0L && (index == 2 || stage.pearls == 0L)
                }
        })
    }

    fun available(state: EconomyState, residentId: String, catalog: EconomyCatalog = EconomyRules.catalog): Boolean = when (residentId) {
        "builder", "plesk" -> true
        "lopukh" -> (state.buildings["woodlot"] ?: 0) >= 1
        "kamneshmyg" -> (state.buildings["quarry"] ?: 0) >= 1
        "leaftail" -> (state.buildings["home"] ?: 1) >= (catalog.leaftailShop?.requiredHomeLevel ?: 3)
        else -> false
    }

    fun normalized(state: EconomyTradeRelationsState, now: Instant): EconomyTradeRelationsState {
        val cycle = Math.floorDiv(now.epochSecond, 86400L)
        return if (state.dailyCycle >= cycle) state else state.copy(dailyCycle = cycle, dailyOrderXp = emptyMap(), dailyPurchaseXp = emptyMap())
    }

    fun activityBps(state: EconomyTradeRelationsState, residentId: String, now: Instant,
        catalog: EconomyCatalog = EconomyRules.catalog): Int {
        val config = catalog.tradeRelations?.activity ?: return 10000
        val saved = state.activity[residentId] ?: return 0
        val elapsed = maxOf(0L, java.time.Duration.between(Instant.parse(saved.updatedAt), now).seconds)
        val decay = (elapsed - config.graceSeconds).coerceIn(0L, config.decaySeconds)
        return maxOf(0, saved.pointsBps - (10000L * decay / config.decaySeconds).toInt())
    }

    private fun refreshActivity(state: EconomyTradeRelationsState, residentId: String, now: Instant,
        catalog: EconomyCatalog): Map<String, EconomyTradeActivity> {
        val config = catalog.tradeRelations?.activity ?: return state.activity
        val saved = state.activity[residentId]
        if (saved != null && now.isBefore(Instant.parse(saved.updatedAt))) return state.activity
        val points = minOf(10000, activityBps(state, residentId, now, catalog) + config.recoveryBps)
        return state.activity + (residentId to EconomyTradeActivity(points, now.toString()))
    }

    fun bonusBps(state: EconomyState, residentId: String, catalog: EconomyCatalog = EconomyRules.catalog,
        now: Instant = Instant.now()): Int {
        val config = catalog.tradeRelations ?: return 0
        val xp = state.tradeRelations.reputation[residentId] ?: 0L
        val permanent = (config.ranks.lastOrNull { it.requiredXp <= xp }?.bonusBps ?: 0).coerceIn(0, minOf(1000, config.maxBonusBps))
        return permanent * activityBps(state.tradeRelations, residentId, now, catalog) / 10000
    }

    fun discount(state: EconomyState, residentId: String, baseUnitPrice: Long, eligible: Boolean,
        catalog: EconomyCatalog = EconomyRules.catalog, now: Instant = Instant.now()): Long {
        require(baseUnitPrice in 0L..ECONOMY_MAX_BALANCE)
        val bps = if (eligible && residentId in setOf("plesk", "leaftail")) bonusBps(state, residentId, catalog, now) else 0
        return (baseUnitPrice * (10000L - bps) + 9999L) / 10000L
    }

    fun awardOrder(state: EconomyState, residentId: String, requested: Int, now: Instant, weekly: Boolean = false,
        catalog: EconomyCatalog = EconomyRules.catalog): EconomyState {
        val config = catalog.tradeRelations ?: return state
        if (residentId !in tradeResidentIds || requested < 0) return state
        val saved = normalized(state.tradeRelations, now)
        val used = (saved.dailyOrderXp[residentId] ?: 0L).coerceIn(0L, config.dailyOrderXpCap.toLong())
        val before = saved.reputation[residentId] ?: 0L
        val amount = minOf(requested.toLong(), 1_000_000L - before, if (weekly) requested.toLong() else config.dailyOrderXpCap - used)
        val reputation = before + amount
        return state.copy(tradeRelations = saved.copy(reputation = saved.reputation + (residentId to reputation),
            dailyOrderXp = if (weekly) saved.dailyOrderXp else saved.dailyOrderXp + (residentId to (used + amount)),
            activity = refreshActivity(saved, residentId, now, catalog)))
    }

    /** Bait never awards XP; a refundable old quote cannot become free friendship. */
    fun purchaseXpEligible(kind: String, paid: Long, resaleCoins: Long = 0): Boolean =
        kind != "bait" && paid > 0 && paid > resaleCoins

    fun awardPurchase(state: EconomyState, residentId: String, paid: Long, now: Instant,
        catalog: EconomyCatalog = EconomyRules.catalog): EconomyState {
        val config = catalog.tradeRelations ?: return state
        if (residentId !in setOf("plesk", "leaftail") || paid <= 0) return state
        val saved = normalized(state.tradeRelations, now)
        val used = (saved.dailyPurchaseXp[residentId] ?: 0L).coerceIn(0L, config.dailyPurchaseXpCap.toLong())
        val before = saved.reputation[residentId] ?: 0L
        val amount = minOf(config.purchaseXp.toLong(), 1_000_000L - before, config.dailyPurchaseXpCap - used)
        if (amount <= 0L) return state
        val reputation = before + amount
        return state.copy(tradeRelations = saved.copy(reputation = saved.reputation + (residentId to reputation),
            dailyPurchaseXp = saved.dailyPurchaseXp + (residentId to (used + amount))))
    }

    /** Conservative merge preserves friendship without multiplying farmed progress or daily allowances. */
    fun merge(a: EconomyTradeRelationsState, b: EconomyTradeRelationsState, now: Instant,
        catalog: EconomyCatalog = EconomyRules.catalog): EconomyTradeRelationsState {
        val first = normalized(a, now); val second = normalized(b, now)
        val config = catalog.tradeRelations
        fun later(x: String?, y: String?): String? = if (x == null) y else if (y == null || !Instant.parse(x).isBefore(Instant.parse(y))) x else y
        val firstActive = first.weekly?.takeIf { now.isBefore(Instant.parse(it.expiresAt)) }
        val secondActive = second.weekly?.takeIf { now.isBefore(Instant.parse(it.expiresAt)) }
        fun consumedWindow(saved: EconomyTradeRelationsState, active: EconomyWeeklyProgress?) = active == null &&
            saved.weeklyAvailableAt?.let { now.isBefore(Instant.parse(it)) } == true
        // A finished overlapping window wins over another account's uncompleted
        // promise. Otherwise repeated guest merges could reopen the same week.
        val weekly = when {
            consumedWindow(first, firstActive) || consumedWindow(second, secondActive) -> null
            firstActive != null && secondActive != null && firstActive.id == secondActive.id &&
                firstActive.templateId == secondActive.templateId && firstActive.residentId == secondActive.residentId &&
                firstActive.stages == secondActive.stages ->
                if (firstActive.stage >= secondActive.stage) firstActive else secondActive
            else -> firstActive ?: secondActive
        }
        return first.copy(dailyCycle = maxOf(first.dailyCycle, second.dailyCycle), reputation = tradeResidentIds.associateWith { maxOf(first.reputation[it] ?: 0L, second.reputation[it] ?: 0L) },
            activity = tradeResidentIds.mapNotNull { resident ->
                val candidates = listOfNotNull(first.activity[resident]?.let { first }, second.activity[resident]?.let { second })
                val chosen = candidates.maxByOrNull { activityBps(it, resident, now, catalog) }
                chosen?.activity?.get(resident)?.let { resident to it }
            }.toMap(),
            dailyOrderXp = tradeResidentIds.associateWith { minOf((config?.dailyOrderXpCap ?: 60).toLong(), (first.dailyOrderXp[it] ?: 0L) + (second.dailyOrderXp[it] ?: 0L)) },
            dailyPurchaseXp = tradeResidentIds.associateWith { minOf((config?.dailyPurchaseXpCap ?: 2).toLong(), (first.dailyPurchaseXp[it] ?: 0L) + (second.dailyPurchaseXp[it] ?: 0L)) },
            weekly = weekly?.takeIf { now.isBefore(Instant.parse(it.expiresAt)) },
            weeklyAvailableAt = later(first.weeklyAvailableAt, second.weeklyAvailableAt),
            completedWeekly = minOf(ECONOMY_MAX_REVISION, first.completedWeekly + second.completedWeekly))
    }

    private fun pairs(values: Map<String, Number>) = JsonArray(values.toSortedMap().map { (id, amount) ->
        JsonArray(listOf(JsonPrimitive(id), JsonPrimitive(amount)))
    })
    private fun choiceFingerprint(template: EconomyWeeklyTemplate): Long = EconomyFood.hash(JsonArray(listOf(
        JsonPrimitive(template.id), JsonPrimitive(template.residentId), JsonPrimitive(template.requiredHomeLevel), pairs(template.requiredBuildings),
        JsonArray(template.stages.map { stage -> JsonArray(listOf(JsonPrimitive(stage.id), pairs(stage.items), JsonPrimitive(stage.coins),
            JsonPrimitive(stage.reputationXp), JsonPrimitive(stage.effortSeconds), JsonPrimitive(stage.manufacturingSeconds), JsonPrimitive(stage.fishingUncertain)) +
            if (stage.pearls > 0L) listOf(JsonPrimitive(stage.pearls)) else emptyList()) }),
    )).toString())

    fun weeklyBoard(state: EconomyState, now: Instant, catalog: EconomyCatalog = EconomyRules.catalog): EconomyWeeklyBoard {
        val config = catalog.tradeRelations?.weekly
        val saved = state.tradeRelations
        val progress = saved.weekly?.takeIf { now.isBefore(Instant.parse(it.expiresAt)) }
        val active = progress?.let { weekly ->
            val terms = weekly.stages[weekly.stage]
            EconomyResidentOrderOffer("${weekly.id}_${weekly.stage}_${EconomyFood.fingerprint(terms)}", -1, terms.id,
                weekly.residentId, terms.name, terms.items, terms.coins, weekly.acceptedAt, terms.description,
                reputationXp = terms.reputationXp, effortSeconds = terms.effortSeconds, manufacturingSeconds = terms.manufacturingSeconds,
                fishingUncertain = terms.fishingUncertain, weekly = true, stage = weekly.stage, stages = 3, expiresAt = weekly.expiresAt,
                requiredBuildings = terms.requiredBuildings, pearls = terms.pearls)
        }
        val canChoose = config != null && progress == null && (saved.weeklyAvailableAt == null || !now.isBefore(Instant.parse(saved.weeklyAvailableAt)))
        if (!canChoose) return EconomyWeeklyBoard(emptyList(), active, progress, saved.weeklyAvailableAt, false)
        val reachable = EconomyFood.obtainableOrderItems(state, catalog)
        val eligible = checkNotNull(config).templates.filter { template -> available(state, template.residentId, catalog) &&
            (state.buildings["home"] ?: 1) >= template.requiredHomeLevel &&
            template.requiredBuildings.all { (id, level) -> (state.buildings[id] ?: 0) >= level } &&
            template.stages.all { stage -> stage.items.keys.all { it in reachable } }
        }.sortedBy { it.id }
        val cycle = Math.floorDiv(now.epochSecond, 604800L)
        val offers = tradeResidentIds.flatMap { resident -> listOf("ordinary", "challenging", "masterful").mapNotNull { difficulty ->
            val pool = eligible.filter { it.residentId == resident && orderDifficulty(it.stages.sumOf { stage -> stage.effortSeconds }, true) == difficulty }
            if (pool.isEmpty()) return@mapNotNull null
            val template = pool[(EconomyFood.hash("weekly1:$cycle:$resident:$difficulty") % pool.size).toInt()]
            val stages = template.stages.map { stage -> EconomyResidentOrderTemplate(
                stage.id, template.residentId, stage.name,
                requiredBuildings = mapOf("home" to template.requiredHomeLevel) + template.requiredBuildings,
                items = stage.items, coins = stage.coins, description = stage.description,
                reputationXp = stage.reputationXp, effortSeconds = stage.effortSeconds,
                manufacturingSeconds = stage.manufacturingSeconds, fishingUncertain = stage.fishingUncertain, pearls = stage.pearls,
            ) }
            EconomyWeeklyOffer("weekly_choice1_${template.id}_${choiceFingerprint(template)}", template.id, template.residentId,
                template.name, template.description, stages, stages.sumOf { it.coins }, stages.sumOf { it.reputationXp ?: 0 },
                stages.sumOf { it.effortSeconds ?: 0L }, stages.sumOf { it.manufacturingSeconds ?: 0L }, stages.any { it.fishingUncertain == true }, stages.sumOf { it.pearls })
        } }
        return EconomyWeeklyBoard(offers, active, null, saved.weeklyAvailableAt, true)
    }

    fun orderDifficulty(effortSeconds: Long, weekly: Boolean = false): String {
        val ordinary = if (weekly) 10800L else 1800L
        val challenging = if (weekly) 36000L else 7200L
        return if (effortSeconds < ordinary) "ordinary" else if (effortSeconds < challenging) "challenging" else "masterful"
    }

    fun accept(state: EconomyState, command: EconomyCommand, now: Instant): Pair<EconomyState, String> {
        if (command.quantity != 1L || command.totalPrice != 0L || command.fishSelection != null) invalidEconomy()
        val config = EconomyRules.catalog.tradeRelations?.weekly ?: economyFailure("ECONOMY_WEEKLY_UNAVAILABLE", "Большие поручения пока недоступны")
        val board = weeklyBoard(state, now)
        if (!board.canChoose) economyFailure("ECONOMY_WEEKLY_UNAVAILABLE", "Сначала завершите текущее поручение или дождитесь следующей недели")
        val offer = board.offers.find { it.id == command.targetId }
            ?: economyFailure("ECONOMY_WEEKLY_CHANGED", "Поручения обновились. Проверьте условия ещё раз")
        val expiry = now.plusSeconds(config.durationSeconds).toString()
        val weekly = EconomyWeeklyProgress("weekly1_${now.epochSecond}_${EconomyFood.hash(offer.id)}", offer.templateId, offer.residentId,
            offer.name, offer.description, offer.stages, 0, now.toString(), expiry)
        return state.copy(tradeRelations = normalized(state.tradeRelations, now).copy(weekly = weekly, weeklyAvailableAt = expiry)) to
            "Поручение принято. На три поставки есть семь дней"
    }

    fun complete(state: EconomyState, command: EconomyCommand, now: Instant): Pair<EconomyState, String> {
        state.tradeRelations.weekly?.let {
            if (!now.isBefore(Instant.parse(it.expiresAt))) economyFailure("ECONOMY_WEEKLY_EXPIRED", "Срок поручения закончился. Полученные награды сохранены")
        }
        val board = weeklyBoard(state, now)
        val offer = board.active?.takeIf { it.id == command.targetId }
            ?: economyFailure("ECONOMY_WEEKLY_CHANGED", "Этот этап поручения больше недоступен")
        if (now.isBefore(Instant.parse(offer.availableAt)))
            economyFailure("ECONOMY_WEEKLY_UNAVAILABLE", "Поручение ещё недоступно")
        val progress = checkNotNull(board.progress)
        val terms = progress.stages[progress.stage]
        EconomyRules.requireBuildings(state, terms.requiredBuildings)
        val orders = EconomyFood.normalizedOrders(state, now)
        val last = progress.stage == progress.stages.lastIndex
        if (offer.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || offer.pearls > ECONOMY_MAX_PEARLS - state.wallet.pearls ||
            orders.completed >= ECONOMY_MAX_REVISION || offer.coins > ECONOMY_MAX_REVISION - orders.earnedCoins ||
            last && state.tradeRelations.completedWeekly >= ECONOMY_MAX_REVISION)
            economyFailure("ECONOMY_CAPACITY", "Кошелёк достиг предела")
        val spent = EconomyRules.spend(state, EconomyCost(items = offer.items), command.fishSelection)
        val paid = spent.copy(wallet = spent.wallet.copy(coins = spent.wallet.coins + offer.coins, pearls = spent.wallet.pearls + offer.pearls),
            residentOrders = orders.copy(completed = orders.completed + 1, earnedCoins = orders.earnedCoins + offer.coins),
            tradeRelations = spent.tradeRelations.copy(weekly = if (last) null else progress.copy(stage = progress.stage + 1),
                completedWeekly = spent.tradeRelations.completedWeekly + if (last) 1 else 0))
        return awardOrder(paid, progress.residentId, terms.reputationXp ?: 0, now, weekly = true) to
            if (last) "Большое поручение выполнено. Монеты и репутация получены" else "Поставка принята. Монеты и репутация получены"
    }
}
