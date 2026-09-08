package ru.zhiv.world

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID

internal val worldJson = Json { encodeDefaults = true; ignoreUnknownKeys = true }
@Serializable data class WorldResources(val sparks: Long = 0, val wood: Long = 0, val stone: Long = 0)
@Serializable data class WorldEquipment(val palette: String = "moss", val head: String? = null, val neck: String? = null)
@Serializable data class WorldJourney(val id: String, val routeId: String, val startedAt: String, val finishesAt: String,
    val rewards: WorldResources, val finds: List<String>, val introductory: Boolean, val catalogVersion: Int)
@Serializable data class WorldState(
    val schemaVersion: Int = 1,
    val resources: WorldResources = WorldResources(),
    val houseLevel: Int = 1,
    val workshop: Boolean = false,
    val inventory: List<String> = listOf("moss", "amber_scarf"),
    val equipment: WorldEquipment = WorldEquipment(),
    val collection: List<String> = emptyList(),
    val journeys: List<WorldJourney> = emptyList(),
    val firstJourneyCompleted: Boolean = false,
    val completedJourneys: Long = 0,
)
@Serializable data class WorldSnapshot(
    val ownerPublicId: String, val revision: Long, val serverTime: String,
    val state: WorldState, val gifts: List<String> = emptyList(), val dailySparksEarned: Int = 0,
    val catalogVersion: Int = 1,
)
@Serializable data class WorldCommand(
    val requestId: String, val ownerPublicId: String, val expectedRevision: Long,
    val action: String, val target: String = "",
)
@Serializable data class WorldResult(val snapshot: WorldSnapshot, val message: String, val replayed: Boolean = false)
@Serializable data class WorldCost(val sparks: Long, val wood: Long = 0, val stone: Long = 0, val level: Int = 0)
@Serializable data class WorldItem(val id: String, val name: String, val slot: String, val color: String, val sparks: Long, val starter: Boolean)
@Serializable data class WorldFind(val id: String, val name: String, val description: String, val symbol: String)
@Serializable data class WorldRoute(val id: String, val name: String, val description: String, val seconds: Long, val houseLevel: Int,
    val once: Boolean, val sparks: Long, val wood: Long, val stone: Long, val finds: List<String>)
@Serializable data class WorldCatalog(val version: Int, val dailySparkLimit: Int, val tapsPerSpark: Int,
    val houseUpgrades: List<WorldCost>, val workshop: WorldCost, val items: List<WorldItem>, val finds: List<WorldFind>, val routes: List<WorldRoute>)

object WorldRules {
    val catalog: WorldCatalog = worldJson.decodeFromString(
        checkNotNull(WorldRules::class.java.getResourceAsStream("/world/catalog.json")).bufferedReader().use { it.readText() })
    private fun fail(code: String, message: String): Nothing = throw AuthFailure(code, message, 409)
    private fun spend(state: WorldState, cost: WorldCost): WorldState {
        val r = state.resources
        if (r.sparks < cost.sparks || r.wood < cost.wood || r.stone < cost.stone) fail("WORLD_RESOURCES", "Пока не хватает материалов. Их можно принести из путешествия.")
        return state.copy(resources = WorldResources(r.sparks-cost.sparks, r.wood-cost.wood, r.stone-cost.stone))
    }
    fun apply(state: WorldState, command: WorldCommand, now: Instant): Pair<WorldState, String> = when(command.action) {
        "upgrade_house" -> {
            val cost = catalog.houseUpgrades.find { it.level == state.houseLevel+1 } ?: fail("WORLD_MAX_LEVEL", "Домик уже полностью улучшен")
            spend(state, cost).copy(houseLevel=cost.level) to "Домик стал уютнее. Открыты новые возможности!"
        }
        "build_workshop" -> {
            if (state.workshop) fail("WORLD_ALREADY_BUILT", "Мастерская уже построена")
            spend(state, catalog.workshop).copy(workshop=true) to "Мастерская готова. Теперь можно делать одежду!"
        }
        "craft" -> {
            val item = catalog.items.find { it.id == command.target && !it.starter && it.sparks > 0 } ?: fail("WORLD_ITEM", "Этот предмет нельзя изготовить")
            if (!state.workshop) fail("WORLD_WORKSHOP_REQUIRED", "Сначала постройте мастерскую")
            if (item.id in state.inventory) fail("WORLD_ITEM_OWNED", "Предмет уже в рюкзаке")
            spend(state, WorldCost(item.sparks)).copy(inventory=(state.inventory+item.id).sorted()) to "${item.name} теперь в рюкзаке"
        }
        "equip" -> {
            if (command.target == "remove_head") state.copy(equipment=state.equipment.copy(head=null)) to "Головной убор снят"
            else if (command.target == "remove_neck") state.copy(equipment=state.equipment.copy(neck=null)) to "Шарф снят"
            else {
                val item = catalog.items.find { it.id == command.target } ?: fail("WORLD_ITEM", "Предмет не найден")
                if (item.id !in state.inventory) fail("WORLD_ITEM_NOT_OWNED", "Сначала получите этот предмет")
                val equipment = when(item.slot) {
                    "palette" -> state.equipment.copy(palette=item.id)
                    "head" -> state.equipment.copy(head=item.id)
                    "neck" -> state.equipment.copy(neck=item.id)
                    else -> error("Unknown equipment slot")
                }
                state.copy(equipment=equipment) to "Мохлик примерил: ${item.name.lowercase()}"
            }
        }
        "start_journey" -> {
            val route = catalog.routes.find { it.id == command.target } ?: fail("WORLD_ROUTE", "Маршрут не найден")
            if (state.journeys.isNotEmpty()) fail("WORLD_JOURNEY_ACTIVE", "Мохлик уже в пути. Дождитесь возвращения или позовите его домой.")
            if (route.houseLevel > state.houseLevel) fail("WORLD_HOUSE_REQUIRED", "Сначала улучшите домик")
            if (route.once && state.firstJourneyCompleted) fail("WORLD_ROUTE_COMPLETED", "Первая прогулка уже состоялась. Выберите следующий маршрут.")
            state.copy(journeys=listOf(WorldJourney(UUID.randomUUID().toString(),route.id,now.toString(),now.plusSeconds(route.seconds).toString(),
                WorldResources(route.sparks,route.wood,route.stone),route.finds,route.once,catalog.version))) to "Мохлик отправился в путь"
        }
        "recall_journey" -> {
            if (state.journeys.none { it.id == command.target }) fail("WORLD_JOURNEY_GONE", "Мохлик уже дома")
            state.copy(journeys=state.journeys.filterNot { it.id == command.target }) to "Мохлик вернулся домой без находок"
        }
        "claim_journey" -> {
            val journey = state.journeys.find { it.id == command.target } ?: fail("WORLD_JOURNEY_GONE", "Награда уже получена или путешествие завершено")
            if (now.isBefore(Instant.parse(journey.finishesAt))) fail("WORLD_JOURNEY_NOT_READY", "Мохлик ещё в пути")
            val found = journey.finds.firstOrNull { it !in state.collection }
            val collection = (state.collection + listOfNotNull(found)).distinct().sorted()
            val complete = catalog.finds.all { it.id in collection }
            val resources = state.resources
            state.copy(resources=WorldResources(resources.sparks+journey.rewards.sparks,resources.wood+journey.rewards.wood,resources.stone+journey.rewards.stone),
                collection=collection, journeys=state.journeys.filterNot { it.id == journey.id },
                firstJourneyCompleted=state.firstJourneyCompleted || journey.introductory, completedJourneys=state.completedJourneys+1,
                inventory=(state.inventory+if(complete) listOf("explorer_cap") else emptyList()).distinct().sorted()) to
                (if (complete && "explorer_cap" !in state.inventory) "Альбом собран! Мохлик получил шляпу следопыта." else found?.let { "Новая находка: ${(catalog.finds.find { f -> f.id == it }?.name ?: "Лесной сувенир").lowercase()}" } ?: "Мохлик принёс материалы для строительства")
        }
        else -> throw AuthFailure("INVALID_WORLD_COMMAND", "Неизвестное действие", 400)
    }
    fun merge(target: WorldState, source: WorldState): WorldState {
        val journeys = (target.journeys+source.journeys).distinctBy { it.id }
        if(journeys.size>32) fail("WORLD_MERGE_JOURNEYS", "Сначала получите награды за завершённые путешествия")
        val a=target.resources; val b=source.resources
        val collection=(target.collection+source.collection).distinct().sorted()
        val collectionReward=if(catalog.finds.all { it.id in collection }) listOf("explorer_cap") else emptyList()
        return target.copy(resources=WorldResources(Math.addExact(a.sparks,b.sparks),Math.addExact(a.wood,b.wood),Math.addExact(a.stone,b.stone)),
            houseLevel=maxOf(target.houseLevel,source.houseLevel),workshop=target.workshop||source.workshop,
            inventory=(target.inventory+source.inventory+collectionReward).distinct().sorted(),collection=collection,
            journeys=journeys,firstJourneyCompleted=target.firstJourneyCompleted||source.firstJourneyCompleted,
            completedJourneys=target.completedJourneys+source.completedJourneys)
    }
}

interface WorldRepository {
    suspend fun snapshot(sessionHash: ByteArray): WorldSnapshot
    suspend fun command(sessionHash: ByteArray, command: WorldCommand): WorldResult
}
