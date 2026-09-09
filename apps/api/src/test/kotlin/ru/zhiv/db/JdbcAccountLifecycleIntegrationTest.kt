package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.server.testing.testApplication
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import kotlinx.serialization.json.*
import kotlinx.serialization.encodeToString
import ru.zhiv.world.*
import ru.zhiv.installZhivApi
import kotlinx.coroutines.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.*
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.config.AppConfig
import ru.zhiv.security.TokenCodec
import java.sql.Connection
import java.sql.SQLException
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcAccountLifecycleIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres=Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var auth: JdbcAuthRepository
    private lateinit var people: JdbcZhivRepository
    private val tokens=TokenCodec()
    private data class Account(val id: UUID,val session: ByteArray,val subject: String)
    @BeforeAll fun setup() {
        source=DatabaseFactory.create(AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost")))
        DatabaseFactory.migrate(source);auth=JdbcAuthRepository(source);people=JdbcZhivRepository(source)
    }
    @AfterAll fun stop(){source.close()}
    private fun execute(sql: String,vararg values: Any?)=source.connection.use { c ->
        c.prepareStatement(sql).use { s->values.forEachIndexed{i,v->s.setObject(i+1,v)};s.executeUpdate() }.also { c.commit() }
    }
    private fun scalar(sql: String,vararg values: Any?): String?=source.connection.use { c ->
        c.prepareStatement(sql).use { s->values.forEachIndexed{i,v->s.setObject(i+1,v)};s.executeQuery().use{r->if(r.next())r.getString(1) else null} }
    }
    private fun flag(sql: String,vararg values: Any?): Boolean=source.connection.use { c ->
        c.prepareStatement(sql).use { s->values.forEachIndexed{i,v->s.setObject(i+1,v)};s.executeQuery().use{r->r.next() && r.getBoolean(1)} }
    }
    private suspend fun account(name: String="Профиль"): Account {
        val session=tokens.issue().hash;val subject=UUID.randomUUID().toString()
        val flow=LoginFlow(tokens.issue().hash,tokens.issue().hash,"vk","register",null,name,null,"pkce",null,null)
        return Account(auth.finish(flow,subject,session,365,"Device"),session,subject)
    }
    private suspend fun prove(current: Account,browser: ByteArray,action: String,role: String="current",owner: Account=current): LoginFlow {
        val flow=LoginFlow(tokens.issue().hash,browser,"vk","account",current.session,null,null,"pkce",null,null,action,role)
        auth.create(flow);auth.recordAccountProof(auth.takeVk(flow.tokenHash,browser),owner.subject)
        return flow
    }
    private suspend fun proveNewEmail(a: Account,browser: ByteArray,email: String) {
        val code=tokens.hash("code")
        val flow=LoginFlow(tokens.issue().hash,browser,"email","account",a.session,null,email,null,null,code,"email","new-email")
        auth.create(flow);auth.recordAccountProof(auth.verifyEmail(flow.tokenHash,browser,code),email)
    }
    private suspend fun readyMerge(a: Account,b: Account,browser: ByteArray,choices: MergeChoices=MergeChoices(providerChoices=mapOf("vk" to "current"))): ByteArray {
        prove(a,browser,"merge");prove(a,browser,"merge","other",b)
        val preview=tokens.issue().hash
        assertTrue(auth.previewMerge(a.session,browser,choices,preview).conflicts.isEmpty())
        return preview
    }
    private fun group(owner: Account,vararg members: Account): UUID=source.connection.use { c ->
        val id=UUID.randomUUID()
        c.prepareStatement("INSERT INTO circles(id,kind,title,created_by_user_id,creation_idempotency_key) VALUES (?,'GROUP','Семья',?,?)").use { s->s.setObject(1,id);s.setObject(2,owner.id);s.setObject(3,UUID.randomUUID());s.executeUpdate() }
        (listOf(owner)+members).forEach { a ->
            c.prepareStatement("INSERT INTO circle_memberships(circle_id,user_id,role,share_latest) VALUES (?,?,?,false)").use{s->s.setObject(1,id);s.setObject(2,a.id);s.setString(3,if(a==owner)"OWNER" else "MEMBER");s.executeUpdate()}
            c.prepareStatement("INSERT INTO circle_sharing_preferences(circle_id,user_id,sharing_mode,enabled_since) VALUES (?,?,'OFF',NULL)").use{s->s.setObject(1,id);s.setObject(2,a.id);s.executeUpdate()}
        }
        c.commit();id
    }
    private fun direct(a: Account,b: Account): UUID {
        val id=UUID.randomUUID()
        execute("INSERT INTO circles(id,kind,created_by_user_id,direct_user_low_id,direct_user_high_id) VALUES (?,'DIRECT',?,LEAST(?::uuid,?::uuid),GREATEST(?::uuid,?::uuid))",id,a.id,a.id,b.id,a.id,b.id)
        listOf(a,b).forEach{execute("INSERT INTO circle_sharing_preferences(circle_id,user_id,sharing_mode,enabled_since) VALUES (?,?,'OFF',NULL)",id,it.id)}
        return id
    }
    private fun sharing(a: Account,b: Account,mode: String) {
        execute("INSERT INTO recipient_sharing_preferences(actor_user_id,recipient_user_id,sharing_mode) VALUES (?,?,?) ON CONFLICT(actor_user_id,recipient_user_id) DO UPDATE SET sharing_mode=EXCLUDED.sharing_mode",a.id,b.id,mode)
    }

    @Test fun `proof requires matching owner session browser and action and cannot be replayed`(): Unit=runBlocking {
        val a=account();val b=account();val browser=tokens.issue().hash
        assertFailsWith<AuthFailure>{prove(a,browser,"delete",owner=b)}
        val flow=prove(a,browser,"delete")
        assertTrue(auth.lifecycle(a.session,browser).currentDelete)
        assertFalse(auth.lifecycle(a.session,tokens.issue().hash).currentDelete)
        assertFailsWith<AuthFailure>{auth.recordAccountProof(flow,a.subject)}
        assertEquals("ACCOUNT_PROOF_REQUIRED",assertFailsWith<AuthFailure>{auth.changeEmail(a.session,browser,tokens.issue().hash)}.code)
        val otherSession=tokens.issue().hash
        auth.finish(LoginFlow(tokens.issue().hash,browser,"vk","login",null,null,null,null,null,null),a.subject,otherSession,365,"Other")
        assertFailsWith<AuthFailure>{auth.deleteAccount(otherSession,browser,tokens.issue().hash)}
        execute("UPDATE account_action_proofs SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=?",a.id)
        assertFalse(auth.lifecycle(a.session,browser).currentDelete)
        assertFailsWith<AuthFailure>{auth.deleteAccount(a.session,browser,tokens.issue().hash)}
    }

    @Test fun `email change requires two proofs and replay cannot consume a later action`(): Unit=runBlocking {
        val a=account();val browser=tokens.issue().hash;val old="old-${UUID.randomUUID()}@example.com";val fresh="new-${UUID.randomUUID()}@example.com"
        auth.finish(LoginFlow(tokens.issue().hash,browser,"email","link",a.session,null,old,null,null,null),old,tokens.issue().hash,365,"Unused")
        val other=tokens.issue().hash
        auth.finish(LoginFlow(tokens.issue().hash,browser,"vk","login",null,null,null,null,null,null),a.subject,other,365,"Other")
        val code=tokens.issue().hash
        execute("INSERT INTO account_recovery_codes(code_hash,user_id) VALUES (?,?)",code,a.id)
        prove(a,browser,"email");proveNewEmail(a,browser,fresh)
        val key=tokens.issue().hash
        auth.changeEmail(a.session,browser,key)
        assertEquals(fresh,scalar("SELECT subject FROM account_login_identities WHERE user_id=? AND provider='email'",a.id))
        assertNull(people.findSessionUserId(other));assertEquals(a.id,people.findSessionUserId(a.session))
        assertTrue(flag("SELECT revoked_at IS NOT NULL FROM account_recovery_codes WHERE code_hash=?",code))
        assertFalse(auth.lifecycle(a.session,browser).currentEmail)
        prove(a,browser,"email")
        auth.changeEmail(a.session,browser,key)
        assertTrue(auth.lifecycle(a.session,browser).currentEmail,"receipt must not consume newer proof")
        assertFailsWith<AuthFailure>{auth.changeEmail(a.session,tokens.issue().hash,key)}
    }

    @Test fun `collision preview demands provider choice and does not mutate either account`(): Unit=runBlocking {
        val a=account("Первый");val b=account("Второй");val browser=tokens.issue().hash
        val emailA="a-${UUID.randomUUID()}@example.com";val emailB="b-${UUID.randomUUID()}@example.com"
        listOf(a to emailA,b to emailB).forEach{(p,email)->auth.finish(LoginFlow(tokens.issue().hash,browser,"email","link",p.session,null,email,null,null,null),email,tokens.issue().hash,365,"Unused")}
        prove(a,browser,"merge");prove(a,browser,"merge","other",b)
        val key=tokens.issue().hash
        val preview=auth.previewMerge(a.session,browser,MergeChoices(),key)
        assertEquals(setOf("email","vk"),preview.providerConflicts.map{it.provider}.toSet())
        assertEquals(2,preview.conflicts.size)
        assertEquals("ACCOUNT_MERGE_CONFLICT",assertFailsWith<AuthFailure>{auth.confirmMerge(a.session,browser,key)}.code)
        assertEquals(b.id,people.findSessionUserId(b.session))
        val chosen=tokens.issue().hash
        auth.previewMerge(a.session,browser,MergeChoices("other","current",mapOf("email" to "other","vk" to "current")),chosen)
        auth.confirmMerge(a.session,browser,chosen)
        val renamed=assertNotNull(people.findBySession(a.session))
        assertEquals("Второй",renamed.displayName)
        assertEquals(assertNotNull(renamed.displayNameChangedAt).plusHours(24),renamed.displayNameChangeAvailableAt)
        assertEquals(emailB,scalar("SELECT subject FROM account_login_identities WHERE user_id=? AND provider='email'",a.id))
        assertEquals(a.subject,scalar("SELECT subject FROM account_login_identities WHERE user_id=? AND provider='vk'",a.id))
        assertNull(people.findSessionUserId(b.session))
    }

    @Test fun `merge preserves both owned groups union history and immutable audiences with conservative duplicate privacy`(): Unit=runBlocking {
        val a=account();val b=account();val peer=account();val browser=tokens.issue().hash
        val groupA=group(a,peer);val groupB=group(b,peer)
        val duplicate=direct(a,peer);val sourceDirect=direct(b,peer)
        sharing(a,peer,"LATEST_ONLY");sharing(b,peer,"OFF")
        sharing(peer,b,"LATEST_ONLY")
        val oldMembership=scalar("SELECT id FROM circle_memberships WHERE circle_id=? AND user_id=? AND left_at IS NULL",groupB,b.id)
        val first=assertIs<CheckInResult.Accepted>(people.record(a.session,UUID.randomUUID()))
        val second=assertIs<CheckInResult.Accepted>(people.record(b.session,UUID.randomUUID()))
        val audiencesBefore=scalar("SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY check_in_id,circle_id,recipient_user_id)::text,'[]') FROM check_in_audiences x")
        val preview=readyMerge(a,b,browser)
        auth.confirmMerge(a.session,browser,preview)
        assertEquals(2L,people.findBySession(a.session)!!.checkInCount)
        assertEquals(a.id.toString(),scalar("SELECT created_by_user_id FROM circles WHERE id=? AND archived_at IS NULL",groupB))
        assertEquals(a.id.toString(),scalar("SELECT created_by_user_id FROM circles WHERE id=? AND archived_at IS NULL",groupA))
        assertEquals("OWNER",scalar("SELECT role FROM circle_memberships WHERE circle_id=? AND user_id=? AND left_at IS NULL",groupB,a.id))
        assertNotEquals(oldMembership,scalar("SELECT id FROM circle_memberships WHERE circle_id=? AND user_id=? AND left_at IS NULL",groupB,a.id))
        assertEquals("OFF",scalar("SELECT sharing_mode FROM effective_recipient_sharing(?,?)",a.id,peer.id))
        assertEquals("OFF",scalar("SELECT sharing_mode FROM effective_recipient_sharing(?,?)",peer.id,a.id))
        assertTrue(flag("SELECT archived_at IS NOT NULL FROM circles WHERE id=?",sourceDirect))
        assertTrue(flag("SELECT archived_at IS NULL FROM circles WHERE id=?",duplicate))
        assertEquals(audiencesBefore,scalar("SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY check_in_id,circle_id,recipient_user_id)::text,'[]') FROM check_in_audiences x"))
        assertEquals(a.id.toString(),scalar("SELECT user_id FROM check_ins WHERE id=?",first.eventId))
        assertEquals(b.id.toString(),scalar("SELECT user_id FROM check_ins WHERE id=?",second.eventId))
        assertEquals("0",scalar("SELECT count(*) FROM account_group_owner_transfers"))
        assertFailsWith<SQLException>{execute("UPDATE circles SET created_by_user_id=? WHERE id=?",peer.id,groupB)}
        auth.confirmMerge(a.session,browser,preview)
        assertEquals(2L,people.findBySession(a.session)!!.checkInCount)
    }

    @Test fun `privacy mutation after review rejects stale preview before changing ownership or access`(): Unit=runBlocking {
        val a=account();val b=account();val peer=account();val browser=tokens.issue().hash
        val group=group(b,peer);direct(b,peer)
        val preview=readyMerge(a,b,browser)
        sharing(b,peer,"LATEST_ONLY")
        assertEquals("ACCOUNT_PREVIEW_STALE",assertFailsWith<AuthFailure>{auth.confirmMerge(a.session,browser,preview)}.code)
        assertEquals(b.id.toString(),scalar("SELECT created_by_user_id FROM circles WHERE id=?",group))
        assertEquals(b.id,people.findSessionUserId(b.session))
        assertTrue(auth.lifecycle(a.session,browser).currentMerge)
    }

    @Test fun `concurrent identical confirms commit one union and return replay success`(): Unit=runBlocking {
        val a=account();val b=account();val browser=tokens.issue().hash
        val preview=readyMerge(a,b,browser)
        coroutineScope { (1..2).map { async(Dispatchers.IO){auth.confirmMerge(a.session,browser,preview)} }.awaitAll() }
        assertEquals("1",scalar("SELECT count(*) FROM account_merge_sources WHERE source_user_id=? AND target_user_id=?",b.id,a.id))
        assertEquals("1",scalar("SELECT count(*) FROM account_operation_receipts WHERE token_hash=?",preview))
        assertFailsWith<AuthFailure>{auth.confirmMerge(a.session,tokens.issue().hash,preview)}
    }

    @Test fun `repeated merge flattens all prior sources and deletion closes all access while retaining immutable events`(): Unit=runBlocking {
        val a=account();val b=account();val c=account();val browser=tokens.issue().hash
        listOf(a,b,c).forEach{assertIs<CheckInResult.Accepted>(people.record(it.session,UUID.randomUUID()))}
        auth.confirmMerge(a.session,browser,readyMerge(a,b,browser))
        auth.confirmMerge(c.session,browser,readyMerge(c,a,browser))
        assertEquals(3L,people.findBySession(c.session)!!.checkInCount)
        assertEquals("2",scalar("SELECT count(*) FROM account_merge_sources WHERE target_user_id=?",c.id))
        assertEquals("0",scalar("SELECT count(*) FROM account_merge_sources WHERE target_user_id=?",a.id))
        prove(c,browser,"delete");val key=tokens.issue().hash
        auth.deleteAccount(c.session,browser,key)
        assertNull(people.findSessionUserId(c.session));assertNull(people.findSessionUserId(a.session));assertNull(people.findSessionUserId(b.session))
        assertEquals("3",scalar("SELECT count(*) FROM check_ins WHERE user_id IN (?,?,?)",a.id,b.id,c.id))
        auth.deleteAccount(c.session,browser,key)
    }

    @Test fun `delete anonymizes private fields closes owned groups and invalidates an in flight verified signup`(): Unit=runBlocking {
        val a=account();val peer=account();val browser=tokens.issue().hash
        val group=group(a,peer);direct(a,peer)
        execute("UPDATE app_users SET status_text='Секрет',status_updated_at=statement_timestamp(),updated_at=statement_timestamp(),avatar_storage_key='private/avatar',avatar_updated_at=statement_timestamp() WHERE id=?",a.id)
        execute("INSERT INTO user_status_write_keys(user_id,idempotency_key,status_text) VALUES (?,?,'Секрет')",a.id,UUID.randomUUID())
        execute("INSERT INTO private_person_nicknames(viewer_user_id,subject_user_id,nickname) VALUES (?,?,'Имя')",peer.id,a.id)
        execute("INSERT INTO account_recovery_codes(code_hash,user_id) VALUES (?,?)",tokens.issue().hash,a.id)
        val login=LoginFlow(tokens.issue().hash,browser,"vk","login",null,null,null,"pkce",null,null)
        auth.create(login);val inFlight=auth.takeVk(login.tokenHash,browser)
        // A ticket from a concurrent first-time flow may predate later identity attachment.
        val ticket=tokens.issue().hash
        auth.prepareRegistration(login,a.subject,ticket)
        prove(a,browser,"delete");val request=tokens.issue().hash
        auth.deleteAccount(a.session,browser,request)
        assertTrue(flag("SELECT deleted_at IS NOT NULL AND display_name='Удалённый профиль' AND status_text IS NULL AND avatar_storage_key IS NULL FROM app_users WHERE id=?",a.id))
        assertEquals("0",scalar("SELECT count(*) FROM account_login_identities WHERE user_id=?",a.id))
        assertEquals("0",scalar("SELECT count(*) FROM user_status_write_keys WHERE user_id=?",a.id))
        assertEquals("0",scalar("SELECT count(*) FROM private_person_nicknames WHERE viewer_user_id=? OR subject_user_id=?",a.id,a.id))
        assertTrue(flag("SELECT archived_at IS NOT NULL FROM circles WHERE id=?",group))
        assertEquals("0",scalar("SELECT count(*) FROM circle_memberships WHERE circle_id=? AND left_at IS NULL",group))
        assertFalse(auth.hasRegistration(ticket,browser))
        assertFailsWith<AuthFailure>{auth.finish(inFlight,a.subject,tokens.issue().hash,365,"Replay")}
        assertFailsWith<AuthFailure>{auth.completeRegistration(ticket,browser,"Resurrect",tokens.issue().hash,365,"Replay")}
        assertFailsWith<AuthFailure>{auth.deleteAccount(a.session,tokens.issue().hash,request)}
    }
    @Test fun `callback waiting on user lock cannot restore a removed email session`(): Unit=runBlocking {
        val a=account();val browser=tokens.issue().hash;val email="wait-${UUID.randomUUID()}@example.com"
        auth.finish(LoginFlow(tokens.issue().hash,browser,"email","link",a.session,null,email,null,null,null),email,tokens.issue().hash,365,"Unused")
        val login=LoginFlow(tokens.issue().hash,browser,"email","login",null,null,email,null,null,tokens.hash("123456"))
        auth.create(login)
        val verified=auth.verifyEmail(login.tokenHash,browser,requireNotNull(login.codeHash))
        val newSession=tokens.issue().hash
        source.connection.use { blocker ->
            blocker.prepareStatement("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE").use { q->q.setObject(1,a.id);q.executeQuery().close() }
            val attempt=async(Dispatchers.IO){runCatching{auth.finish(verified,email,newSession,365,"Old email")}}
            withTimeout(5_000) {
                while(scalar("SELECT count(*) FROM pg_stat_activity WHERE application_name='zhiv-api' AND wait_event_type='Lock' AND query LIKE '%deleted_at IS NULL FOR UPDATE%'")=="0") delay(10)
            }
            blocker.prepareStatement("INSERT INTO account_identity_retirements(provider,subject_hash) VALUES ('email',sha256(convert_to(?,'UTF8')))").use{q->q.setString(1,email);q.executeUpdate()}
            blocker.prepareStatement("DELETE FROM account_login_identities WHERE user_id=? AND provider='email'").use{q->q.setObject(1,a.id);q.executeUpdate()}
            blocker.commit()
            assertIs<AuthFailure>(attempt.await().exceptionOrNull())
        }
        assertNull(people.findSessionUserId(newSession))
    }

    @Test fun `consumed provider callback cannot recreate fresh proof after account capability reset`(): Unit=runBlocking {
        val a=account();val browser=tokens.issue().hash
        val inFlight=LoginFlow(tokens.issue().hash,browser,"vk","account",a.session,null,null,"pkce",null,null,"delete","current")
        auth.create(inFlight);val verified=auth.takeVk(inFlight.tokenHash,browser)
        prove(a,browser,"email");proveNewEmail(a,browser,"reset-${UUID.randomUUID()}@example.com")
        auth.changeEmail(a.session,browser,tokens.issue().hash)
        assertEquals(a.id,people.findSessionUserId(a.session))
        assertFailsWith<AuthFailure>{auth.recordAccountProof(verified,a.subject)}
        assertFalse(auth.lifecycle(a.session,browser).currentDelete)
    }

    @Test fun `delayed signup ticket cannot renew a verified flow after its identity was retired`(): Unit=runBlocking {
        val a=account();val browser=tokens.issue().hash;val subject=UUID.randomUUID().toString()
        val login=LoginFlow(tokens.issue().hash,browser,"vk","login",null,null,null,"pkce",null,null)
        auth.create(login);val verified=auth.takeVk(login.tokenHash,browser)
        assertEquals("AUTH_NOT_LINKED",assertFailsWith<AuthFailure>{auth.finish(verified,subject,tokens.issue().hash,365,"Unknown")}.code)
        execute("INSERT INTO account_identity_retirements(provider,subject_hash) VALUES ('vk',sha256(convert_to(?,'UTF8')))",subject)
        assertFailsWith<AuthFailure>{auth.prepareRegistration(verified,subject,tokens.issue().hash)}
        assertEquals("0",scalar("SELECT count(*) FROM account_registration_tickets WHERE subject=?",subject))
        assertEquals(a.id,people.findSessionUserId(a.session))
    }

    @Test fun `HTTP account callback is current session bound and delete enforces origin confirmation and replay key`() = testApplication {
        val session=tokens.issue();val subject=UUID.randomUUID().toString()
        val user=auth.finish(LoginFlow(tokens.issue().hash,tokens.issue().hash,"vk","register",null,"HTTP профиль",null,"pkce",null,null),subject,session.hash,365,"Browser")
        val config=AppConfig("unused","unused","unused",true,setOf("https://im-alive.ru"))
        application {
            installZhivApi(people,people,config,auth=auth,authConfig=AuthConfig(origin="https://im-alive.ru",vkClientId="123"),vk=VkVerifier{_,_,_,_->VerifiedVk(subject)})
        }
        val browser=createClient{followRedirects=false}
        val appCookie="${config.cookieName}=${session.raw}"
        suspend fun start()=browser.post("/api/v1/auth/vk/start") {
            contentType(ContentType.Application.Json);header(HttpHeaders.Origin,"https://im-alive.ru");header(HttpHeaders.Cookie,appCookie)
            setBody("""{"intent":"account","action":"delete","role":"current"}""")
        }
        val missingSession=start()
        val firstFlow=Json.parseToJsonElement(missingSession.bodyAsText()).jsonObject.getValue("flow").jsonPrimitive.content
        val firstBinder=missingSession.headers.getAll(HttpHeaders.SetCookie)!!.first{it.startsWith("__Host-zhiv_login=")}.substringBefore(';')
        assertEquals("/?auth=unauthorized",browser.get("/api/v1/auth/vk/callback?state=$firstFlow&code=ok&device_id=device"){header(HttpHeaders.Cookie,firstBinder)}.headers[HttpHeaders.Location])
        val begun=start()
        val flow=Json.parseToJsonElement(begun.bodyAsText()).jsonObject.getValue("flow").jsonPrimitive.content
        val binder=begun.headers.getAll(HttpHeaders.SetCookie)!!.first{it.startsWith("__Host-zhiv_login=")}.substringBefore(';')
        val cookies="$appCookie; $binder"
        val callback=browser.get("/api/v1/auth/vk/callback?state=$flow&code=ok&device_id=device"){header(HttpHeaders.Cookie,cookies)}
        assertEquals("/?auth=account-proof",callback.headers[HttpHeaders.Location])
        assertTrue(callback.headers.getAll(HttpHeaders.SetCookie).isNullOrEmpty())
        val state=browser.get("/api/v1/auth/account/lifecycle"){header(HttpHeaders.Cookie,cookies)}
        assertEquals("no-store",state.headers[HttpHeaders.CacheControl])
        assertTrue(Json.parseToJsonElement(state.bodyAsText()).jsonObject.getValue("currentDelete").jsonPrimitive.boolean)
        val key=UUID.randomUUID()
        suspend fun remove(origin: String="https://im-alive.ru",body: String="""{"confirm":true,"idempotencyKey":"$key"}""")=browser.delete("/api/v1/auth/account/profile") {
            contentType(ContentType.Application.Json);header(HttpHeaders.Origin,origin);header(HttpHeaders.Cookie,cookies);setBody(body)
        }
        assertEquals(HttpStatusCode.Forbidden,remove(origin="https://evil.example").status)
        assertEquals(HttpStatusCode.BadRequest,remove(body="""{"confirm":false,"idempotencyKey":"$key"}""").status)
        assertEquals(HttpStatusCode.BadRequest,remove(body="""{"confirm":true}""").status)
        assertEquals(user,people.findSessionUserId(session.hash))
        val deleted=remove()
        assertEquals(HttpStatusCode.OK,deleted.status)
        assertTrue(deleted.headers.getAll(HttpHeaders.SetCookie)!!.any{it.startsWith("${config.cookieName}=")&&"Max-Age=0" in it})
        assertNull(people.findSessionUserId(session.hash))
        assertEquals(HttpStatusCode.OK,remove().status)
    }

    @Test fun `legacy bootstrap rotation invalidates proof without foreign key failures`(): Unit=runBlocking {
        val session=tokens.issue().hash;val bootstrap=tokens.issue().hash;val browser=tokens.issue().hash
        val snapshot=people.bootstrap("Прежний профиль",bootstrap,session,365)
        val subject=UUID.randomUUID().toString()
        auth.finish(LoginFlow(tokens.issue().hash,browser,"vk","link",session,null,null,"pkce",null,null),subject,tokens.issue().hash,365,"Unused")
        val a=Account(snapshot.id,session,subject)
        prove(a,browser,"delete")
        val rotated=tokens.issue().hash
        assertEquals(a.id,people.bootstrap("Игнорируется",bootstrap,rotated,365).id)
        assertNull(people.findSessionUserId(session))
        assertFalse(auth.lifecycle(rotated,browser).currentDelete)
        assertFailsWith<AuthFailure>{auth.deleteAccount(rotated,browser,tokens.issue().hash)}
    }


    @Test fun `game merge keeps personal totals but max monthly score and never inherits public ranking`() = runBlocking<Unit> {
        val a=account("Game Current"); val b=account("Game Source"); val browser=tokens.issue().hash
        val game=JdbcGameRepository(source)
        val publicA=people.findBySession(a.session)!!.publicId; val publicB=people.findBySession(b.session)!!.publicId
        val playA=game.openSession(a.session,UUID.randomUUID(),publicA)
        val playB=game.openSession(b.session,UUID.randomUUID(),publicB)
        game.submitBatch(a.session,UUID.fromString(playA.sessionId),1,15,UUID.randomUUID())
        game.submitBatch(b.session,UUID.fromString(playB.sessionId),1,40,UUID.randomUUID())
        game.setVisibility(b.session,true,0,publicB)
        val key=readyMerge(a,b,browser)
        auth.confirmMerge(a.session,browser,key)
        val result=game.progress(a.session)
        assertEquals(55L,result.lifetimeTaps)
        assertEquals(40L,result.bestSeries)
        assertEquals(40L,result.monthlyTaps,"combining accounts must not farm monthly rankings")
        assertFalse(result.leaderboardOptIn,"source public visibility must not publish surviving profile")
        assertEquals("0",scalar("SELECT count(*) FROM game_profiles WHERE user_id=?",b.id))
        assertEquals("0",scalar("SELECT count(*) FROM game_monthly_scores WHERE user_id=?",b.id))
        assertEquals("0",scalar("SELECT count(*) FROM game_sessions WHERE user_id IN (?,?)",a.id,b.id))
        assertEquals("GAME_SESSION_GONE",assertFailsWith<AuthFailure> {
            game.submitBatch(a.session,UUID.fromString(playA.sessionId),2,1,UUID.randomUUID())
        }.code)
        auth.confirmMerge(a.session,browser,key)
        assertEquals(55L,game.progress(a.session).lifetimeTaps)
        prove(a,browser,"delete")
        auth.deleteAccount(a.session,browser,tokens.issue().hash)
        assertEquals("0",scalar("SELECT count(*) FROM game_profiles WHERE user_id=?",a.id))
        assertEquals("0",scalar("SELECT count(*) FROM game_monthly_scores WHERE user_id=?",a.id))
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure>{game.progress(a.session)}.code)
    }

    @Test fun `accepted game taps invalidate a pending account merge review`() = runBlocking<Unit> {
        val a=account();val b=account();val browser=tokens.issue().hash
        val game=JdbcGameRepository(source)
        val publicB=people.findBySession(b.session)!!.publicId
        val play=game.openSession(b.session,UUID.randomUUID(),publicB)
        val key=readyMerge(a,b,browser)
        game.submitBatch(b.session,UUID.fromString(play.sessionId),1,10,UUID.randomUUID())
        assertEquals("ACCOUNT_PREVIEW_STALE",assertFailsWith<AuthFailure>{auth.confirmMerge(a.session,browser,key)}.code)
        assertEquals(b.id,people.findSessionUserId(b.session))
    }

    @Test fun `merge unions achievements at earliest award time and deletion clears them`() = runBlocking<Unit> {
        val a=account(); val b=account(); val browser=tokens.issue().hash
        execute("INSERT INTO game_profiles(user_id,lifetime_taps) VALUES (?,700),(?,400)",a.id,b.id)
        execute("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'five_friends','2026-01-02T00:00:00Z'),(?,'five_friends','2026-01-01T00:00:00Z'),(?,'seven_day_streak','2026-01-03T00:00:00Z')",a.id,b.id,b.id)
        execute("INSERT INTO account_recovery_codes(user_id,code_hash,revoked_at) VALUES (?,?,clock_timestamp())",b.id,tokens.issue().hash)
        val preview=readyMerge(a,b,browser)
        auth.confirmMerge(a.session,browser,preview)
        val game=JdbcGameRepository(source)
        val awards=game.achievements(a.session).achievements
        assertTrue(awards.take(3).all { it.unlockedAt!=null })
        assertNotNull(awards.single { it.id=="saved_recovery_code" }.unlockedAt)
        assertEquals("2026-01-01T00:00:00Z",awards.single { it.id=="five_friends" }.unlockedAt)
        assertEquals("2026-01-03T00:00:00Z",awards.single { it.id=="seven_day_streak" }.unlockedAt)
        assertEquals(1000L,awards.single { it.id=="thousand_taps" }.progress,"merged verified lifetime totals may cross a new threshold")
        assertEquals("0",scalar("SELECT count(*) FROM game_achievements WHERE user_id=?",b.id))
        prove(a,browser,"delete"); auth.deleteAccount(a.session,browser,tokens.issue().hash)
        assertEquals("0",scalar("SELECT count(*) FROM game_achievements WHERE user_id IN (?,?)",a.id,b.id))
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure> { game.achievements(a.session) }.code)
    }

    @Test fun `item grants invalidate merge review and inventory survives union and deletion`() = runBlocking<Unit> {
        val a=account();val b=account();val browser=tokens.issue().hash
        val stale=readyMerge(a,b,browser)
        execute("INSERT INTO game_items(user_id,item_id,unlocked_at) VALUES (?,'leaf_garland','2026-01-02T00:00:00Z')",b.id)
        assertEquals("ACCOUNT_PREVIEW_STALE",assertFailsWith<AuthFailure> { auth.confirmMerge(a.session,browser,stale) }.code)
        execute("INSERT INTO game_items(user_id,item_id,unlocked_at) VALUES (?,'leaf_garland','2026-01-03T00:00:00Z'),(?,'flower','2026-01-01T00:00:00Z')",a.id,b.id)
        val preview=readyMerge(a,b,browser);auth.confirmMerge(a.session,browser,preview)
        assertEquals(setOf("flower","leaf_garland"),JdbcGameRepository(source).progress(a.session).items.toSet())
        assertTrue(flag("SELECT unlocked_at='2026-01-02T00:00:00Z'::timestamptz FROM game_items WHERE user_id=? AND item_id='leaf_garland'",a.id))
        assertEquals("0",scalar("SELECT count(*) FROM game_items WHERE user_id=?",b.id))
        prove(a,browser,"delete");auth.deleteAccount(a.session,browser,tokens.issue().hash)
        assertEquals("0",scalar("SELECT count(*) FROM game_items WHERE user_id IN (?,?)",a.id,b.id))
    }

    @Test fun `world merge retains trips possessions and colliding ledger keys then deletion clears data`() = runBlocking<Unit> {
        val a=account();val b=account();val browser=tokens.issue().hash;val world=JdbcWorldRepository(source)
        world.snapshot(a.session);world.snapshot(b.session)
        val finds=WorldRules.catalog.finds.map { it.id }
        execute("UPDATE world_profiles SET state=?::jsonb,tap_sparks=20 WHERE user_id=?",
            worldJson.encodeToString(WorldState(resources=WorldResources(20,8,4),collection=finds.take(3),equipment=WorldEquipment(neck="amber_scarf"))),a.id)
        execute("UPDATE world_profiles SET state=?::jsonb,tap_sparks=50 WHERE user_id=?",
            worldJson.encodeToString(WorldState(resources=WorldResources(50,20,10),houseLevel=2,workshop=true,collection=finds.drop(3))),b.id)
        val sharedKey=UUID.randomUUID().toString()
        suspend fun upgrade(account: Account) {
            val snapshot=world.snapshot(account.session)
            world.command(account.session,WorldCommand(sharedKey,snapshot.ownerPublicId,snapshot.revision,"upgrade_house"))
        }
        suspend fun travel(account: Account): WorldJourney {
            val snapshot=world.snapshot(account.session)
            return world.command(account.session,WorldCommand(UUID.randomUUID().toString(),snapshot.ownerPublicId,snapshot.revision,"start_journey","first_path")).snapshot.state.journeys.single()
        }
        upgrade(a);upgrade(b);val tripA=travel(a)
        val stale=readyMerge(a,b,browser);val tripB=travel(b)
        assertEquals("ACCOUNT_PREVIEW_STALE",assertFailsWith<AuthFailure> { auth.confirmMerge(a.session,browser,stale) }.code)
        val key=readyMerge(a,b,browser);auth.confirmMerge(a.session,browser,key)
        val merged=JdbcWorldRepository(source).snapshot(a.session)
        assertEquals(WorldResources(25,4,4),merged.state.resources);assertEquals(3,merged.state.houseLevel);assertTrue(merged.state.workshop)
        assertEquals("amber_scarf",merged.state.equipment.neck);assertEquals(finds.toSet(),merged.state.collection.toSet())
        assertTrue("explorer_cap" in merged.state.inventory)
        assertEquals(setOf(tripA.id,tripB.id),merged.state.journeys.map { it.id }.toSet());assertEquals(60,merged.dailySparksEarned)
        assertEquals("2",scalar("SELECT count(*) FROM world_ledger WHERE user_id=? AND kind='upgrade_house'",a.id))
        auth.confirmMerge(a.session,browser,key);assertEquals(merged.state,world.snapshot(a.session).state)
        for(table in listOf("world_profiles","world_commands","world_ledger")) assertEquals("0",scalar("SELECT count(*) FROM $table WHERE user_id=?",b.id))
        prove(a,browser,"delete");auth.deleteAccount(a.session,browser,tokens.issue().hash)
        for(table in listOf("world_profiles","world_commands","world_ledger")) assertEquals("0",scalar("SELECT count(*) FROM $table WHERE user_id IN (?,?)",a.id,b.id))
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure> { world.snapshot(a.session) }.code)
    }

}
