package ru.zhiv.feedback

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import java.time.OffsetDateTime
import java.util.UUID

val FEEDBACK_CATEGORIES = setOf("bug", "suggestion", "other")
val FEEDBACK_STATUSES = setOf("new", "reviewed", "resolved")

@Serializable
data class FeedbackAvailability(val serverTime: String, val canSubmit: Boolean, val nextAllowedAt: String?)
@Serializable
data class FeedbackRequest(val clientRequestId: String, val category: String, val message: String, val expectedOwnerPublicId: String)
@Serializable
data class FeedbackReceipt(val id: String, val clientRequestId: String, val createdAt: String, val nextAllowedAt: String, val replayed: Boolean)
@Serializable
data class FeedbackCooldownResponse(val code: String = "FEEDBACK_COOLDOWN", val message: String = "Можно отправить одно сообщение за 24 часа", val nextAllowedAt: String, val serverTime: String)
class FeedbackCooldown(val nextAllowedAt: OffsetDateTime, val serverTime: OffsetDateTime) : RuntimeException()
@Serializable
data class AdminFeedbackItem(
    val id: String, val category: String, val message: String, val status: String,
    val createdAt: String, val updatedAt: String, val authorPublicId: String, val authorDisplayName: String,
)
@Serializable
data class AdminFeedbackPage(val serverTime: String, val total: Long, val offset: Int, val limit: Int, val items: List<AdminFeedbackItem>)
@Serializable
data class FeedbackStatusRequest(val requestId: String, val status: String)

fun validatedFeedbackMessage(category: String, message: String): String {
    val normalized = message.replace("\r\n", "\n").trim()
    if (category !in FEEDBACK_CATEGORIES || normalized.codePointCount(0, normalized.length) !in 10..3000 ||
        normalized.any { it.isISOControl() && it != '\n' && it != '\t' }) {
        throw AuthFailure("INVALID_FEEDBACK", "Выберите тему и напишите от 10 до 3000 символов", 400)
    }
    return normalized
}

interface FeedbackRepository {
    suspend fun availability(sessionHash: ByteArray, expectedOwnerPublicId: String): FeedbackAvailability
    suspend fun submit(sessionHash: ByteArray, expectedOwnerPublicId: String, clientRequestId: UUID, category: String, message: String): FeedbackReceipt
    suspend fun list(sessionHash: ByteArray, status: String, category: String, offset: Int, limit: Int): AdminFeedbackPage
    suspend fun changeStatus(sessionHash: ByteArray, id: UUID, requestId: UUID, status: String): AdminFeedbackItem
}
