package ru.zhiv.economy

import ru.zhiv.auth.AuthFailure
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.UUID

object EconomyBoats {
    val actions = setOf("start_boat_upgrade", "claim_boat_upgrade", "depart_boat", "begin_boat_cast", "submit_boat_cast", "return_boat", "claim_boat")
    private val entropy = SecureRandom()
    private val config get() = checkNotNull(EconomyRules.catalog.boat)
    fun returnStartedAt(v: EconomyBoatVoyage): Instant = Instant.parse(v.returnStartedAt ?: v.fishingUntil)
    fun returnsAt(v: EconomyBoatVoyage): Instant = v.returnsAt?.let(Instant::parse) ?: returnStartedAt(v).plusSeconds(v.inboundSeconds)
    fun phase(boat: EconomyBoatState, now: Instant): String {
        val v = boat.voyage ?: return if (boat.level > 0) "docked" else if (boat.work != null) "repairing" else "broken"
        return when {
            !now.isBefore(returnsAt(v)) -> "ready"
            !now.isBefore(returnStartedAt(v)) -> "returning"
            now.isBefore(Instant.parse(v.arrivesAt)) -> "outbound"
            else -> "fishing"
        }
    }
    fun publicView(value: EconomyBoatState?): EconomyBoatView {
        val b = value ?: EconomyBoatState()
        val voyage = b.voyage?.let { v -> EconomyBoatVoyageView(v.id, v.routeId, v.departedAt, v.arrivesAt, v.fishingUntil,
            v.maxCasts, v.maxCatches, v.castsUsed, v.catches, v.loadout, v.outboundSeconds, v.inboundSeconds,
            v.returnStartedAt, v.returnsAt, v.challenge) }
        return EconomyBoatView(b.version, b.level, b.upgrades, b.blueprints, b.artifacts, b.completedVoyages, b.qualifiedVoyages, b.records, b.work, voyage)
    }
    fun fishWeight(minGrams: Int, maxGrams: Int, first: Int, second: Int): Int {
        require(minGrams in 1 until maxGrams && maxGrams <= 1_000_000 && first in 0..10000 && second in 0..10000)
        return minGrams + ((maxGrams - minGrams).toLong() * first * second / 100_000_000L).toInt()
    }
    fun claimPracticeSeconds(before: EconomyBoatState?, after: EconomyBoatState?, action: String): Long {
        val v = before?.voyage ?: return 0L
        return if (action == "claim_boat" && after?.voyage == null) (v.outboundSeconds + v.inboundSeconds) * v.catches.size / v.maxCatches else 0L
    }
    private fun upgradeReason(state: EconomyState, id: String): String? {
        val b = state.boat ?: EconomyBoatState()
        val u = config.upgrades.find { it.id == id } ?: return "Улучшение не найдено"
        if (b.work != null || state.jobs.any { it.kind == "construction" }) return "Строитель занят. Сначала завершите текущую работу"
        if (b.voyage != null) return "Сначала вернитесь и заберите улов"
        if (id == "repair" && b.level > 0) return "Лодка уже восстановлена"
        if (id != "repair" && b.level == 0) return "Сначала восстановите лодку"
        if (id in b.upgrades || id in b.artifacts) return "Улучшение уже готово"
        if ((state.buildings["home"] ?: 1) < u.requiredHomeLevel) return "Нужен дом уровня ${u.requiredHomeLevel}"
        if (u.requiredBuildings.any { (building, level) -> (state.buildings[building] ?: 0) < level }) return "Сначала улучшите мастерскую"
        if (u.blueprint != null && b.blueprints.pages(u.blueprint) < 3) return "Соберите три страницы чертежа"
        if (state.wallet.coins < u.cost.coins || u.cost.items.any { (item, count) -> (state.inventory[item] ?: 0L) < count }) return "Не хватает монет или материалов"
        return null
    }
    private fun departureReason(state: EconomyState, now: Instant): String? {
        val b = state.boat ?: EconomyBoatState()
        if (b.level == 0) return "Сначала восстановите лодку"
        if (b.work != null) return "Дождитесь улучшения лодки и заберите работу"
        if (b.voyage != null) return "Сначала вернитесь и заберите улов"
        try { EconomyRules.requireActorAvailable(state, now) } catch (failure: AuthFailure) { return failure.message }
        val t = state.fishing; val fishing = EconomyRules.catalog.fishing ?: return "Выберите свои удочку и крючок"
        if (t.equippedRodId !in t.ownedRods || fishing.rods.none { it.id == t.equippedRodId } ||
            t.equippedHookId !in t.ownedHooks || fishing.hooks.none { it.id == t.equippedHookId }) return "Выберите свои удочку и крючок"
        if (t.equippedBaitId != null && (!EconomyRules.fishingBaitCompatible(t.equippedRodId, t.equippedBaitId, fishing) ||
            (state.inventory[t.equippedBaitId] ?: 0L) <= 0L)) return "Проверьте запас и совместимость наживки"
        return null
    }

    fun command(state: EconomyState, command: EconomyCommand, now: Instant, reserved: Map<String, Long> = emptyMap(),
        random: (Long) -> Long = entropy::nextLong, id: () -> String = { UUID.randomUUID().toString() }): Pair<EconomyState, String> {
        val b = state.boat ?: EconomyBoatState()
        fun draw(maximum: Long): Long = random(maximum).also { require(it in 0 until maximum) }
        when (command.action) {
            "start_boat_upgrade" -> {
                upgradeReason(state, command.targetId)?.let { economyFailure("ECONOMY_BOAT_UPGRADE", it) }
                val u = config.upgrades.single { it.id == command.targetId }
                val spent = EconomyRules.spend(state, u.cost)
                return spent.copy(boat = b.copy(work = EconomyBoatWork(id(), u.id, now.toString(), now.plusSeconds(u.seconds).toString(), u.cost))) to
                    if (u.id == "repair") "Начат ремонт лодки" else "Улучшение лодки началось"
            }
            "claim_boat_upgrade" -> {
                val work = b.work?.takeIf { it.id == command.targetId } ?: economyFailure("ECONOMY_BOAT_WORK_GONE", "Работа уже получена или изменилась")
                if (now.isBefore(Instant.parse(work.finishesAt))) economyFailure("ECONOMY_BOAT_WORK_WAIT", "Работа ещё не закончена")
                val next = when (work.upgradeId) {
                    "repair" -> b.copy(level = 1, work = null)
                    "crate", "oars" -> b.copy(upgrades = (b.upgrades + work.upgradeId).distinct(), work = null)
                    else -> b.copy(artifacts = (b.artifacts + work.upgradeId).distinct(), work = null)
                }
                return state.copy(boat = next) to "Лодка готова. Улучшение получено"
            }
            "depart_boat" -> {
                if (command.targetId != config.routeId) economyFailure("ECONOMY_BOAT_ROUTE", "Место рыбалки не найдено")
                departureReason(state, now)?.let { economyFailure("ECONOMY_BOAT_DEPARTURE", it) }
                val t = state.fishing
                val outbound = if ("oars" in b.upgrades) config.oarsTravelSeconds else config.outboundSeconds
                val inbound = if ("oars" in b.upgrades) config.oarsTravelSeconds else config.inboundSeconds
                val casts = config.maxCasts + if ("crate" in b.upgrades) 1 else 0
                val loadout = EconomyBoatLoadout(t.equippedRodId, t.equippedHookId, t.equippedBaitId)
                val cost = EconomyCost(items = t.equippedBaitId?.let { mapOf(it to 1L) } ?: emptyMap())
                val spent = EconomyRules.spend(state, cost)
                val seed = "boat:${draw(0x1_0000_0000L)}:${draw(0x1_0000_0000L)}"
                val slots = (0 until casts).map { index ->
                    val fish = EconomyRules.selectFishingCatch(seed, loadout.rodId, loadout.baitId, loadout.hookId, index)
                    val weight = config.weights.getValue(fish)
                    val grams = fishWeight(weight.minGrams, weight.maxGrams, draw(10001).toInt(), draw(10001).toInt())
                    val rarity = checkNotNull(EconomyRules.catalog.fishing).fish.single { it.itemId == fish }.rarity
                    val difficulty = minOf(5, fishingShopRarities.indexOf(rarity) + 1 + if ((grams - weight.minGrams).toLong() * 100 > (weight.maxGrams - weight.minGrams).toLong() * 65) 1 else 0)
                    EconomyBoatSlot(fish, grams, draw(0x1_0000_0000L), difficulty, if ("landing_net" in b.artifacts) config.netZoneWidth else config.zoneWidth)
                }
                val voyage = EconomyBoatVoyage(id(), config.routeId, now.toString(), now.plusSeconds(outbound).toString(),
                    now.plusSeconds(outbound + config.activeSeconds).toString(), casts, casts, loadout = loadout,
                    outboundSeconds = outbound, inboundSeconds = inbound, slots = slots)
                return spent.copy(boat = b.copy(voyage = voyage)) to "Мохлик отправился на речной плёс"
            }
        }
        val v = b.voyage?.takeIf { it.id == command.targetId } ?: economyFailure("ECONOMY_BOAT_VOYAGE_GONE", "Поездка уже завершена или изменилась")
        val phase = phase(b, now)
        when (command.action) {
            "begin_boat_cast" -> {
                if (phase != "fishing") economyFailure("ECONOMY_BOAT_PHASE", "Заброс доступен только на речном плёсе")
                if (v.challenge != null && now.isBefore(Instant.parse(v.challenge.expiresAt))) economyFailure("ECONOMY_BOAT_CAST_ACTIVE", "Завершите текущую поклёвку")
                if (v.castsUsed >= v.maxCasts || v.catches.size >= v.maxCatches) economyFailure("ECONOMY_BOAT_CAST_LIMIT", "Забросы закончились. Пора возвращаться")
                val slot = v.slots[v.castsUsed]
                val expiry = minOf(now.plusSeconds(config.castExpirySeconds), Instant.parse(v.fishingUntil))
                val biteAt = now.plusSeconds(4 + slot.challengeSeed % 4)
                if (!biteAt.plusMillis(50).isBefore(expiry)) economyFailure("ECONOMY_BOAT_CAST_WAIT", "Для нового заброса не хватает времени. Пора возвращаться")
                val rarity = checkNotNull(EconomyRules.catalog.fishing).fish.single { it.itemId == slot.fishId }.rarity
                val challenge = EconomyBoatChallenge(id(), rulesVersion = 2, resistance = EconomyBoatReel.resistanceForClass(rarity, slot.challengeSeed), seed = slot.challengeSeed, zoneWidth = slot.zoneWidth, difficulty = slot.difficulty,
                    startedAt = now.toString(), expiresAt = expiry.toString(), biteAt = biteAt.toString(), fishRarity = rarity)
                return state.copy(boat = b.copy(voyage = v.copy(castsUsed = v.castsUsed + 1, challenge = challenge))) to "Удочка заброшена. Ждём поклёвку"
            }
            "submit_boat_cast" -> {
                val reel = command.reel
                val challenge = v.challenge?.takeIf { reel != null && it.id == reel.challengeId } ?: economyFailure("ECONOMY_BOAT_CAST_GONE", "Эта поклёвка уже закончилась")
                if (phase != "fishing" || !now.isBefore(Instant.parse(challenge.expiresAt))) economyFailure("ECONOMY_BOAT_CAST_EXPIRED", "Рыба ушла. Можно сделать следующий заброс")
                if (Duration.between(Instant.parse(challenge.biteAt ?: challenge.startedAt), now).toMillis() < checkNotNull(reel).endTick * challenge.tickMs)
                    economyFailure("ECONOMY_BOAT_TRACE", "Дождитесь поклёвки и завершите вываживание")
                val result = try { EconomyBoatReel.replay(challenge, checkNotNull(reel)) }
                    catch (_: IllegalArgumentException) { economyFailure("ECONOMY_BOAT_TRACE", "Не удалось проверить управление удочкой") }
                    catch (_: AuthFailure) { economyFailure("ECONOMY_BOAT_TRACE", "Не удалось проверить управление удочкой") }
                val catches = if (result.status == "caught") {
                    if (v.catches.size >= v.maxCatches) economyFailure("ECONOMY_BOAT_CAST_LIMIT", "Ящик уже заполнен")
                    val slot = v.slots[v.castsUsed - 1]
                    v.catches + EconomyBoatCatch(v.castsUsed - 1, slot.fishId, slot.weightGrams, now.toString())
                } else v.catches
                return state.copy(boat = b.copy(voyage = v.copy(catches = catches, challenge = null))) to
                    if (result.status == "caught") "Рыба в лодке! Заберите улов после возвращения" else "Рыба сорвалась"
            }
            "return_boat" -> {
                if (phase != "fishing") economyFailure("ECONOMY_BOAT_PHASE", "Лодка ещё в пути или уже возвращается")
                return state.copy(boat = b.copy(voyage = v.copy(challenge = null, returnStartedAt = now.toString(), returnsAt = now.plusSeconds(v.inboundSeconds).toString()))) to "Мохлик возвращается к берегу"
            }
        }
        if (command.action != "claim_boat" || phase != "ready") economyFailure("ECONOMY_BOAT_PHASE", "Дождитесь возвращения лодки")
        val rewards = v.catches.groupingBy { it.fishId }.eachCount().mapValues { it.value.toLong() }
        var next = EconomyFishStock.credit(state.copy(inventory = EconomyRules.addItems(state.inventory, rewards)), rewards)
        EconomyRules.assertStorageTransition(state, next, reserved)
        val catches = next.fishing.catches.toMutableMap()
        rewards.forEach { (fish, count) -> catches[fish] = minOf(ECONOMY_MAX_ITEMS, (catches[fish] ?: 0L) + count) }
        val records = b.records.toMutableMap()
        v.catches.forEach { fish -> if ((records[fish.fishId]?.weightGrams ?: 0) < fish.weightGrams) records[fish.fishId] = EconomyBoatRecord(fish.weightGrams, fish.caughtAt) }
        val qualified = minOf(1_000_000_000L, b.qualifiedVoyages + if (v.castsUsed == v.maxCasts && v.catches.isNotEmpty()) 1 else 0)
        next = next.copy(fishing = next.fishing.copy(catches = catches), boat = b.copy(voyage = null,
            records = records, completedVoyages = minOf(1_000_000_000L, b.completedVoyages + 1), qualifiedVoyages = qualified))
        if (v.catches.isNotEmpty()) next = next.copy(completedExplorations = minOf(ECONOMY_MAX_ITEMS, next.completedExplorations + 1),
            progression = next.progression.copy(routes = next.progression.routes + (v.routeId to minOf(ECONOMY_MAX_ITEMS, (next.progression.routes[v.routeId] ?: 0L) + 1))),
            unlockedItems = (next.unlockedItems + rewards.keys).distinct())
        return next to if (v.catches.isNotEmpty()) "Улов получен: ${v.catches.size}" else "Мохлик вернулся с рыбалки"
    }

    /** Active work and cargo must be settled before this merge; neither may disappear. */
    fun merge(a: EconomyBoatState?, b: EconomyBoatState?): EconomyBoatState? {
        if (a == null && b == null) return null
        val first = a ?: EconomyBoatState(); val second = b ?: EconomyBoatState()
        require(first.work == null && second.work == null && first.voyage == null && second.voyage == null)
        val records = (first.records.keys + second.records.keys).associateWith { id ->
            listOfNotNull(first.records[id], second.records[id]).sortedWith(compareByDescending<EconomyBoatRecord> { it.weightGrams }.thenBy { Instant.parse(it.caughtAt) }).first()
        }
        return EconomyBoatState(level = maxOf(first.level, second.level), upgrades = (first.upgrades + second.upgrades).distinct().sorted(),
            blueprints = EconomyBoatBlueprints(maxOf(first.blueprints.landing_net, second.blueprints.landing_net), maxOf(first.blueprints.telescope, second.blueprints.telescope)),
            artifacts = (first.artifacts + second.artifacts).distinct().sorted(), records = records,
            completedVoyages = maxOf(first.completedVoyages, second.completedVoyages), qualifiedVoyages = maxOf(first.qualifiedVoyages, second.qualifiedVoyages))
    }
}
