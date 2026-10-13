package ru.zhiv.notifications

import org.junit.jupiter.api.Test
import ru.zhiv.economy.EconomyCollection
import ru.zhiv.economy.EconomyFishingCatch
import ru.zhiv.economy.EconomyJob
import ru.zhiv.economy.EconomyRareDropDelivery
import ru.zhiv.economy.EconomyRules
import kotlin.test.*

class NotificationMessagesTest {
    private val startedAt = "2026-10-13T08:00:00Z"
    private val finishesAt = "2026-10-13T09:00:00Z"
    private fun job(kind: String, target: String, rewards: Map<String, Long> = emptyMap(), id: String = "$kind:$target") =
        EconomyJob(id, kind, target, startedAt = startedAt, finishesAt = finishesAt, rewards = rewards)
    private fun berries(quantity: Long, id: String = "berries") =
        job("production", "garden", mapOf("berries" to quantity), id).copy(recipeId = "grow_berries",
            collection = EconomyCollection("berry_harvest", 8, null, null))
    private fun message(job: EconomyJob, phase: String? = null, storageBlocked: Boolean = false) =
        notificationMessage(listOf(NotificationMessageEvent(job.kind, job, phase, storageBlocked)))

    @Test fun `event titles do not repeat the app identity`() {
        mapOf("exploration" to "Мохлик вернулся", "construction" to "Стройка завершена",
            "production" to "Ресурсы готовы", "checkin" to "Пора отметиться").forEach { (category, title) ->
            val actual = notificationMessage(listOf(NotificationMessageEvent(category)))
            assertEquals(title, actual.title)
            assertTrue(actual.body.isNotBlank())
            assertFalse(actual.title.contains("Я живой", ignoreCase = true))
        }
    }

    @Test fun `ripe berry quantities use actual saved yield and Russian number forms`() {
        mapOf(1L to "1 ягода готова", 2L to "2 ягоды готовы", 5L to "5 ягод готовы", 11L to "11 ягод готовы",
            20L to "20 ягод готовы", 21L to "21 ягода готова", 22L to "22 ягоды готовы", 111L to "111 ягод готовы",
            121L to "121 ягода готова").forEach { (quantity, expected) ->
            assertEquals("$expected к сбору. Откройте куст, чтобы Мохлик собрал урожай.", message(berries(quantity), "harvest").body)
        }
    }

    @Test fun `collected berries invite claiming and do not pretend to have credited the warehouse`() {
        assertEquals("Урожай собран: 20 ягод. Можно забрать в кладовую.", message(berries(20), "collected").body)
        assertEquals(message(berries(20), "harvest"), message(berries(20)))
        val withFiber = berries(20).copy(rewards = mapOf("berries" to 20, "fiber" to 8))
        assertEquals("20 ягод готовы к сбору. Вместе с урожаем: 8 пучков волокна. Откройте куст, чтобы Мохлик собрал урожай.", message(withFiber, "harvest").body)
        assertEquals("Урожай собран: 20 ягод и 8 пучков волокна. Можно забрать в кладовую.", message(withFiber, "collected").body)
    }

    @Test fun `legacy berries and garden fiber do not invent a harvest requirement`() {
        assertEquals("Готово: 20 ягод. Можно забрать в кладовую.", message(berries(20).copy(collection = null), "harvest").body)
        assertEquals("Готово: 8 пучков волокна. Можно забрать в кладовую.",
            message(job("production", "garden", mapOf("fiber" to 8)).copy(recipeId = "garden_fiber")).body)
    }

    @Test fun `repeated events are deduplicated and ready quantities aggregate independently of queue order`() {
        val first = NotificationMessageEvent("production", job("production", "workshop", mapOf("planks" to 2), "first"))
        val second = NotificationMessageEvent("production", job("production", "workshop", mapOf("planks" to 3, "rope" to 2), "second"))
        val actual = notificationMessage(listOf(first, second, first))
        assertEquals("Готово: 5 досок и 2 верёвки. Можно забрать в кладовую.", actual.body)
        assertEquals(actual, notificationMessage(listOf(second, first)))
        val harvest = NotificationMessageEvent("production", berries(20), "harvest")
        val collected = harvest.copy(phase = "collected")
        assertEquals(message(berries(20), "collected"), notificationMessage(listOf(harvest, collected)))
        assertEquals(notificationMessage(listOf(harvest, collected)), notificationMessage(listOf(collected, harvest)))
    }

    @Test fun `crafted resources and meals have readable quantity units`() {
        val expectations = mapOf(
            "planks" to "2 доски", "rope" to "2 верёвки", "metal_parts" to "2 металлические детали",
            "cloth" to "2 полотна", "beams" to "2 балки", "tools" to "2 набора инструментов",
            "reinforced_parts" to "2 усиленных узла", "cut_stone" to "2 тёсаных камня",
            "charcoal" to "2 ед. древесного угля", "bricks" to "2 кирпича", "iron_ingot" to "2 железных слитка",
            "glass" to "2 листа стекла", "dried_berries" to "2 порции сушёных ягод", "smoked_fish" to "2 порции копчёной рыбы",
            "grilled_fish" to "2 порции жареной рыбы", "fish_soup" to "2 порции ухи", "berry_fish" to "2 порции рыбы с ягодным соусом",
            "hearty_fish" to "2 порции сытного рыбного ужина", "epic_fish" to "2 порции праздничной рыбы",
            "legendary_fish" to "2 порции акульего жаркого", "wood" to "2 ед. древесины", "hardwood" to "2 ед. твёрдой древесины",
            "resin" to "2 ед. смолы", "fiber" to "2 пучка волокна",
        )
        expectations.forEach { (resource, expected) ->
            assertEquals("Готово: $expected. Можно забрать в кладовую.", message(job("production", "workshop", mapOf(resource to 2))).body)
        }
        mapOf(1L to "1 доска", 5L to "5 досок", 11L to "11 досок", 21L to "21 доска").forEach { (quantity, expected) ->
            assertTrue(message(job("production", "workshop", mapOf("planks" to quantity))).body.contains(expected))
        }
        assertEquals(EconomyRules.catalog.recipes.flatMap { it.rewards.keys }.toSet() - "berries", expectations.keys)
    }

    @Test fun `every real recipe renders its saved output rather than a generic production message`() {
        EconomyRules.catalog.recipes.forEach { recipe ->
            val production = job("production", recipe.buildingId, recipe.rewards, recipe.id).copy(recipeId = recipe.id,
                collection = recipe.collection?.let { EconomyCollection(it.kind, it.seconds, null, null) })
            val actual = message(production, if (recipe.collection != null) "harvest" else null)
            assertEquals("Ресурсы готовы", actual.title, recipe.id)
            assertFalse(actual.body.contains("Производство завершено"), recipe.id)
            assertTrue(actual.body.length <= 360, recipe.id)
            recipe.rewards.values.forEach { assertTrue(actual.body.contains(it.toString()), "${recipe.id}: ${actual.body}") }
            assertFalse(actual.body.contains(recipe.id), recipe.id)
        }
    }

    @Test fun `every route names the actual activity without exposing rewards`() {
        val expectedPlaces = mapOf(
            "forest" to "из леса", "forest_camp" to "из леса", "shore" to "с рыбалки", "shore_camp" to "с рыбалки",
            "cave" to "из шахты", "deep_cave" to "из шахты", "old_woodland" to "из старого леса",
            "coastal_deposits" to "с прибрежных отложений", "uplands" to "из лесного нагорья",
            "abandoned_quarry" to "из заброшенного карьера", "quarry_stone" to "из шахты",
            "quarry_stone_overnight" to "из шахты", "quarry_ore" to "из шахты", "quarry_clay" to "из шахты",
            "quarry_sand" to "из шахты", "quarry_shift" to "из шахты", "quarry_deep_face" to "из шахты", "quarry_supply" to "из шахты",
        )
        assertEquals(EconomyRules.catalog.explorations.map { it.id }.toSet(), expectedPlaces.keys)
        EconomyRules.catalog.explorations.forEach { route ->
            val actual = message(job("exploration", route.id, route.rewards))
            assertEquals("Мохлик вернулся", actual.title)
            assertTrue(actual.body.startsWith("Мохлик вернулся ${expectedPlaces.getValue(route.id)}."), route.id)
            assertFalse(actual.body.any { it.isDigit() }, route.id)
        }
        val fishing = job("exploration", "shore", mapOf("fish_shark" to 1, "fish" to 2, "moon_crystal" to 1)).copy(
            fishing = EconomyFishingCatch("reed_rod", null, "fish_shark"), rareDrop = EconomyRareDropDelivery(seconds = 60, itemId = "moon_crystal"))
        val hidden = message(fishing).body
        assertEquals("Мохлик вернулся с рыбалки. Можно разобрать улов.", hidden)
        assertFalse(hidden.contains("акул", ignoreCase = true))
        assertFalse(hidden.contains("кристалл", ignoreCase = true))
        assertEquals(message(fishing), message(fishing.copy(rewards = mapOf("fish" to 4), fishing = null, rareDrop = null)))
    }

    @Test fun `every construction names its building and actual target level`() {
        EconomyRules.catalog.buildings.forEach { building -> building.levels.forEach { level ->
            val actual = message(job("construction", building.id).copy(targetLevel = level.level))
            assertEquals("Стройка завершена", actual.title)
            assertTrue(actual.body.startsWith("${building.name}: "), building.id)
            assertTrue(actual.body.contains(if (level.level == 1) "строительство завершено" else "улучшение до уровня ${level.level} завершено"))
            assertTrue(actual.body.endsWith("Можно принять работу."))
        } }
    }

    @Test fun `full warehouse replaces impossible invitations for ready and harvest phases`() {
        listOf(message(berries(20), "harvest", true), message(berries(20), "collected", true),
            message(job("production", "workshop", mapOf("planks" to 5)), storageBlocked = true)).forEach { actual ->
            assertTrue(actual.body.contains("Освободите место в кладовой."))
            assertFalse(actual.body.contains("Можно забрать"))
            assertFalse(actual.body.contains("Откройте куст"))
        }
    }

    @Test fun `large mixed summaries preserve every category and storage warning within the push limit`() {
        val events = EconomyRules.catalog.recipes.map { recipe ->
            val production = job("production", recipe.buildingId, recipe.rewards, recipe.id).copy(recipeId = recipe.id,
                collection = recipe.collection?.let { EconomyCollection(it.kind, it.seconds, null, null) })
            NotificationMessageEvent("production", production, if (recipe.collection != null) "harvest" else null, true)
        } + EconomyRules.catalog.explorations.map { NotificationMessageEvent("exploration", job("exploration", it.id, it.rewards)) } +
            EconomyRules.catalog.buildings.map { NotificationMessageEvent("construction", job("construction", it.id).copy(targetLevel = it.levels.last().level)) } +
            NotificationMessageEvent("checkin")
        val actual = notificationMessage(events)
        assertEquals("Новости полянки", actual.title)
        assertTrue(actual.body.length <= 360, actual.body)
        listOf("Мохлик вернулся", "Стройка завершена", "Ресурсы готовы", "Ягоды", "близким", "Освободите место в кладовой.").forEach {
            assertTrue(actual.body.contains(it), "Missing $it in ${actual.body}")
        }
        assertEquals(actual, notificationMessage(events.reversed()))
    }

    @Test fun `missing or unknown historical context has useful safe fallback`() {
        val unknown = "<unknown-user-controlled-id>"
        listOf(notificationMessage(emptyList()), notificationMessage(listOf(NotificationMessageEvent(unknown))),
            message(job("exploration", unknown)), message(job("construction", unknown).copy(targetLevel = 999)),
            message(job("production", unknown, mapOf(unknown to 5, "planks" to 0, "berries" to -1)))).forEach { actual ->
            assertTrue(actual.body.isNotBlank())
            assertTrue(actual.body.length <= 360)
            assertFalse(actual.body.contains(unknown))
            assertFalse(actual.body.contains("-1"))
        }
        assertEquals("Производство завершено. Можно забрать в кладовую.",
            notificationMessage(listOf(NotificationMessageEvent("production"))).body)
    }
}
