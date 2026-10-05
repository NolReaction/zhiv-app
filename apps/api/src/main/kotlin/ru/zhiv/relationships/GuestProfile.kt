package ru.zhiv.relationships

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import ru.zhiv.economy.EconomyRules
import ru.zhiv.game.GameRewards
import java.util.UUID

@Serializable data class GuestProfileUser(val publicId: String, val displayName: String)
@Serializable data class GuestAchievement(val id: String, val level: Int)
@Serializable data class GuestCollections(val travel: List<String>, val fishing: List<String>, val quarry: List<String>)
@Serializable data class GuestProfile(
    val ownerPublicId: String, val circleId: String, val user: GuestProfileUser,
    val homeLevel: Int, val completedExplorations: Long,
    val achievements: List<GuestAchievement>, val collections: GuestCollections, val serverTime: String,
)
interface GuestProfileRepository {
    suspend fun profile(sessionHash: ByteArray, circleId: UUID): GuestProfile
}

/** Explicit shared allowlist: account/security, check-ins, friendships and leaderboard-only records stay private. */
object GuestProfileRules {
    private fun resource(name: String): JsonObject = Json.parseToJsonElement(checkNotNull(
        GuestProfileRules::class.java.getResourceAsStream("/world/$name.json"))
        .bufferedReader().use { it.readText() }).jsonObject
    private val policy = resource("guest-profile-policy")
    val achievementIds = policy.getValue("achievementIds").jsonArray.map { it.jsonPrimitive.content }
    private val book = resource("collections-catalog")
    val travelIds = book.getValue("travel").jsonObject.getValue("finds").jsonArray.map { it.jsonPrimitive.content }
    val quarryIds = book.getValue("quarry").jsonObject.getValue("finds").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content }
    val fishIds = EconomyRules.catalog.fishing?.fish.orEmpty().map { it.itemId }
    init {
        require(policy.getValue("version").jsonPrimitive.int == 1)
        require(achievementIds.distinct().size == achievementIds.size && achievementIds.all { it in GameRewards.tiers })
    }
    fun achievements(awarded: Map<String, Int>): List<GuestAchievement> = achievementIds.mapNotNull { id ->
        awarded[id]?.takeIf { it > 0 }?.let { GuestAchievement(id, minOf(it, GameRewards.tiers.getValue(id).size)) }
    }
    fun collections(finds: List<String>, catches: Map<String, Long>): GuestCollections = GuestCollections(
        travelIds.filter { it in finds }, fishIds.filter { (catches[it] ?: 0) > 0 }, quarryIds.filter { it in finds })
}
