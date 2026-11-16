package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.notifications.*
import java.sql.Connection
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

internal fun nativeNotificationTokenHash(platform: String, token: String): ByteArray = notificationEndpointHash("$platform:$token")

class JdbcNativeNotificationRepository(
    private val source: DataSource,
    private val configured: (String) -> Boolean = { false },
) : NativeNotificationRepository {
    private data class Actor(val user: UUID, val session: UUID, val publicId: String, val zone: String, val platform: String?, val createdAt: OffsetDateTime)
    private fun actor(c: Connection, hash: ByteArray): Actor = c.economyRows("""
        SELECT u.id,s.id,u.public_id,u.timezone_id,s.mobile_platform,s.created_at
        FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND u.deleted_at IS NULL AND u.banned_at IS NULL
    """, hash) { Actor(it.getObject(1,UUID::class.java),it.getObject(2,UUID::class.java),it.getString(3),it.getString(4),it.getString(5),it.getObject(6,OffsetDateTime::class.java)) }.singleOrNull()
        ?: throw AuthFailure("UNAUTHORIZED", "Войдите в профиль ещё раз", 401)
    private fun conflict(): Nothing = throw AuthFailure("NATIVE_PUSH_SUBSCRIPTION_CONFLICT", "Отключите уведомления прежнего аккаунта или завершите его сеанс в разделе «Устройства», затем подключите снова", 409)
    private suspend fun <T> transaction(hash: ByteArray, owner: String, platform: String, block: (Connection,Actor) -> T): T = withContext(Dispatchers.IO) {
        validateNativePushPlatform(platform)
        source.connection.use { c ->
            c.autoCommit=false
            try {
                val first=actor(c,hash)
                c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",first.user) { true }
                val current=actor(c,hash)
                if(current.user!=first.user || current.publicId!=owner) throw AuthFailure("NOTIFICATION_OWNER_CHANGED", "Открыт другой профиль. Обновите приложение.", 409)
                if(current.platform!=platform) throw AuthFailure("NATIVE_PUSH_PLATFORM_MISMATCH", "Войдите в аккаунт заново из приложения на этом устройстве", 409)
                c.economyUpdate("INSERT INTO notification_preferences(user_id,preferences) VALUES (?,?::jsonb) ON CONFLICT DO NOTHING",current.user,
                    notificationJson.encodeToString(NotificationPreferences(timeZone=current.zone)))
                val result=block(c,current)
                c.commit(); result
            } catch(error: Exception) { c.rollback(); throw error }
        }
    }
    private fun view(c: Connection,a: Actor,platform: String): NativeNotificationView {
        val preferences=c.economyRows("SELECT preferences::text FROM notification_preferences WHERE user_id=?",a.user) {
            notificationJson.decodeFromString<NotificationPreferences>(it.getString(1))
        }.single()
        val subscribed=c.economyRows("SELECT 1 FROM native_notification_subscriptions WHERE user_id=? AND session_id=? AND platform=?",a.user,a.session,platform) { true }.isNotEmpty()
        val enabled=configured(platform)
        return NativeNotificationView(a.publicId,preferences,NativeNotificationDelivery(enabled,platform,if(enabled) null else "not_configured"),NotificationSubscriptionState(subscribed))
    }
    override suspend fun snapshot(hash: ByteArray,owner: String,platform: String): NativeNotificationView = transaction(hash,owner,platform) { c,a -> view(c,a,platform) }
    override suspend fun subscribe(hash: ByteArray,owner: String,platform: String,token: String): NativeNotificationView {
        validateNativePushToken(platform,token)
        return transaction(hash,owner,platform) { c,a ->
            if(!configured(platform)) throw AuthFailure("NATIVE_PUSH_NOT_CONFIGURED", "Уведомления ещё не подключены на сервере",503)
            val tokenHash=nativeNotificationTokenHash(platform,token)
            // Expiry is authoritative even if the maintenance worker has not run.
            c.economyUpdate("""DELETE FROM native_notification_subscriptions n WHERE token_hash=? AND EXISTS(
                SELECT 1 FROM app_sessions s WHERE s.id=n.session_id AND
                (s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.mobile_platform IS DISTINCT FROM n.platform))""",tokenHash)
            val previous=c.economyRows("""SELECT n.user_id,n.session_id,s.created_at FROM native_notification_subscriptions n
                JOIN app_sessions s ON s.id=n.session_id WHERE n.token_hash=? FOR UPDATE OF n""",tokenHash) {
                Triple(it.getObject(1,UUID::class.java),it.getObject(2,UUID::class.java),it.getObject(3,OffsetDateTime::class.java))
            }.singleOrNull()
            // A device address is not authority to move another account's subscription.
            // Delayed registration from an older same-owner session must not retake it.
            if(previous!=null && (previous.first!=a.user || (previous.second!=a.session && !a.createdAt.isAfter(previous.third)))) conflict()
            val count=c.economyRows("""SELECT count(*) FROM (
                SELECT n.session_id FROM notification_subscriptions n JOIN app_sessions s ON s.id=n.session_id
                    WHERE n.user_id=? AND n.session_id<>? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
                UNION SELECT n.session_id FROM native_notification_subscriptions n JOIN app_sessions s ON s.id=n.session_id
                    WHERE n.user_id=? AND n.session_id<>? AND n.token_hash<>? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            ) devices""",a.user,a.session,a.user,a.session,tokenHash) { it.getInt(1) }.single()
            if(count>=5) throw AuthFailure("PUSH_DEVICE_LIMIT", "Уведомления уже подключены на пяти устройствах",409)
            c.economyUpdate("DELETE FROM native_notification_subscriptions WHERE user_id=? AND session_id=? AND platform=? AND token_hash<>?",a.user,a.session,platform,tokenHash)
            val changed=c.economyUpdate("""INSERT INTO native_notification_subscriptions(token_hash,user_id,session_id,platform,token)
                VALUES (?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET session_id=EXCLUDED.session_id,updated_at=clock_timestamp()
                WHERE native_notification_subscriptions.user_id=EXCLUDED.user_id""",tokenHash,a.user,a.session,platform,token)
            if(changed!=1) conflict()
            c.economyRows("SELECT notification_sync_sources(?)",a.user) { true }
            view(c,a,platform)
        }
    }
    override suspend fun unsubscribe(hash: ByteArray,owner: String,platform: String): NativeNotificationView = transaction(hash,owner,platform) { c,a ->
        c.economyUpdate("DELETE FROM native_notification_subscriptions WHERE user_id=? AND session_id=? AND platform=?",a.user,a.session,platform)
        view(c,a,platform)
    }
}
