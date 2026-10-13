package ru.zhiv.notifications

import ru.zhiv.economy.EconomyJob
import ru.zhiv.economy.EconomyRules
import java.util.Locale

internal data class NotificationMessage(val title: String, val body: String)
internal data class NotificationMessageEvent(val category: String, val job: EconomyJob? = null, val phase: String? = null, val storageBlocked: Boolean = false)

private data class NotificationSection(val full: String, val short: String)
private data class CountedResource(val one: String, val few: String, val many: String)

/** Names describe inventory units; food/provisions are portions, mass resources use explicit units. */
private val resourceWords = mapOf(
    "berries" to CountedResource("ягода", "ягоды", "ягод"),
    "wood" to CountedResource("ед. древесины", "ед. древесины", "ед. древесины"),
    "stone" to CountedResource("камень", "камня", "камней"),
    "ore" to CountedResource("ед. железной руды", "ед. железной руды", "ед. железной руды"),
    "fiber" to CountedResource("пучок волокна", "пучка волокна", "пучков волокна"),
    "fish" to CountedResource("рыба", "рыбы", "рыб"),
    "planks" to CountedResource("доска", "доски", "досок"),
    "rope" to CountedResource("верёвка", "верёвки", "верёвок"),
    "metal_parts" to CountedResource("металлическая деталь", "металлические детали", "металлических деталей"),
    "clay" to CountedResource("ед. глины", "ед. глины", "ед. глины"),
    "sand" to CountedResource("ед. песка", "ед. песка", "ед. песка"),
    "charcoal" to CountedResource("ед. древесного угля", "ед. древесного угля", "ед. древесного угля"),
    "iron_ingot" to CountedResource("железный слиток", "железных слитка", "железных слитков"),
    "bricks" to CountedResource("кирпич", "кирпича", "кирпичей"),
    "glass" to CountedResource("лист стекла", "листа стекла", "листов стекла"),
    "hardwood" to CountedResource("ед. твёрдой древесины", "ед. твёрдой древесины", "ед. твёрдой древесины"),
    "resin" to CountedResource("ед. смолы", "ед. смолы", "ед. смолы"),
    "cloth" to CountedResource("полотно", "полотна", "полотен"),
    "beams" to CountedResource("балка", "балки", "балок"),
    "tools" to CountedResource("набор инструментов", "набора инструментов", "наборов инструментов"),
    "reinforced_parts" to CountedResource("усиленный узел", "усиленных узла", "усиленных узлов"),
    "cut_stone" to CountedResource("тёсаный камень", "тёсаных камня", "тёсаных камней"),
) + mapOf(
    "dried_berries" to "сушёных ягод", "smoked_fish" to "копчёной рыбы",
    "grilled_fish" to "жареной рыбы", "fish_soup" to "ухи", "berry_fish" to "рыбы с ягодным соусом",
    "hearty_fish" to "сытного рыбного ужина", "epic_fish" to "праздничной рыбы", "legendary_fish" to "акульего жаркого",
).mapValues { (_, food) -> CountedResource("порция $food", "порции $food", "порций $food") }

private fun quantityForm(quantity: Long): Int = when {
    quantity % 100 in 11L..14L -> 2
    quantity % 10 == 1L -> 0
    quantity % 10 in 2L..4L -> 1
    else -> 2
}

private fun countedResource(id: String, quantity: Long): String {
    val words = resourceWords[id]
    if (words != null) return "$quantity ${listOf(words.one, words.few, words.many)[quantityForm(quantity)]}"
    val name = EconomyRules.catalog.items.firstOrNull { it.id == id }?.name?.lowercase(Locale.ROOT) ?: return ""
    return "$name × $quantity"
}

private fun joinedResources(rewards: Map<String, Long>): String {
    val names = EconomyRules.catalog.items.mapNotNull { item ->
        rewards[item.id]?.takeIf { it > 0 && item.category != "special" }?.let { countedResource(item.id, it) }
    }
    return when (names.size) {
        0 -> ""
        1 -> names.single()
        else -> names.dropLast(1).joinToString(", ") + " и " + names.last()
    }
}

private fun totalRewards(events: List<NotificationMessageEvent>): Map<String, Long> {
    val totals = mutableMapOf<String, Long>()
    events.forEach { event -> event.job?.rewards?.forEach { (id, quantity) ->
        if (quantity > 0) {
            val previous = totals[id] ?: 0L
            totals[id] = previous + quantity.coerceAtMost(Long.MAX_VALUE - previous)
        }
    } }
    return totals
}

private fun explorationSection(events: List<NotificationMessageEvent>): NotificationSection {
    val routes = events.map { it.job?.takeIf { job -> job.kind == "exploration" }?.targetId }.distinct().sortedWith(nullsLast())
    val descriptions = routes.map { id ->
        val route = EconomyRules.catalog.explorations.firstOrNull { it.id == id }
        when {
            route == null -> "Мохлик вернулся из путешествия. Можно разобрать находки."
            route.id in EconomyRules.catalog.fishing?.routeIds.orEmpty() -> "Мохлик вернулся с рыбалки. Можно разобрать улов."
            route.id == "abandoned_quarry" -> "Мохлик вернулся из заброшенного карьера. Можно забрать добычу."
            route.activity == "mining" -> "Мохлик вернулся из шахты. Можно забрать добычу."
            route.id in setOf("forest", "forest_camp") -> "Мохлик вернулся из леса. Можно разобрать находки."
            route.id == "old_woodland" -> "Мохлик вернулся из старого леса. Можно разобрать находки."
            route.id == "coastal_deposits" -> "Мохлик вернулся с прибрежных отложений. Можно забрать добычу."
            route.id == "uplands" -> "Мохлик вернулся из лесного нагорья. Можно разобрать находки."
            else -> "Мохлик завершил маршрут «${route.name.substringBefore(" ·")}». Можно разобрать находки."
        }
    }.distinct()
    // Never read exploration rewards/fishing/rareDrop: the unrevealed outcome is intentionally private.
    return NotificationSection(descriptions.joinToString(" "), "Мохлик вернулся. Можно разобрать находки.")
}

private fun constructionSection(events: List<NotificationMessageEvent>): NotificationSection {
    val descriptions = events.mapNotNull { event ->
        val job = event.job?.takeIf { it.kind == "construction" } ?: return@mapNotNull null
        val building = EconomyRules.catalog.buildings.firstOrNull { it.id == job.targetId } ?: return@mapNotNull null
        val level = job.targetLevel?.takeIf { value -> building.levels.any { it.level == value } }
            ?: return@mapNotNull null
        "${building.name}: ${if (level == 1) "строительство завершено" else "улучшение до уровня $level завершено"}."
    }.distinct().sorted()
    val fallback = "Стройка завершена. Откройте постройку, чтобы принять работу."
    return NotificationSection(if (descriptions.isEmpty()) fallback else descriptions.joinToString(" ") + " Можно принять работу.", fallback)
}

private fun productionSection(events: List<NotificationMessageEvent>): NotificationSection {
    // A saved collection stage is authoritative. Legacy berry jobs without it are immediately claimable.
    val storageBlocked = events.any { it.storageBlocked }
    val takeResult = if (storageBlocked) "Освободите место в кладовой." else "Можно забрать в кладовую."
    val startHarvest = if (storageBlocked) "Освободите место в кладовой." else "Откройте куст, чтобы Мохлик собрал урожай."
    val harvest = events.filter { it.job?.collection != null && it.phase != "collected" }
    val collected = events.filter { it.job?.collection != null && it.phase == "collected" }
    val ready = events - harvest.toSet() - collected.toSet()
    val sentences = buildList {
        if (harvest.isNotEmpty()) {
            val rewards = totalRewards(harvest)
            val berries = rewards["berries"] ?: 0L
            if (berries > 0) {
                val predicate = if (quantityForm(berries) == 0) "готова" else "готовы"
                add("${countedResource("berries", berries)} $predicate к сбору.")
                val extra = joinedResources(rewards - "berries")
                if (extra.isNotEmpty()) add("Вместе с урожаем: $extra.")
                add(startHarvest)
            }
        }
        if (collected.isNotEmpty()) {
            val resources = joinedResources(totalRewards(collected))
            add(if (resources.isEmpty()) "Урожай собран. $takeResult" else "Урожай собран: $resources. $takeResult")
        }
        if (ready.isNotEmpty()) {
            val resources = joinedResources(totalRewards(ready.filter { it.job?.kind == "production" }))
            add(if (resources.isEmpty()) "Производство завершено. $takeResult" else "Готово: $resources. $takeResult")
        }
    }
    val short = when {
        harvest.isNotEmpty() && (ready.isNotEmpty() || collected.isNotEmpty()) -> "Ресурсы готовы. Ягоды у куста ещё нужно собрать. ${if (storageBlocked) "Освободите место в кладовой." else ""}".trim()
        harvest.isNotEmpty() -> "Ягоды готовы к сбору. $startHarvest"
        collected.isNotEmpty() && ready.isEmpty() -> "Урожай собран. $takeResult"
        else -> "Ресурсы готовы. $takeResult"
    }
    return NotificationSection(sentences.joinToString(" ").ifEmpty { short }, short)
}

/** The OS supplies the app identity. Titles describe events; bodies never claim resources were credited. */
internal fun notificationMessage(events: List<NotificationMessageEvent>): NotificationMessage {
    val unique = events.distinctBy { Triple(it.category, it.job?.id, it.phase) }
    val collectedIds = unique.filter { it.category == "production" && it.job?.collection != null && it.phase == "collected" }
        .mapNotNull { it.job?.id }.toSet()
    val current = unique.filterNot { it.category == "production" && it.phase == "harvest" && it.job?.id in collectedIds }
    val grouped = current.groupBy { it.category }
    val sections = buildList {
        grouped["exploration"]?.let { add(explorationSection(it)) }
        grouped["construction"]?.let { add(constructionSection(it)) }
        grouped["production"]?.let { add(productionSection(it)) }
        if ("checkin" in grouped) add(NotificationSection("С последней отметки прошло больше суток. Дайте близким знать, что вы в порядке.", "Пора отметиться: дайте близким знать, что вы в порядке."))
    }.ifEmpty { listOf(NotificationSection("На полянке есть новости. Загляните к Мохлику.", "На полянке есть новости. Загляните к Мохлику.")) }
    val title = when (grouped.keys.singleOrNull()) {
        "exploration" -> "Мохлик вернулся"
        "construction" -> "Стройка завершена"
        "production" -> "Ресурсы готовы"
        "checkin" -> "Пора отметиться"
        else -> "Новости полянки"
    }
    val bodies = sections.map { it.full }.toMutableList()
    while (bodies.joinToString(" ").length > 360) {
        val index = sections.indices.filter { bodies[it] != sections[it].short }
            .maxByOrNull { bodies[it].length - sections[it].short.length } ?: break
        bodies[index] = sections[index].short
    }
    return NotificationMessage(title, bodies.joinToString(" "))
}
