package ru.zhiv.world

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import java.time.Instant

@Serializable data class SettlementMaterials(val wood: Long = 0, val stone: Long = 0)
@Serializable data class SettlementBuilding(val kind: String, val level: Int = 1, val x: Int, val y: Int)
@Serializable data class SettlementGathering(val id: String, val finishesAt: String, val rewards: SettlementMaterials)
@Serializable data class SettlementState(val version: Int = 1, val areaLevel: Int = 1,
    val resources: SettlementMaterials, val buildings: List<SettlementBuilding> = emptyList(), val gathering: SettlementGathering? = null)
@Serializable data class SettlementArea(val level: Int, val size: Int, val wood: Long, val stone: Long)
@Serializable data class SettlementBuildingSpec(val kind: String, val name: String, val wood: Long, val stone: Long,
    val upgradeWood: Long, val upgradeStone: Long)
@Serializable data class SettlementCatalog(val version: Int, val gridSize: Int, val footprint: Int, val starter: SettlementMaterials,
    val areas: List<SettlementArea>, val buildings: List<SettlementBuildingSpec>, val capacities: List<Long>, val gatherSeconds: Long,
    val gatherWood: Long, val gatherStone: Long, val workshopBonusWood: Long, val workshopBonusStone: Long)

object SettlementRules {
    val catalog: SettlementCatalog = worldJson.decodeFromString(checkNotNull(SettlementRules::class.java.getResourceAsStream("/world/settlement-catalog.json")).bufferedReader().use { it.readText() })
    private fun fail(code: String, message: String): Nothing = throw AuthFailure(code, message, 409)
    fun initial() = SettlementState(resources = catalog.starter)
    fun capacity(state: SettlementState) = catalog.capacities[state.buildings.find { it.kind == "storehouse" }?.level ?: 0]
    fun canPlace(state: SettlementState, x: Int, y: Int, moving: String? = null): Boolean {
        val size = catalog.areas.first { it.level == state.areaLevel }.size
        val min = (catalog.gridSize - size) / 2
        val max = min + size
        val f = catalog.footprint
        return x >= min && y >= min && x + f <= max && y + f <= max && state.buildings.none {
            it.kind != moving && x < it.x + f && x + f > it.x && y < it.y + f && y + f > it.y
        }
    }
    fun apply(current: SettlementState?, command: WorldCommand, now: Instant): Pair<SettlementState, String> {
        var state = current ?: initial()
        fun spend(wood: Long, stone: Long) {
            if (state.resources.wood < wood || state.resources.stone < stone) fail("SETTLEMENT_RESOURCES", "Не хватает материалов. Соберите их у опушки.")
            state = state.copy(resources = SettlementMaterials(state.resources.wood - wood, state.resources.stone - stone))
        }
        val message = when (command.action) {
            "settlement_build", "settlement_move" -> {
                val match = Regex("^(workshop|storehouse):([0-9]):([0-9])$").matchEntire(command.target)
                    ?: fail("SETTLEMENT_PLACEMENT", "Выберите участок внутри ограды.")
                val (kind, sx, sy) = match.destructured
                val x = sx.toInt(); val y = sy.toInt()
                val spec = catalog.buildings.first { it.kind == kind }
                val existing = state.buildings.find { it.kind == kind }
                val moving = command.action == "settlement_move"
                if (moving && existing == null || !moving && existing != null) fail("SETTLEMENT_BUILDING", if (moving) "Постройка не найдена." else "Эта постройка уже есть на поляне.")
                if (!canPlace(state, x, y, if (moving) kind else null)) fail("SETTLEMENT_PLACEMENT", "Здесь занято или участок ещё не открыт.")
                if (moving) state = state.copy(buildings = state.buildings.map { if (it.kind == kind) it.copy(x = x, y = y) else it })
                else { spend(spec.wood, spec.stone); state = state.copy(buildings = state.buildings + SettlementBuilding(kind, 1, x, y)) }
                if (kind == "storehouse") { if (moving) "Склад перенесён." else "Склад готов. Теперь можно хранить больше материалов." }
                else "${spec.name} ${if (moving) "перенесена" else "готова"}."
            }
            "settlement_upgrade" -> {
                val building = state.buildings.find { it.kind == command.target } ?: fail("SETTLEMENT_BUILDING", "Сначала поставьте постройку на поляне.")
                if (building.level == 2) fail("SETTLEMENT_MAX_LEVEL", "Все улучшения этой постройки открыты.")
                val spec = catalog.buildings.first { it.kind == building.kind }
                spend(spec.upgradeWood, spec.upgradeStone)
                state = state.copy(buildings = state.buildings.map { if (it.kind == building.kind) it.copy(level = 2) else it })
                if (building.kind == "workshop") "Мастерская улучшена. Сбор приносит больше материалов." else "Склад улучшен. Вместимость увеличена до 800."
            }
            "settlement_expand" -> {
                if (command.target.isNotEmpty()) fail("SETTLEMENT_TARGET", "Некорректное действие.")
                val area = catalog.areas.find { it.level == state.areaLevel + 1 } ?: fail("SETTLEMENT_MAX_LEVEL", "Вся территория внутри ограды открыта.")
                spend(area.wood, area.stone); state = state.copy(areaLevel = area.level)
                "Открыта поляна ${area.size} × ${area.size}."
            }
            "settlement_gather" -> {
                if (command.target.isNotEmpty()) fail("SETTLEMENT_TARGET", "Некорректное действие.")
                if (state.gathering != null) fail("SETTLEMENT_GATHERING", "Сбор уже идёт. Дождитесь материалов.")
                if (state.resources.wood >= capacity(state) && state.resources.stone >= capacity(state)) fail("SETTLEMENT_STORAGE_FULL", "Запасы заполнены. Потратьте материалы или улучшите склад.")
                val improved = state.buildings.any { it.kind == "workshop" && it.level == 2 }
                val rewards = SettlementMaterials(catalog.gatherWood + if (improved) catalog.workshopBonusWood else 0,
                    catalog.gatherStone + if (improved) catalog.workshopBonusStone else 0)
                state = state.copy(gathering = SettlementGathering(command.requestId, now.plusSeconds(catalog.gatherSeconds).toString(), rewards))
                "Материалы с опушки будут готовы через минуту."
            }
            "settlement_claim" -> {
                val gathering = state.gathering?.takeIf { it.id == command.target } ?: fail("SETTLEMENT_GATHERING_GONE", "Материалы уже получены.")
                if (now.isBefore(Instant.parse(gathering.finishesAt))) fail("SETTLEMENT_NOT_READY", "Материалы ещё собираются.")
                val cap = capacity(state)
                state = state.copy(resources = SettlementMaterials(minOf(cap, state.resources.wood + gathering.rewards.wood), minOf(cap, state.resources.stone + gathering.rewards.stone)), gathering = null)
                "Материалы добавлены в запасы."
            }
            else -> throw AuthFailure("INVALID_WORLD_COMMAND", "Неизвестное действие", 400)
        }
        return state to message
    }

    /** A single settlement transfers intact. Two populated saves need an explicit future merge policy. */
    fun merge(target: SettlementState?, source: SettlementState?): SettlementState? {
        if (target == null) return source
        if (source == null) return target
        fail("SETTLEMENT_MERGE_CONFLICT", "В обоих профилях уже есть поляны. Их объединение пока не поддерживается; обе сохранены без изменений.")
    }
}
