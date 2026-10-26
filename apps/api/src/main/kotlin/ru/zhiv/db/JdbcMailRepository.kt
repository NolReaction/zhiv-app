package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import ru.zhiv.admin.AdminConfig
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.ECONOMY_MAX_PEARLS
import ru.zhiv.economy.EconomyMoney
import ru.zhiv.mail.*
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

private val mailJson=Json { encodeDefaults=true;ignoreUnknownKeys=false }
private fun ResultSet.mailTime(name: String): String?=getObject(name,OffsetDateTime::class.java)?.toInstant()?.toString()
private fun validAttachments(value: MailAttachments): Boolean {
    val ids= value.worldItems+value.finds+value.rods+value.hooks+value.gameItems+value.achievements
    return value.coins in -900_719_925_474_099L..900_719_925_474_099L && value.pearls in -900_719_925_474_099L..900_719_925_474_099L &&
        value.items.size<=100 && value.items.all { (id,count)->id.length in 1..80 && count in 0..1_000_000_000L } &&
        value.buildings.size<=30 && value.buildings.all { (id,level)->id.length in 1..80 && level in 0..100 } &&
        value.productionSlots.size<=30 && value.productionSlots.all { (id,count)->id.length in 1..80 && count in 0..100 } &&
        ids.size<=200 && ids.all { it.length in 1..80 && !ru.zhiv.identity.hasUserTextControls(it) }
}

/** Caller holds the common account lock. Mail is a receipt, not a claimable gift.
 * Keep it inside the same transaction as the authoritative grant and its audit. */
internal fun insertAdminMail(c: Connection,user: UUID,sourceKey: String,type: String,title: String,body: String,
    notify: Boolean,now: OffsetDateTime,attachments: MailAttachments? = null): UUID {
    require(type in mailTypes && sourceKey.length in 1..160 && Regex("^[a-z]+:[A-Za-z0-9:_-]+$").matches(sourceKey))
    require(validPlayerMailMessage(PlayerMailMessage(title,body)) && (attachments==null || validAttachments(attachments)))
    val inserted=c.economyRows("""INSERT INTO player_mail_messages(user_id,source_key,type,title,body,notify,attachments,created_at,welcome_pearls)
        SELECT ?,?,?,?,?,?,?::jsonb,?,? WHERE EXISTS(SELECT 1 FROM app_users WHERE id=? AND deleted_at IS NULL AND banned_at IS NULL)
        ON CONFLICT(user_id,source_key) DO NOTHING RETURNING id""",user,sourceKey,type,title,body,notify,
        attachments?.let { mailJson.encodeToString(it) },now,if(sourceKey==WELCOME_MAIL_SOURCE) WELCOME_MAIL_PEARLS else null,user) { it.getObject(1,UUID::class.java) }.firstOrNull()
    if(inserted!=null) {
        if(notify) enqueueMailNotification(c,user,inserted,now)
        return inserted
    }
    return c.economyRows("SELECT id FROM player_mail_messages WHERE user_id=? AND source_key=?",user,sourceKey) {
        it.getObject(1,UUID::class.java)
    }.firstOrNull() ?: throw AuthFailure("ADMIN_USER_NOT_FOUND","Профиль не найден",404)
}

/** Both account locks are held by lifecycle. A read copy stays read on merge;
 * existing target IDs win, and push capabilities are never recreated here. */
internal fun mergePlayerMail(c: Connection,target: UUID,source: UUID) {
    c.economyUpdate("""UPDATE player_mail_messages kept SET read_at=CASE WHEN kept.read_at IS NULL THEN incoming.read_at
        WHEN incoming.read_at IS NULL THEN kept.read_at ELSE least(kept.read_at,incoming.read_at) END,
        welcome_claimed_at=CASE WHEN kept.welcome_claimed_at IS NULL THEN incoming.welcome_claimed_at
        WHEN incoming.welcome_claimed_at IS NULL THEN kept.welcome_claimed_at ELSE least(kept.welcome_claimed_at,incoming.welcome_claimed_at) END
        FROM player_mail_messages incoming WHERE kept.user_id=? AND incoming.user_id=? AND kept.source_key=incoming.source_key""",target,source)
    c.economyUpdate("""DELETE FROM player_mail_messages incoming USING player_mail_messages kept
        WHERE incoming.user_id=? AND kept.user_id=? AND incoming.source_key=kept.source_key""",source,target)
    c.economyUpdate("UPDATE player_mail_messages SET user_id=? WHERE user_id=?",target,source)
}

class JdbcMailRepository(private val source: DataSource,private val adminConfig: AdminConfig = AdminConfig()): MailRepository {
    private data class Actor(val id: UUID,val publicId: String)
    private fun actor(c: Connection,hash: ByteArray,admin: Boolean = false,lockSession: Boolean = false): Actor {
        val actor=c.economyRows("""SELECT u.id,u.public_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
            WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.deleted_at IS NULL AND u.banned_at IS NULL
            ${if(lockSession) "FOR UPDATE OF s" else ""}""",hash) { Actor(it.getObject(1,UUID::class.java),it.getString(2)) }.firstOrNull()
            ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401)
        if(admin && actor.publicId !in adminConfig.allowedPublicIds) throw AuthFailure("ADMIN_FORBIDDEN","Нет доступа к панели управления",403)
        return actor
    }
    private fun owner(actor: Actor,expected: String) { if(actor.publicId!=expected) mailFailure("MAIL_OWNER_CHANGED","Открыт другой профиль. Обновите почту.",409) }
    private fun now(c: Connection): OffsetDateTime=c.economyRows("SELECT clock_timestamp()") { it.getObject(1,OffsetDateTime::class.java) }.single()
    private suspend fun <T> tx(readOnly: Boolean = false,block:(Connection)->T): T=withContext(Dispatchers.IO) {
        source.connection.use { c ->
            // Read snapshots are consistent; writes recheck live sessions after
            // sorted account locks and see a concurrent request's committed receipt.
            c.transactionIsolation=if(readOnly) Connection.TRANSACTION_REPEATABLE_READ else Connection.TRANSACTION_READ_COMMITTED
            c.isReadOnly=readOnly;c.autoCommit=false
            try {
                c.economyUpdate("SET LOCAL statement_timeout='8s'");c.economyUpdate("SET LOCAL lock_timeout='3s'")
                block(c).also { c.commit() }
            } catch(error: Exception) {
                c.rollback()
                if(error is SQLException && error.sqlState in setOf("40001","40P01","55P03"))
                    throw AuthFailure("MAIL_BUSY","Почта обновляется. Повторите прежний запрос.",409)
                throw error
            }
        }
    }
    private fun unread(c: Connection,user: UUID): Long=c.economyRows("SELECT count(*) FROM player_mail_messages WHERE user_id=? AND read_at IS NULL",user) { it.getLong(1) }.single()
    private fun message(r: ResultSet)=MailMessage(r.getObject("id").toString(),r.getString("type"),r.getString("title"),r.getString("body"),
        r.mailTime("created_at")!!,r.mailTime("read_at"),r.getBoolean("notify"),r.getString("attachments")?.let { mailJson.decodeFromString<MailAttachments>(it) },
        if(r.getString("source_key")==WELCOME_MAIL_SOURCE) MailGift(pearls=(r.getObject("welcome_pearls") as? Number)?.toLong() ?: 100L,
            claimedAt=r.mailTime("welcome_claimed_at")) else null)
    override suspend fun inbox(sessionHash: ByteArray,expectedOwnerPublicId: String,cursor: String?,limit: Int): MailboxPage {
        validateMailOwner(expectedOwnerPublicId);if(limit !in 1..50) invalidMail()
        val after=MailCursor.decode(cursor)
        val (page,hasWelcome)=tx(readOnly=true) { c ->
            val actor=actor(c,sessionHash);owner(actor,expectedOwnerPublicId)
            val values=mutableListOf<Any?>(actor.id)
            if(after!=null) { values+=after.at.atOffset(ZoneOffset.UTC);values+=after.id }
            values+=limit+1
            val messages=c.economyRows("""SELECT * FROM player_mail_messages WHERE user_id=?
                ${if(after!=null) "AND (created_at,id)<(?::timestamptz,?::uuid)" else ""}
                ORDER BY created_at DESC,id DESC LIMIT ?""",*values.toTypedArray(),read=::message)
            val page=messages.take(limit)
            val next=if(messages.size>limit) page.last().let { MailCursor(java.time.Instant.parse(it.createdAt),UUID.fromString(it.id)).encode() } else null
            val notify=c.economyRows("""SELECT id,created_at FROM player_mail_messages WHERE user_id=? AND notify AND read_at IS NULL
                ORDER BY created_at DESC,id DESC LIMIT 1""",actor.id) { MailNotification(it.getObject(1).toString(),it.mailTime("created_at")!!) }.firstOrNull()
            MailboxPage(actor.publicId,unread(c,actor.id),page,next,now(c).toInstant().toString(),notify) to
                c.economyRows("SELECT 1 FROM player_mail_messages WHERE user_id=? AND source_key=?",actor.id,WELCOME_MAIL_SOURCE){true}.isNotEmpty()
        }
        if(hasWelcome) return page
        // Normal polling remains a read-only, lock-free snapshot. Only first
        // delivery obtains the shared account lock and rechecks its live session.
        tx { c ->
            val current=lockedActor(c,sessionHash,expectedOwnerPublicId)
            insertAdminMail(c,current.id,WELCOME_MAIL_SOURCE,"event",WELCOME_MAIL_TITLE,WELCOME_MAIL_BODY,false,now(c))
        }
        return inbox(sessionHash,expectedOwnerPublicId,cursor,limit)
    }
    private fun lockedActor(c: Connection,hash: ByteArray,expected: String): Actor {
        val initial=actor(c,hash);owner(initial,expected)
        c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",initial.id){true}
        val current=actor(c,hash,lockSession=true);owner(current,expected)
        if(current.id!=initial.id) mailFailure("MAIL_OWNER_CHANGED","Открыт другой профиль. Обновите почту.",409)
        return current
    }
    override suspend fun claim(sessionHash: ByteArray,expectedOwnerPublicId: String,id: UUID): MailClaimResult {
        validateMailOwner(expectedOwnerPublicId)
        return tx { c ->
            val current=lockedActor(c,sessionHash,expectedOwnerPublicId)
            val letter=c.economyRows("""SELECT * FROM player_mail_messages WHERE id=? AND user_id=? AND source_key=? AND type='event' AND attachments IS NULL""",
                id,current.id,WELCOME_MAIL_SOURCE,read=::message).firstOrNull()
                ?: mailFailure("MAIL_NOT_FOUND","Письмо с подарком не найдено",404)
            val at=now(c)
            val claimedAt=letter.gift!!.claimedAt ?: run {
                ensureEconomyProfile(c,current.id)
                val before=readEconomyProfile(c,current.id)
                val normalized=EconomyMoney.redenominate(before.state)
                // Same visible-to-stored conversion as administrative grants.
                val units=letter.gift.pearls*2L
                if(normalized.wallet.pearls>ECONOMY_MAX_PEARLS-units)
                    mailFailure("ECONOMY_CAPACITY","В кошельке пока нет места для подарка",409)
                saveEconomyProfile(c,current.id,normalized.copy(wallet=normalized.wallet.copy(pearls=normalized.wallet.pearls+units)))
                c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,pearls,items)
                    VALUES (?,'mail:welcome:v1','welcome_mail',?,'{}'::jsonb)""",current.id,units)
                c.economyRows("UPDATE player_mail_messages SET welcome_claimed_at=? WHERE id=? AND user_id=? RETURNING welcome_claimed_at",at,id,current.id) {
                    it.mailTime("welcome_claimed_at")!!
                }.single()
            }
            MailClaimResult(current.publicId,id.toString(),letter.gift.copy(claimedAt=claimedAt),at.toInstant().toString())
        }
    }
    override suspend fun read(sessionHash: ByteArray,expectedOwnerPublicId: String,id: UUID): MailReadResult {
        validateMailOwner(expectedOwnerPublicId)
        return tx { c ->
            val initial=actor(c,sessionHash);owner(initial,expectedOwnerPublicId)
            c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",initial.id) { true }
            val current=actor(c,sessionHash,lockSession=true);owner(current,expectedOwnerPublicId)
            if(current.id!=initial.id) mailFailure("MAIL_OWNER_CHANGED","Открыт другой профиль. Обновите почту.",409)
            val at=now(c)
            val readAt=c.economyRows("""UPDATE player_mail_messages SET read_at=coalesce(read_at,?) WHERE id=? AND user_id=? RETURNING read_at""",at,id,current.id) {
                it.mailTime("read_at")!!
            }.firstOrNull() ?: mailFailure("MAIL_NOT_FOUND","Письмо не найдено",404)
            c.economyUpdate("UPDATE notification_events SET state='dismissed' WHERE user_id=? AND source_key=? AND state IN ('pending','sending')",current.id,"mail:$id")
            MailReadResult(current.publicId,id.toString(),readAt,unread(c,current.id),at.toInstant().toString())
        }
    }
    override suspend fun broadcast(sessionHash: ByteArray,request: AdminMailBroadcastRequest): AdminMailBroadcastReceipt {
        validateBroadcast(request)
        return tx { c ->
            val initial=actor(c,sessionHash,admin=true);val requestId=UUID.fromString(request.requestId)
            val payload=mailJson.encodeToString(request.copy(publicIds=request.publicIds.sorted()))
            c.economyRows("SELECT pg_advisory_xact_lock(?)",requestId.mostSignificantBits xor requestId.leastSignificantBits) { true }
            val previous=c.economyRows("""SELECT a.actor_public_id,a.action,a.payload=?::jsonb AS same_payload,b.*
                FROM admin_actions a LEFT JOIN admin_mail_broadcasts b ON b.request_id=a.request_id WHERE a.request_id=?""",payload,requestId) { r ->
                val same=r.getString("actor_public_id")==initial.publicId && r.getString("action")=="mail_broadcast" && r.getBoolean("same_payload")
                same to if(r.getObject("recipient_count")==null) null else AdminMailBroadcastReceipt(request.requestId,r.getLong("recipient_count"),r.mailTime("created_at")!!,r.getLong("recipient_count")>0)
            }.firstOrNull()
            if(previous!=null) {
                val current=actor(c,sessionHash,admin=true,lockSession=true)
                if(current.id!=initial.id || !previous.first || previous.second==null) mailFailure("ADMIN_REQUEST_CONFLICT","Этот запрос уже использован с другими параметрами",409)
                return@tx previous.second!!
            }
            val at=now(c)
            val ids=c.createArrayOf("text",request.publicIds.toTypedArray())
            val counts=try { c.economyRows("""WITH selected AS MATERIALIZED (
                    SELECT id FROM app_users WHERE deleted_at IS NULL AND banned_at IS NULL AND (? OR public_id=ANY(?)) ORDER BY id LIMIT 10001
                ), locked AS MATERIALIZED (
                    SELECT u.id,(u.id IN(SELECT id FROM selected) AND u.deleted_at IS NULL AND u.banned_at IS NULL) AS recipient FROM app_users u
                    WHERE u.id=? OR u.id IN(SELECT id FROM selected) ORDER BY u.id FOR NO KEY UPDATE
                ), inserted AS (
                    INSERT INTO player_mail_messages(user_id,source_key,type,title,body,notify,created_at)
                    SELECT id,?,'admin_notice',?,?,?,? FROM locked WHERE recipient AND (SELECT count(*) FROM selected)<=10000 RETURNING id,user_id,notify
                ), queued AS (
                    INSERT INTO notification_events(user_id,source_key,category,due_at,next_attempt_at)
                    SELECT i.user_id,'mail:'||i.id::text,'mail',?,? FROM inserted i WHERE i.notify
                        AND EXISTS(SELECT 1 FROM notification_preferences p WHERE p.user_id=i.user_id)
                        AND EXISTS(SELECT 1 FROM notification_subscriptions n JOIN app_sessions s ON s.id=n.session_id AND s.user_id=n.user_id
                            WHERE n.user_id=i.user_id AND s.revoked_at IS NULL AND s.expires_at>?)
                    ON CONFLICT(user_id,source_key) DO NOTHING RETURNING user_id
                ) SELECT (SELECT count(*) FROM selected),(SELECT count(*) FROM inserted),(SELECT count(*) FROM queued)""",
                request.audience=="all",ids,initial.id,"broadcast:$requestId",request.title,request.body,request.notify,at,at,at,at) {
                it.getLong(1) to it.getLong(2)
            }.single() } finally { ids.free() }
            if(counts.first>10000) mailFailure("ADMIN_MAIL_AUDIENCE_LIMIT","В рассылке допускается не более 10000 получателей",409)
            val current=actor(c,sessionHash,admin=true,lockSession=true)
            if(current.id!=initial.id) mailFailure("ADMIN_REQUEST_CONFLICT","Администратор изменился. Откройте панель заново.",409)
            // Runtime has INSERT-only access to immutable audit rows. Publish the
            // final outcome once, together with the fixed fanout and its receipt.
            c.economyUpdate("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,action,reason,
                affected_sessions,payload,changed,created_at) VALUES (?,?,?,?,?,'mail_broadcast',?,0,?::jsonb,?,?)""",
                requestId,current.id,current.id,current.publicId,current.publicId,request.reason,payload,counts.second>0,at)
            c.economyUpdate("""INSERT INTO admin_mail_broadcasts(request_id,title,body,audience,notify,recipient_count,created_at)
                VALUES (?,?,?,?,?,?,?)""",requestId,request.title,request.body,request.audience,request.notify,counts.second,at)
            AdminMailBroadcastReceipt(request.requestId,counts.second,at.toInstant().toString(),counts.second>0)
        }
    }
    override suspend fun broadcastHistory(sessionHash: ByteArray,offset: Int,limit: Int): AdminMailBroadcastHistory {
        if(offset !in 0..100_000 || limit !in 1..50) invalidMail()
        return tx(readOnly=true) { c ->
            actor(c,sessionHash,admin=true)
            val total=c.economyRows("SELECT count(*) FROM admin_mail_broadcasts") { it.getLong(1) }.single()
            val rows=c.economyRows("""SELECT b.*,a.actor_public_id,a.reason FROM admin_mail_broadcasts b
                JOIN admin_actions a ON a.request_id=b.request_id ORDER BY b.created_at DESC,b.request_id DESC LIMIT ? OFFSET ?""",limit,offset) { r ->
                AdminMailBroadcast(r.getObject("request_id").toString(),r.getString("actor_public_id"),r.getString("title"),r.getString("body"),
                    r.getString("audience"),r.getBoolean("notify"),r.getLong("recipient_count"),r.mailTime("created_at")!!,r.getString("reason"))
            }
            AdminMailBroadcastHistory(now(c).toInstant().toString(),total,offset,limit,rows)
        }
    }
}
