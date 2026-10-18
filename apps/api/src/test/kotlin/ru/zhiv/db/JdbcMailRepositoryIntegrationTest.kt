package ru.zhiv.db

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.AdminConfig
import ru.zhiv.auth.AuthFailure
import ru.zhiv.auth.LoginFlow
import ru.zhiv.config.AppConfig
import ru.zhiv.installZhivApi
import ru.zhiv.mail.*
import ru.zhiv.notifications.*
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.util.Base64
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker=true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcMailRepositoryIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    companion object { @Container private val postgres=Postgres() }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var config: AppConfig
    private val tokens=TokenCodec()
    private val time=OffsetDateTime.parse("2026-10-18T10:00:00Z")
    private data class Player(val id: UUID,val publicId: String,val hash: ByteArray,val raw: String)
    @BeforeAll fun setup() {
        config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        source=DatabaseFactory.create(config);DatabaseFactory.migrate(source);identities=JdbcZhivRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clear() { execute("TRUNCATE app_users CASCADE") }
    private fun execute(sql: String,vararg args: Any?)=source.connection.use { c -> c.economyUpdate(sql,*args).also { c.commit() } }
    private fun count(sql: String,vararg args: Any?): Long=source.connection.use { c -> c.economyRows(sql,*args){it.getLong(1)}.single() }
    private suspend fun player(): Player {
        val token=tokens.issue();val user=identities.bootstrap("Адресат",tokens.issue().hash,token.hash,365)
        return Player(user.id,user.publicId,token.hash,token.raw)
    }
    private fun repo(vararg admins: Player)=JdbcMailRepository(source,AdminConfig(admins.map { it.publicId }.toSet()))
    private fun mail(p: Player,key: String="event:${UUID.randomUUID()}",notify: Boolean=false,at: OffsetDateTime=time): UUID=source.connection.use { c ->
        c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",p.id){true}
        insertAdminMail(c,p.id,key,"event","Письмо","Текст для игрока",notify,at).also { c.commit() }
    }
    private fun broadcast(audience: String="all",ids: List<String> = emptyList(),notify: Boolean=false)=AdminMailBroadcastRequest(
        UUID.randomUUID().toString(),"Внутренняя причина проверки","Новости леса","Публичный текст\nБез внутренней причины",audience,ids,notify,"ОТПРАВИТЬ")
    private suspend fun connect(p: Player) {
        val notifications=JdbcNotificationRepository(source,WebPushConfig("test-public","test-private","mailto:test@example.test"))
        notifications.preferences(p.hash,p.publicId,NotificationPreferences(quietHoursEnabled=false))
        val enc=Base64.getUrlEncoder().withoutPadding()
        notifications.subscribe(p.hash,p.publicId,BrowserPushSubscription("https://fcm.googleapis.com/fcm/send/${UUID.randomUUID()}",PushKeys(
            enc.encodeToString(ByteArray(65).also { it[0]=4 }),enc.encodeToString(ByteArray(16)))))
    }

    @Test fun `inbox owner and read rights are checked on the server and duplicate read preserves the first time`()=runBlocking<Unit> {
        val a=player();val b=player();val repository=repo();val id=mail(a,notify=true)
        assertEquals(1L,repository.inbox(a.hash,a.publicId,null,20).unreadCount)
        assertEquals("MAIL_OWNER_CHANGED",assertFailsWith<AuthFailure>{repository.inbox(a.hash,b.publicId,null,20)}.code)
        assertEquals("MAIL_NOT_FOUND",assertFailsWith<AuthFailure>{repository.read(b.hash,b.publicId,id)}.code)
        assertEquals("MAIL_OWNER_CHANGED",assertFailsWith<AuthFailure>{repository.read(a.hash,b.publicId,id)}.code)
        val first=repository.read(a.hash,a.publicId,id)
        assertEquals(0L,first.unreadCount);assertEquals(first.readAt,repository.read(a.hash,a.publicId,id).readAt)
        assertNull(repository.inbox(a.hash,a.publicId,null,20).latestUnreadNotification)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",a.hash)
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure>{repository.inbox(a.hash,a.publicId,null,20)}.code)
    }

    @Test fun `pagination has a stable UUID tie break and notification metadata is independent of the selected page`()=runBlocking<Unit> {
        val a=player();val repository=repo();val important=mail(a,notify=true,at=time.minusDays(1))
        repeat(25){mail(a,at=time)}
        val first=repository.inbox(a.hash,a.publicId,null,20)
        assertEquals(26L,first.unreadCount);assertEquals(20,first.messages.size);assertEquals(important.toString(),first.latestUnreadNotification!!.id)
        assertFalse(first.messages.any { it.id==important.toString() })
        val next=repository.inbox(a.hash,a.publicId,first.nextCursor,20)
        assertEquals(6,next.messages.size);assertNull(next.nextCursor);assertEquals(26,(first.messages+next.messages).map { it.id }.distinct().size)
        assertEquals(important.toString(),next.latestUnreadNotification!!.id)
        mail(a,at=time.plusDays(1))
        assertEquals(next.messages,repository.inbox(a.hash,a.publicId,first.nextCursor,20).messages)
    }

    @Test fun `mail helper and notification queue share rollback and exact source key replay creates neither twice`()=runBlocking<Unit> {
        val a=player();connect(a);val key="admin:${UUID.randomUUID()}"
        val id=mail(a,key,notify=true)
        assertEquals(id,mail(a,key,notify=true))
        assertEquals(1L,count("SELECT count(*) FROM player_mail_messages WHERE user_id=?",a.id))
        assertEquals(1L,count("SELECT count(*) FROM notification_events WHERE user_id=? AND category='mail'",a.id))
        source.connection.use { c ->
            insertAdminMail(c,a.id,"admin:${UUID.randomUUID()}","admin_grant","Выдача","Уже применено",true,time,MailAttachments(coins=10))
            c.rollback()
        }
        assertEquals(1L,count("SELECT count(*) FROM player_mail_messages WHERE user_id=?",a.id))
        assertEquals(1L,count("SELECT count(*) FROM notification_events WHERE user_id=? AND category='mail'",a.id))
        repo().read(a.hash,a.publicId,id)
        assertEquals(1L,count("SELECT count(*) FROM notification_events WHERE user_id=? AND category='mail' AND state='dismissed'",a.id))
        source.connection.use { c -> c.economyRows("SELECT notification_sync_sources(?)",a.id){true};c.commit() }
        assertEquals(0L,count("SELECT count(*) FROM notification_events WHERE user_id=? AND category='mail'",a.id))
        mail(a,key,notify=true)
        assertEquals(0L,count("SELECT count(*) FROM notification_events WHERE user_id=? AND category='mail'",a.id))
    }

    @Test fun `broadcast snapshots eligible recipients and an uncertain retry never sends to later accounts`()=runBlocking<Unit> {
        val admin=player();val a=player();val banned=player();val deleted=player();val repository=repo(admin)
        execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Проверка фильтра рассылки' WHERE id=?",banned.id)
        execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",deleted.id)
        val request=broadcast();val receipt=repository.broadcast(admin.hash,request)
        assertEquals(2L,receipt.recipientCount);assertTrue(receipt.changed)
        val later=player();assertEquals(receipt,repository.broadcast(admin.hash,request))
        assertTrue(repository.inbox(later.hash,later.publicId,null,20).messages.isEmpty())
        val message=repository.inbox(a.hash,a.publicId,null,20).messages.single()
        assertFalse(Json.encodeToString(message).contains(request.reason));assertEquals(request.body,message.body)
        assertFalse(message.notify);assertNull(message.attachments)
        assertEquals(1L,repository.broadcastHistory(admin.hash,0,20).total)
        assertEquals(request.reason,repository.broadcastHistory(admin.hash,0,20).broadcasts.single().reason)
        assertEquals("ADMIN_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{repository.broadcast(admin.hash,request.copy(title="Другое письмо"))}.code)
    }

    @Test fun `concurrent exact broadcasts share a global receipt while another administrator cannot replay it`()=runBlocking<Unit> {
        val admin=player();val peer=player();val recipient=player();val repository=repo(admin,peer)
        val request=broadcast("players",listOf(recipient.publicId))
        val results=coroutineScope { listOf(async(Dispatchers.IO){repository.broadcast(admin.hash,request)},async(Dispatchers.IO){repository.broadcast(admin.hash,request)}).awaitAll() }
        assertEquals(results[0],results[1]);assertEquals(1L,count("SELECT count(*) FROM player_mail_messages WHERE user_id=?",recipient.id))
        assertEquals("ADMIN_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{repository.broadcast(peer.hash,request)}.code)
        assertEquals("ADMIN_FORBIDDEN",assertFailsWith<AuthFailure>{repository.broadcast(recipient.hash,broadcast())}.code)
        assertEquals("ADMIN_FORBIDDEN",assertFailsWith<AuthFailure>{repository.broadcastHistory(recipient.hash,0,20)}.code)
    }

    @Test fun `least privilege runtime broadcasts and replays without mutating either immutable audit table`()=runBlocking<Unit> {
        val admin=player();val recipient=player()
        execute("CREATE ROLE mail_runtime NOLOGIN")
        execute("GRANT USAGE ON SCHEMA public TO mail_runtime")
        execute("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO mail_runtime")
        execute("REVOKE ALL ON flyway_schema_history FROM mail_runtime")
        execute("REVOKE UPDATE,DELETE ON admin_actions,admin_mail_broadcasts FROM mail_runtime")
        HikariDataSource(HikariConfig().apply {
            jdbcUrl=postgres.jdbcUrl;username=postgres.username;password=postgres.password
            maximumPoolSize=2;minimumIdle=0;isAutoCommit=false;connectionInitSql="SET ROLE mail_runtime"
        }).use { runtime ->
            runtime.connection.use { c ->
                for(table in listOf("admin_actions","admin_mail_broadcasts")) {
                    val privileges=c.economyRows("SELECT has_table_privilege(current_user,?,'UPDATE'),has_table_privilege(current_user,?,'DELETE')",table,table) {
                        it.getBoolean(1) to it.getBoolean(2)
                    }.single()
                    assertFalse(privileges.first,"$table must remain immutable to the runtime")
                    assertFalse(privileges.second,"$table must remain immutable to the runtime")
                }
            }
            val repository=JdbcMailRepository(runtime,AdminConfig(setOf(admin.publicId)))
            val request=broadcast("players",listOf(recipient.publicId));val receipt=repository.broadcast(admin.hash,request)
            assertTrue(receipt.changed);assertEquals(1L,receipt.recipientCount)
            assertEquals(receipt,repository.broadcast(admin.hash,request))
            assertEquals(1L,count("SELECT count(*) FROM admin_actions WHERE request_id=? AND changed",UUID.fromString(request.requestId)))
            assertEquals(1L,count("SELECT count(*) FROM admin_mail_broadcasts WHERE request_id=?",UUID.fromString(request.requestId)))
            assertEquals(1L,repository.inbox(recipient.hash,recipient.publicId,null,20).unreadCount)
            repository.read(recipient.hash,recipient.publicId,UUID.fromString(repository.inbox(recipient.hash,recipient.publicId,null,20).messages.single().id))
            assertEquals(0L,repository.inbox(recipient.hash,recipient.publicId,null,20).unreadCount)
        }
    }

    @Test fun `selected scope is canonical and a zero audience receipt cannot expand after retry`()=runBlocking<Unit> {
        val admin=player();val a=player();val b=player();val repository=repo(admin)
        val request=broadcast("players",listOf(a.publicId,b.publicId))
        val receipt=repository.broadcast(admin.hash,request)
        assertEquals(receipt,repository.broadcast(admin.hash,request.copy(publicIds=request.publicIds.reversed())))
        assertTrue(repository.inbox(admin.hash,admin.publicId,null,20).messages.isEmpty())
        val future="0000-0000-0061";val empty=broadcast("players",listOf(future));val ignored=repository.broadcast(admin.hash,empty)
        assertEquals(0L,ignored.recipientCount);assertFalse(ignored.changed)
        execute("INSERT INTO app_users(public_id,display_name) VALUES (?,'Позже')",future)
        assertEquals(ignored,repository.broadcast(admin.hash,empty))
        assertEquals(0L,count("SELECT count(*) FROM player_mail_messages m JOIN app_users u ON u.id=m.user_id WHERE u.public_id=?",future))
    }

    @Test fun `bulk recipient limit rejects atomically and never creates a partial audit or delivery`()=runBlocking<Unit> {
        val admin=player();val repository=repo(admin);val request=broadcast()
        execute("INSERT INTO app_users(public_id,display_name) SELECT 'CAFE-0000-'||lpad(upper(to_hex(i)),4,'0'),'Bulk fixture' FROM generate_series(1,10001) i")
        assertEquals("ADMIN_MAIL_AUDIENCE_LIMIT",assertFailsWith<AuthFailure>{repository.broadcast(admin.hash,request)}.code)
        assertEquals(0L,count("SELECT count(*) FROM player_mail_messages"));assertEquals(0L,count("SELECT count(*) FROM admin_mail_broadcasts"))
        assertEquals(0L,count("SELECT count(*) FROM admin_actions WHERE request_id=?",UUID.fromString(request.requestId)))
    }

    @Test fun `merge keeps original message IDs deduplicates sources preserves read and does not recreate push`()=runBlocking<Unit> {
        val a=player();val b=player();val common="broadcast:${UUID.randomUUID()}";val kept=mail(a,common);val duplicate=mail(b,common)
        val transferred=mail(b,notify=true)
        repo().read(b.hash,b.publicId,duplicate)
        source.connection.use { c ->
            c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE",a.id,b.id){true}
            mergePlayerMail(c,a.id,b.id);c.commit()
        }
        val inbox=repo().inbox(a.hash,a.publicId,null,20)
        assertEquals(setOf(kept.toString(),transferred.toString()),inbox.messages.map { it.id }.toSet())
        assertNotNull(inbox.messages.single { it.id==kept.toString() }.readAt);assertEquals(1L,inbox.unreadCount)
        assertTrue(repo().inbox(b.hash,b.publicId,null,20).messages.isEmpty())
        assertEquals(0L,count("SELECT count(*) FROM notification_events WHERE category='mail'"))
    }

    @Test fun `real account deletion clears private mail while preserving the immutable broadcast receipt`()=runBlocking<Unit> {
        val admin=player();val a=player();val repository=repo(admin);repository.broadcast(admin.hash,broadcast("players",listOf(a.publicId)))
        val auth=JdbcAuthRepository(source);val subject=UUID.randomUUID().toString();val browser=tokens.issue().hash
        execute("INSERT INTO account_login_identities(provider,subject,user_id) VALUES ('vk',?,?)",subject,a.id)
        val proof=LoginFlow(tokens.issue().hash,browser,"vk","account",a.hash,null,null,"pkce",null,null,"delete","current")
        auth.create(proof);auth.recordAccountProof(auth.takeVk(proof.tokenHash,browser),subject);auth.deleteAccount(a.hash,browser,tokens.issue().hash)
        assertEquals(0L,count("SELECT count(*) FROM player_mail_messages WHERE user_id=?",a.id))
        assertEquals(1L,repository.broadcastHistory(admin.hash,0,20).total)
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure>{repository.inbox(a.hash,a.publicId,null,20)}.code)
    }

    @Test fun `mail routes enforce session owner origin plaintext privacy and no-store`()=testApplication {
        val admin=runBlocking{player()};val a=runBlocking{player()};val id=mail(a)
        application { installZhivApi(identities,identities,config,playerMail=repo(admin)) }
        val cookie="${config.cookieName}=${a.raw}";val path="/api/v1/mail?expectedOwnerPublicId=${a.publicId}"
        assertEquals(HttpStatusCode.Unauthorized,client.get(path).status)
        assertEquals(HttpStatusCode.Conflict,client.get("/api/v1/mail?expectedOwnerPublicId=${admin.publicId}"){header(HttpHeaders.Cookie,cookie)}.status)
        val inbox=client.get(path){header(HttpHeaders.Cookie,cookie)}
        assertEquals(HttpStatusCode.OK,inbox.status);assertEquals("no-store",inbox.headers[HttpHeaders.CacheControl])
        val read="/api/v1/mail/$id/read"
        val body=Json.encodeToString(MailReadRequest(a.publicId))
        assertEquals(HttpStatusCode.Forbidden,client.post(read){header(HttpHeaders.Cookie,cookie);header(HttpHeaders.Origin,"https://evil.example");contentType(ContentType.Application.Json);setBody(body)}.status)
        assertEquals(HttpStatusCode.OK,client.post(read){header(HttpHeaders.Cookie,cookie);header(HttpHeaders.Origin,"http://localhost");contentType(ContentType.Application.Json);setBody(body)}.status)
        assertEquals(HttpStatusCode.BadRequest,client.get("$path&limit=20&limit=30"){header(HttpHeaders.Cookie,cookie)}.status)
        val request=broadcast("players",listOf(a.publicId));val sent=client.post("/api/v1/admin/mail/broadcast"){
            header(HttpHeaders.Cookie,"${config.cookieName}=${admin.raw}");header(HttpHeaders.Origin,"http://localhost");contentType(ContentType.Application.Json);setBody(Json.encodeToString(request))}
        assertEquals(HttpStatusCode.OK,sent.status)
        assertFalse(client.get(path){header(HttpHeaders.Cookie,cookie)}.bodyAsText().contains(request.reason))
    }
}
