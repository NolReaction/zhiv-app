package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import ru.zhiv.auth.AuthFailure
import ru.zhiv.notifications.*
import java.security.MessageDigest
import java.sql.Connection
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

internal val notificationJson = Json { encodeDefaults = true; ignoreUnknownKeys = false }
internal fun notificationEndpointHash(endpoint: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(endpoint.toByteArray())
internal fun Instant.notificationSqlTime(): OffsetDateTime = atOffset(ZoneOffset.UTC)

class JdbcNotificationRepository(private val source: DataSource, private val push: WebPushConfig = WebPushConfig()) : NotificationRepository {
    private data class Actor(val user: UUID, val session: UUID, val publicId: String, val zone: String)
    private fun actor(c: Connection, hash: ByteArray): Actor = c.economyRows("""
        SELECT u.id,s.id,u.public_id,u.timezone_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND u.deleted_at IS NULL AND u.banned_at IS NULL
    """, hash) { Actor(it.getObject(1,UUID::class.java),it.getObject(2,UUID::class.java),it.getString(3),it.getString(4)) }.singleOrNull()
        ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    private suspend fun <T> transaction(hash: ByteArray, owner: String, block: (Connection, Actor) -> T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit=false
            try {
                val first=actor(c,hash)
                c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",first.user) { true }
                val current=actor(c,hash)
                if(current.user!=first.user || current.publicId!=owner) throw AuthFailure("NOTIFICATION_OWNER_CHANGED", "Открыт другой профиль. Обновите страницу.",409)
                c.economyUpdate("INSERT INTO notification_preferences(user_id,preferences) VALUES (?,?::jsonb) ON CONFLICT DO NOTHING",
                    current.user,notificationJson.encodeToString(NotificationPreferences(timeZone=current.zone)))
                val result=block(c,current)
                c.commit(); result
            } catch(error: Exception) { c.rollback(); throw error }
        }
    }
    private fun view(c: Connection, a: Actor): NotificationView {
        val preferences=c.economyRows("SELECT preferences::text FROM notification_preferences WHERE user_id=?",a.user) {
            notificationJson.decodeFromString<NotificationPreferences>(it.getString(1))
        }.single()
        val subscribed=c.economyRows("SELECT 1 FROM notification_subscriptions WHERE user_id=? AND session_id=?",a.user,a.session) { true }.isNotEmpty()
        return NotificationView(a.publicId,preferences,push.delivery(),NotificationSubscriptionState(subscribed))
    }
    override suspend fun snapshot(hash: ByteArray, owner: String): NotificationView = transaction(hash,owner) { c,a -> view(c,a) }
    override suspend fun preferences(hash: ByteArray, owner: String, preferences: NotificationPreferences): NotificationView {
        validateNotificationPreferences(preferences)
        return transaction(hash,owner) { c,a ->
            c.economyUpdate("UPDATE notification_preferences SET preferences=?::jsonb,updated_at=clock_timestamp() WHERE user_id=?",notificationJson.encodeToString(preferences),a.user)
            c.economyRows("SELECT notification_sync_sources(?)",a.user) { true }
            // New limits/quiet hours apply immediately, including previously deferred rows.
            c.economyUpdate("UPDATE notification_events SET next_attempt_at=greatest(due_at,clock_timestamp()) WHERE user_id=? AND state='pending'",a.user)
            view(c,a)
        }
    }
    override suspend fun subscribe(hash: ByteArray, owner: String, subscription: BrowserPushSubscription): NotificationView {
        validatePushSubscription(subscription)
        return transaction(hash,owner) { c,a ->
            if(!push.configured) throw AuthFailure("PUSH_NOT_CONFIGURED","Уведомления ещё не подключены на сервере",503)
            val endpointHash=notificationEndpointHash(subscription.endpoint)
            // A capability URL never changes owner on a blind upsert. Logging out
            // invalidates the old subscription before a new account can bind it.
            val previous=c.economyRows("SELECT user_id FROM notification_subscriptions WHERE endpoint_hash=? FOR UPDATE",endpointHash) { it.getObject(1,UUID::class.java) }.singleOrNull()
            if(previous!=null && previous!=a.user) throw AuthFailure("PUSH_SUBSCRIPTION_CONFLICT","Отключите прежнюю подписку этого браузера и подключите снова",409)
            val count=c.economyRows("SELECT count(*) FROM notification_subscriptions WHERE user_id=? AND session_id<>?",a.user,a.session) { it.getInt(1) }.single()
            if(count>=5) throw AuthFailure("PUSH_DEVICE_LIMIT","Уведомления уже подключены на пяти устройствах",409)
            c.economyUpdate("DELETE FROM notification_subscriptions WHERE user_id=? AND session_id=? AND endpoint_hash<>?",a.user,a.session,endpointHash)
            val changed=c.economyUpdate("""INSERT INTO notification_subscriptions(endpoint_hash,user_id,session_id,endpoint,p256dh,auth)
                VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET session_id=EXCLUDED.session_id,
                p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,updated_at=clock_timestamp()
                WHERE notification_subscriptions.user_id=EXCLUDED.user_id""",endpointHash,a.user,a.session,subscription.endpoint,subscription.keys.p256dh,subscription.keys.auth)
            if(changed!=1) throw AuthFailure("PUSH_SUBSCRIPTION_CONFLICT","Отключите прежнюю подписку этого браузера и подключите снова",409)
            c.economyRows("SELECT notification_sync_sources(?)",a.user) { true }
            view(c,a)
        }
    }
    override suspend fun unsubscribe(hash: ByteArray, owner: String, endpoint: String): NotificationView {
        validatePushEndpoint(endpoint)
        return transaction(hash,owner) { c,a ->
            c.economyUpdate("DELETE FROM notification_subscriptions WHERE endpoint_hash=? AND user_id=? AND session_id=?",notificationEndpointHash(endpoint),a.user,a.session)
            view(c,a)
        }
    }
    override suspend fun presence(hash: ByteArray, owner: String) { transaction(hash,owner) { c,a ->
        c.economyUpdate("UPDATE notification_preferences SET last_visible_at=clock_timestamp() WHERE user_id=?",a.user)
    } }
}
