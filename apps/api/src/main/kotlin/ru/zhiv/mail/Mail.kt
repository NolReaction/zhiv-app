package ru.zhiv.mail

import kotlinx.serialization.Serializable
import ru.zhiv.auth.AuthFailure
import ru.zhiv.http.parseCanonicalUuidV4
import ru.zhiv.http.parsePublicId
import ru.zhiv.identity.hasUserTextControls
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Base64
import java.util.UUID

@Serializable data class PlayerMailMessage(val title: String, val body: String)
fun validPlayerMailMessage(value: PlayerMailMessage): Boolean = value.title == value.title.trim() && value.body == value.body.trim() &&
    value.title.codePointCount(0,value.title.length) in 1..120 && value.body.codePointCount(0,value.body.length) in 1..2000 &&
    !hasUserTextControls(value.title) && !hasUserTextControls(value.body,multiline=true)

/** A receipt of an already applied change. These attachments are never claimable. */
@Serializable data class MailAttachments(
    val coins: Long = 0, val pearls: Long = 0, val items: Map<String,Long> = emptyMap(),
    val buildings: Map<String,Int> = emptyMap(), val worldItems: List<String> = emptyList(), val finds: List<String> = emptyList(),
    val productionSlots: Map<String,Int> = emptyMap(), val rods: List<String> = emptyList(), val hooks: List<String> = emptyList(),
    val gameItems: List<String> = emptyList(), val achievements: List<String> = emptyList(),
)
@Serializable data class MailGift(val pearls: Long = WELCOME_MAIL_PEARLS, val claimedAt: String? = null)
const val WELCOME_MAIL_PEARLS = 30L
const val WELCOME_MAIL_SOURCE = "welcome:v1"
const val WELCOME_MAIL_TITLE = "Добро пожаловать в мой лес!"
const val WELCOME_MAIL_BODY = "Привет! Я очень рад, что ты начал играть в «Я Живой».\n\nЯ делаю эту игру один и прошёл большой путь, чтобы всё заработало как надо. Спасибо, что заглянул в мой лес!\n\nОставил тебе 30 жемчужин для первых приключений. Забери их ниже.\n\nДмитрий, автор «Я Живой»"
@Serializable data class MailMessage(val id: String, val type: String, val title: String, val body: String,
    val createdAt: String, val readAt: String?, val notify: Boolean, val attachments: MailAttachments? = null, val gift: MailGift? = null)
@Serializable data class MailNotification(val id: String, val createdAt: String)
@Serializable data class MailboxPage(val ownerPublicId: String, val unreadCount: Long, val messages: List<MailMessage>,
    val nextCursor: String?, val serverTime: String, val latestUnreadNotification: MailNotification?)
@Serializable data class MailReadRequest(val expectedOwnerPublicId: String)
@Serializable data class MailReadResult(val ownerPublicId: String, val id: String, val readAt: String,
    val unreadCount: Long, val serverTime: String)
@Serializable data class MailClaimResult(val ownerPublicId: String, val id: String, val gift: MailGift, val serverTime: String)
@Serializable data class AdminMailBroadcastRequest(val requestId: String, val reason: String, val title: String, val body: String,
    val audience: String, val publicIds: List<String> = emptyList(), val notify: Boolean, val confirmation: String)
@Serializable data class AdminMailBroadcastReceipt(val requestId: String, val recipientCount: Long, val createdAt: String, val changed: Boolean)
@Serializable data class AdminMailBroadcast(val requestId: String, val actorPublicId: String, val title: String, val body: String,
    val audience: String, val notify: Boolean, val recipientCount: Long, val createdAt: String, val reason: String)
@Serializable data class AdminMailBroadcastHistory(val serverTime: String, val total: Long, val offset: Int, val limit: Int,
    val broadcasts: List<AdminMailBroadcast>)

internal fun mailFailure(code: String, message: String, status: Int = 400): Nothing = throw AuthFailure(code,message,status)
internal fun invalidMail(): Nothing = mailFailure("INVALID_MAIL_REQUEST","Проверьте параметры почты")
internal fun validateMailOwner(owner: String) { if(parsePublicId(owner)!=owner) invalidMail() }
internal fun validateBroadcast(request: AdminMailBroadcastRequest) {
    if(parseCanonicalUuidV4(request.requestId)==null || !ru.zhiv.admin.validAdminReason(request.reason) ||
        !validPlayerMailMessage(PlayerMailMessage(request.title,request.body)) || request.confirmation!="ОТПРАВИТЬ" ||
        request.audience !in setOf("all","players") || request.publicIds.size>100 ||
        request.publicIds.distinct().size!=request.publicIds.size || request.publicIds.any { parsePublicId(it)!=it } ||
        (request.audience=="all" && request.publicIds.isNotEmpty()) || (request.audience=="players" && request.publicIds.isEmpty())) invalidMail()
}
internal val mailTypes = setOf("admin_notice","admin_grant","event","balance_correction")
internal data class MailCursor(val at: Instant, val id: UUID) {
    fun encode(): String = Base64.getUrlEncoder().withoutPadding().encodeToString("$at|$id".toByteArray(StandardCharsets.UTF_8))
    companion object {
        fun decode(raw: String?): MailCursor? {
            if(raw==null) return null
            if(raw.length !in 1..160 || !Regex("^[A-Za-z0-9_-]+$").matches(raw)) invalidMail()
            return runCatching {
                val value=String(Base64.getUrlDecoder().decode(raw),StandardCharsets.UTF_8).split('|')
                require(value.size==2)
                MailCursor(Instant.parse(value[0]),UUID.fromString(value[1])).also { require(it.encode()==raw) }
            }.getOrElse { invalidMail() }
        }
    }
}

interface MailRepository {
    suspend fun inbox(sessionHash: ByteArray, expectedOwnerPublicId: String, cursor: String? = null, limit: Int = 20): MailboxPage
    suspend fun read(sessionHash: ByteArray, expectedOwnerPublicId: String, id: UUID): MailReadResult
    suspend fun claim(sessionHash: ByteArray, expectedOwnerPublicId: String, id: UUID): MailClaimResult
    suspend fun broadcast(sessionHash: ByteArray, request: AdminMailBroadcastRequest): AdminMailBroadcastReceipt
    suspend fun broadcastHistory(sessionHash: ByteArray, offset: Int = 0, limit: Int = 20): AdminMailBroadcastHistory
}
