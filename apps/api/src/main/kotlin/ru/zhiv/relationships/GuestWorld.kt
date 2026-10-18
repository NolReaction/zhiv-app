package ru.zhiv.relationships

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import ru.zhiv.economy.EconomyCommand
import ru.zhiv.economy.EconomyMarketListing
import ru.zhiv.economy.EconomyResult
import ru.zhiv.economy.EconomyRules
import ru.zhiv.game.GameRewards
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.world.WorldEquipment
import ru.zhiv.world.WorldRules
import java.time.Instant
import java.util.UUID

@Serializable data class GuestWorldCollection(val kind: String, val seconds: Long, val startedAt: String?, val finishesAt: String?)
@Serializable data class GuestWorldJob(
    val id: String, val kind: String, val targetId: String, val recipeId: String?, val targetLevel: Int?,
    val startedAt: String, val finishesAt: String, val collection: GuestWorldCollection?, val actorId: String?,
)
@Serializable data class GuestWorldScene(
    val buildings: Map<String, Int>, val equipment: WorldEquipment, val gifts: List<String>,
    val hiddenGifts: List<String>, val jobs: List<GuestWorldJob>,
)
@Serializable data class GuestWorldMarket(val listings: List<EconomyMarketListing>, val available: Boolean, val reason: String?)
@Serializable data class GuestWorld(
    val ownerPublicId: String, val circleId: String, val user: GuestProfileUser, val serverTime: String,
    val world: GuestWorldScene, val market: GuestWorldMarket,
)
interface GuestWorldRepository {
    suspend fun world(sessionHash: ByteArray, circleId: UUID): GuestWorld
    suspend fun purchase(sessionHash: ByteArray, circleId: UUID, command: EconomyCommand): EconomyResult
}

/** A field-by-field projection. Future rewards, wallet, stock, seeds and cosmetic leases never enter this DTO. */
object GuestWorldRules {
    private fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.number(key: String): Int? = (get(key) as? JsonPrimitive)?.intOrNull
    private fun JsonObject.strings(key: String): List<String> = (get(key) as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    private fun timestamp(value: String?): String? = value?.takeIf { runCatching { Instant.parse(it) }.isSuccess }

    fun scene(economy: JsonObject?, legacy: JsonObject?, gifts: List<String>): GuestWorldScene {
        val defaults = EconomyRules.initial(includeStartingPack = false).buildings
        val saved = economy?.get("buildings") as? JsonObject
        val buildings = EconomyRules.catalog.buildings.associate { building ->
            val maximum = building.levels.maxOf { it.level }
            val level = if (economy == null) when (building.id) {
                "home" -> legacy?.number("houseLevel") ?: 1
                "workshop" -> if ((legacy?.get("workshop") as? JsonPrimitive)?.booleanOrNull == true)
                    maxOf(1, legacy.number("workshopLevel") ?: 1) else 0
                else -> defaults[building.id] ?: 0
            } else saved?.number(building.id) ?: defaults[building.id] ?: 0
            building.id to level.coerceIn(if (building.id == "home") 1 else 0, maximum)
        }
        val equipped = legacy?.get("equipment") as? JsonObject
        fun clothing(slot: String): String? = equipped?.text(slot)?.takeIf { id -> WorldRules.catalog.items.any { it.id == id && it.slot == slot } }
        val equipment = WorldEquipment(clothing("palette") ?: "moss", clothing("head"), clothing("neck"), clothing("rod"))
        val visibleGifts = gifts.filter { it in GameRewards.items }.distinct().sorted()
        val hidden = legacy?.strings("hiddenGifts").orEmpty().filter { it in visibleGifts }.distinct().sorted()
        val jobs = (economy?.get("jobs") as? JsonArray).orEmpty().mapNotNull { element ->
            val job = element as? JsonObject ?: return@mapNotNull null
            val id = job.text("id")?.takeIf { parseCanonicalUuidV4(it) != null } ?: return@mapNotNull null
            val kind = job.text("kind") ?: return@mapNotNull null
            val target = job.text("targetId") ?: return@mapNotNull null
            val targetKnown = when (kind) {
                "construction", "production" -> EconomyRules.catalog.buildings.any { it.id == target }
                "exploration" -> EconomyRules.catalog.explorations.any { it.id == target }
                else -> false
            }
            if (!targetKnown) return@mapNotNull null
            val startedAt = timestamp(job.text("startedAt")) ?: return@mapNotNull null
            val finishesAt = timestamp(job.text("finishesAt")) ?: return@mapNotNull null
            if (Instant.parse(finishesAt).isBefore(Instant.parse(startedAt))) return@mapNotNull null
            val collection = (job["collection"] as? JsonObject)?.let { value ->
                val seconds = value.number("seconds")?.toLong() ?: return@let null
                if (kind != "production" || target != "garden" || value.text("kind") != "berry_harvest" || seconds !in 1L..120L) return@let null
                val start = timestamp(value.text("startedAt"))
                val finish = timestamp(value.text("finishesAt"))
                if ((start == null) != (finish == null)) return@let null
                GuestWorldCollection("berry_harvest", seconds, start, finish)
            }
            GuestWorldJob(id, kind, target,
                job.text("recipeId")?.takeIf { recipe -> EconomyRules.catalog.recipes.any { it.id == recipe && it.buildingId == target } },
                job.number("targetLevel")?.takeIf { level -> kind == "construction" && EconomyRules.catalog.buildings.any { it.id == target && it.levels.any { definition -> definition.level == level } } },
                startedAt, finishesAt, collection, job.text("actorId")?.takeIf { kind == "exploration" && it in setOf("mochlik", "miner") })
        }.distinctBy { it.id }.take(100)
        return GuestWorldScene(buildings, equipment, visibleGifts, hidden, jobs)
    }
}
