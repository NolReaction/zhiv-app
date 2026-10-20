package ru.zhiv.earth

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.PublicUserDto
import ru.zhiv.http.parseCanonicalUuid
import ru.zhiv.http.parsePublicId
import java.time.Instant
import kotlin.math.floor

const val EARTH_POSITION_TTL_SECONDS = 86_400L
const val EARTH_PUBLISH_INTERVAL_SECONDS = 30L
private const val MAX_SAFE = 9_007_199_254_740_990L

@Serializable data class EarthSharingWrite(val expectedOwnerPublicId: String, val expectedRevision: Long,
    val mode: String, val precision: String, val recipientCircleIds: List<String>, val durationMinutes: Int?)
@Serializable data class EarthPositionWrite(val expectedOwnerPublicId: String, val publicationEpoch: String,
    val sequence: Long, val latitude: Double, val longitude: Double, val accuracyMeters: Double, val capturedAt: String)
@Serializable data class EarthPositionStop(val expectedOwnerPublicId: String, val publicationEpoch: String)
@Serializable data class EarthSharingSettings(val ownerPublicId: String, val mode: String, val revision: Long,
    val precision: String, val recipientCircleIds: List<String>, val sharingUntil: String?, val publicationEpoch: String?, val serverTime: String)
@Serializable data class EarthPositionReceipt(val ownerPublicId: String, val acceptedAt: String, val expiresAt: String, val serverTime: String)
@Serializable data class EarthPositionStopped(val ownerPublicId: String, val serverTime: String)
@Serializable data class EarthSharedPerson(val circleId: String, val user: PublicUserDto, val latitude: Double,
    val longitude: Double, val accuracyMeters: Double, val precision: String, val updatedAt: String, val expiresAt: String)
@Serializable data class EarthPeopleResponse(val ownerPublicId: String, val people: List<EarthSharedPerson>, val serverTime: String)

interface EarthLocationRepository {
    suspend fun settings(sessionHash: ByteArray): EarthSharingSettings
    suspend fun share(sessionHash: ByteArray, request: EarthSharingWrite): EarthSharingSettings
    suspend fun publish(sessionHash: ByteArray, request: EarthPositionWrite): EarthPositionReceipt
    suspend fun stop(sessionHash: ByteArray, request: EarthPositionStop): EarthPositionStopped
    suspend fun people(sessionHash: ByteArray): EarthPeopleResponse
}
class EarthRateLimited(val seconds: Int): RuntimeException("Earth request rate limited")
fun earthFailure(code: String, status: Int = 409): Nothing = throw AuthFailure(code, when(code) {
    "UNAUTHORIZED" -> "Войдите в профиль ещё раз"
    "EARTH_OWNER_MISMATCH" -> "Открыт другой профиль"
    "EARTH_REVISION_CONFLICT" -> "Настройки изменились. Откройте их ещё раз"
    "EARTH_PUBLICATION_CONFLICT" -> "Публикация остановлена. Подтвердите показ заново"
    else -> "Некорректный запрос карты"
}, status)
fun invalidEarthSharing(): Nothing = earthFailure("INVALID_EARTH_SHARING",400)
fun invalidEarthPosition(): Nothing = earthFailure("INVALID_EARTH_POSITION",400)
fun validateEarthSharing(value: EarthSharingWrite) {
    if(parsePublicId(value.expectedOwnerPublicId)!=value.expectedOwnerPublicId || value.expectedRevision !in 0..MAX_SAFE ||
        value.mode !in setOf("OFF","SHARING","GHOST") || value.precision !in setOf("APPROXIMATE","PRECISE") ||
        value.durationMinutes !in listOf(null,60,480) || value.recipientCircleIds.size>100 ||
        value.recipientCircleIds.distinct().size!=value.recipientCircleIds.size || value.recipientCircleIds.any { parseCanonicalUuid(it)==null } ||
        (value.mode=="SHARING" && value.recipientCircleIds.isEmpty())) invalidEarthSharing()
}
fun validateEarthPosition(value: EarthPositionWrite): Instant {
    if(parsePublicId(value.expectedOwnerPublicId)!=value.expectedOwnerPublicId || parseCanonicalUuid(value.publicationEpoch)==null ||
        value.sequence !in 1..MAX_SAFE || !value.latitude.isFinite() || value.latitude !in -90.0..90.0 ||
        !value.longitude.isFinite() || value.longitude !in -180.0..180.0 || !value.accuracyMeters.isFinite() ||
        value.accuracyMeters !in 0.0..100_000.0 || value.capturedAt.length>40) invalidEarthPosition()
    return runCatching { Instant.parse(value.capturedAt) }.getOrNull() ?: invalidEarthPosition()
}
fun validateEarthStop(value: EarthPositionStop) {
    if(parsePublicId(value.expectedOwnerPublicId)!=value.expectedOwnerPublicId || parseCanonicalUuid(value.publicationEpoch)==null) invalidEarthPosition()
}
/** Match JS Math.round, including negative half values. Never log input fixes. */
fun approximateEarthCoordinate(value: Double): Double = floor(value*100+0.5)/100
