package ru.zhiv.forest

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId
import java.util.UUID

const val FOREST_MEMORY_LEASE_SECONDS = 90L
const val FOREST_MEMORY_MAX_REVISION = 9_007_199_254_740_991L
val forestMemoryJson = Json { ignoreUnknownKeys = false; explicitNulls = true; encodeDefaults = true }

@Serializable data class ForestMemoryPoint(val x: Double, val y: Double)
@Serializable data class ForestMemoryNeeds(val energy: Double, val curiosity: Double, val comfort: Double, val attention: Double)
@Serializable data class ForestMemoryRecent(val key: String, val action: String, val outcome: String, val at: Double, val duration: Double)
@Serializable data class ForestMemoryMind(val elapsed: Double, val needs: ForestMemoryNeeds, val recent: List<ForestMemoryRecent>, val attentionUntil: Double)
@Serializable data class ForestMemoryInterest(val id: String, val activity: String, val age: Double)
@Serializable data class ForestMemoryHero(val position: ForestMemoryPoint, val sleepingHome: Boolean, val awakeFor: Double, val restFor: Double, val recent: List<ForestMemoryInterest>)
@Serializable data class ForestMemoryMushroom(val id: String, val position: ForestMemoryPoint, val growth: Double, val regrowIn: Double)

/** Cosmetic data only. No client-supplied account, inventory, currency, or rewards. */
@Serializable data class ForestMemoryPayload(
    val version: Int,
    val sceneId: String,
    val fingerprint: String,
    val mind: ForestMemoryMind,
    val hero: ForestMemoryHero,
    val mushrooms: List<ForestMemoryMushroom>,
)
@Serializable data class ForestMemoryLease(val owned: Boolean, val expiresAt: String?, val token: String?)
@Serializable data class ForestMemoryView(
    val ownerPublicId: String,
    val revision: Long,
    val serverTime: String,
    val updatedAt: String?,
    val snapshot: ForestMemoryPayload?,
    val lease: ForestMemoryLease,
)
@Serializable data class ForestMemoryCommand(
    val ownerPublicId: String,
    val clientId: String,
    val requestId: String,
    val expectedRevision: Long,
    val action: String,
    val takeover: Boolean = false,
    val leaseToken: String? = null,
    val snapshot: ForestMemoryPayload? = null,
)
@Serializable data class ForestMemoryResult(val state: ForestMemoryView, val acceptedRevision: Long, val replayed: Boolean = false)

interface ForestMemoryRepository {
    suspend fun read(sessionHash: ByteArray, expectedOwnerPublicId: String, clientId: UUID): ForestMemoryView
    suspend fun command(sessionHash: ByteArray, command: ForestMemoryCommand): ForestMemoryResult
}

fun invalidForestMemory(): Nothing = throw AuthFailure("INVALID_FOREST_MEMORY", "Некорректные данные памяти Мохлика", 400)
private fun bounded(value: Double, maximum: Double = 1.0) = value.isFinite() && value >= 0 && value <= maximum
private fun text(value: String) = value.isNotEmpty() && value.length <= 160 && value.none { it.code < 32 || it.code == 127 }
private fun point(value: ForestMemoryPoint) = bounded(value.x, 10_000_000.0) && bounded(value.y, 10_000_000.0)
fun parseForestMemoryClientId(value: String?): UUID? = parseCanonicalUuidV4(value)?.takeIf { it.toString() == value }

/** Some primitive serializers accept quoted numbers. Keep the HTTP contract identical
 * to the strict browser schema while still allowing omitted default command fields. */
private fun primitiveKindsMatch(raw: JsonElement, typed: JsonElement): Boolean = when (raw) {
    JsonNull -> typed == JsonNull
    is JsonObject -> typed is JsonObject && raw.all { (key, value) -> typed[key]?.let { primitiveKindsMatch(value, it) } == true }
    is JsonArray -> typed is JsonArray && raw.size == typed.size && raw.indices.all { primitiveKindsMatch(raw[it], typed[it]) }
    is JsonPrimitive -> typed is JsonPrimitive && typed != JsonNull && raw.isString == typed.isString &&
        (raw.booleanOrNull != null) == (typed.booleanOrNull != null)
}

fun decodeForestMemoryCommand(raw: JsonElement): ForestMemoryCommand {
    val command = try { forestMemoryJson.decodeFromJsonElement<ForestMemoryCommand>(raw) }
        catch (_: SerializationException) { invalidForestMemory() }
    if (!primitiveKindsMatch(raw, forestMemoryJson.encodeToJsonElement(command))) invalidForestMemory()
    validateForestMemoryCommand(command)
    return command
}

fun validateForestMemoryPayload(value: ForestMemoryPayload) {
    val actions = setOf("look", "sniff", "groom", "rest", "bush", "home-sleep", "butterfly", "firefly", "mushroom", "leaf", "idle")
    val mind = value.mind
    val hero = value.hero
    if (value.version != 1 || !text(value.sceneId) || !text(value.fingerprint)
        || !bounded(mind.elapsed, 1_000_000_000.0) || !bounded(mind.attentionUntil, minOf(1_000_000_000.0, mind.elapsed + 30))
        || !listOf(mind.needs.energy, mind.needs.curiosity, mind.needs.comfort, mind.needs.attention).all { bounded(it) }
        || mind.recent.size > 16 || mind.recent.any { !text(it.key) || it.action !in actions
            || it.outcome !in setOf("completed", "interrupted", "failed") || !bounded(it.at, mind.elapsed)
            || mind.elapsed - it.at > 300 || !bounded(it.duration, 3600.0) }
        || !point(hero.position) || !bounded(hero.awakeFor, 30.0) || !bounded(hero.restFor, 45.0)
        || hero.recent.size > 8 || hero.recent.any { !text(it.id) || it.activity !in setOf("look", "sniff", "groom", "rest") || !bounded(it.age, 75.0) }
        || value.mushrooms.size > 128 || value.mushrooms.map { it.id }.toSet().size != value.mushrooms.size
        || value.mushrooms.any { !text(it.id) || !point(it.position) || !bounded(it.growth) || !bounded(it.regrowIn, 22.0) }) invalidForestMemory()
    if (forestMemoryJson.encodeToString(value).toByteArray(Charsets.UTF_8).size > 32_768) invalidForestMemory()
}

fun validateForestMemoryCommand(value: ForestMemoryCommand) {
    if (parsePublicId(value.ownerPublicId) != value.ownerPublicId || parseForestMemoryClientId(value.clientId) == null
        || parseForestMemoryClientId(value.requestId) == null || value.expectedRevision !in 0..FOREST_MEMORY_MAX_REVISION) invalidForestMemory()
    when (value.action) {
        "acquire" -> if (value.leaseToken != null || value.snapshot != null) invalidForestMemory()
        "save" -> {
            if (value.takeover || parseForestMemoryClientId(value.leaseToken) == null || value.snapshot == null) invalidForestMemory()
            validateForestMemoryPayload(value.snapshot)
        }
        "release" -> if (value.takeover || parseForestMemoryClientId(value.leaseToken) == null || value.snapshot != null) invalidForestMemory()
        else -> invalidForestMemory()
    }
}
