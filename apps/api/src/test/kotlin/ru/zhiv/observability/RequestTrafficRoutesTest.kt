package ru.zhiv.observability

import io.ktor.client.request.cookie
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.*
import ru.zhiv.admin.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.checkins.CheckInRepository
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.checkins.DailyStreakSnapshot
import ru.zhiv.config.AppConfig
import ru.zhiv.identity.DisplayNameUpdateResult
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.UserSnapshot
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.*

/** Real Ktor middleware and production route, with no network or database. */
class RequestTrafficRoutesTest {
    private val config=AppConfig("unused","unused","unused",true,setOf("https://im-alive.ru"))
    private val path="/api/v1/admin/request-traffic"

    private class Repository : IdentityRepository, CheckInRepository, AdminRepository {
        val adminId=UUID.randomUUID()
        val playerId=UUID.randomUUID()
        val publicAdmin="7K3P-2Q9M-W8ZR"
        val publicPlayer="SJ8G-GC1H-A7AX"
        private val codec=TokenCodec()
        private val adminHash=codec.hash("admin-session")
        private val playerHash=codec.hash("player-session")
        var acceptedAccesses=0
        var lookups=0
        var requestedIds=emptyList<UUID>()
        var secondAccess: (() -> AdminAccess)? = null
        override suspend fun findSessionUserId(sessionTokenHash: ByteArray): UUID? = when {
            sessionTokenHash.contentEquals(adminHash) -> adminId
            sessionTokenHash.contentEquals(playerHash) -> playerId
            else -> null
        }
        override suspend fun findBySession(sessionTokenHash: ByteArray): UserSnapshot? {
            val id=findSessionUserId(sessionTokenHash) ?: return null
            return UserSnapshot(id,if(id==adminId) publicAdmin else publicPlayer,"Игрок",null,0,
                DailyStreakSnapshot(0,0,false,null),null,null,OffsetDateTime.now())
        }
        override suspend fun access(sessionHash: ByteArray): AdminAccess {
            if(sessionHash.contentEquals(playerHash)) throw AuthFailure("FORBIDDEN","Нет доступа",403)
            if(!sessionHash.contentEquals(adminHash)) throw AuthFailure("UNAUTHORIZED","Нет сессии",401)
            acceptedAccesses++
            if(acceptedAccesses==2) secondAccess?.let { return it() }
            return AdminAccess(publicAdmin,"Администратор","2026-10-18T00:00:00Z")
        }
        override suspend fun trafficPlayers(sessionHash: ByteArray,ids: List<UUID>): List<TrafficPlayer> {
            assertTrue(sessionHash.contentEquals(adminHash)); assertTrue(ids.size<=100)
            lookups++; requestedIds=ids
            return ids.filter { it==playerId }.map { TrafficPlayer(it,publicPlayer,"Игрок") }
        }
        override suspend fun bootstrap(displayName: String,bootstrapKeyHash: ByteArray,sessionTokenHash: ByteArray,
            sessionLifetimeDays: Long,timeZone: String): UserSnapshot = error("Unexpected write")
        override suspend fun updateDisplayName(sessionTokenHash: ByteArray,displayName: String,idempotencyKey: UUID): DisplayNameUpdateResult = error("Unexpected write")
        override suspend fun record(sessionTokenHash: ByteArray,idempotencyKey: UUID): CheckInResult = error("Unexpected write")
        override suspend fun rewards(sessionHash: ByteArray,targetPublicId: String): AdminRewards = error("Unexpected read")
        override suspend fun grantReward(sessionHash: ByteArray,targetPublicId: String,requestId: UUID,request: AdminGrantRequest): AdminGrantReceipt = error("Unexpected write")
        override suspend fun overview(sessionHash: ByteArray,days: Int): AdminOverview = error("Unexpected read")
        override suspend fun users(sessionHash: ByteArray,query: String,sort: String,offset: Int,limit: Int): AdminUsers = error("Unexpected read")
        override suspend fun revokeSessions(sessionHash: ByteArray,targetPublicId: String,requestId: UUID,confirmationPublicId: String,reason: String): AdminRevokeReceipt = error("Unexpected write")
        override suspend fun audit(sessionHash: ByteArray,offset: Int,limit: Int): AdminAudit = error("Unexpected read")
    }

    @Test fun `traffic requires a current administrator and rejects forged identity and query selectors`()=testApplication {
        val repository=Repository()
        application { installZhivApi(repository,repository,config,admin=repository) }
        assertEquals(HttpStatusCode.Unauthorized,client.get(path).status)
        assertEquals(HttpStatusCode.Unauthorized,client.get(path) {
            cookie(config.cookieName,"forged-session"); header("X-User-ID",repository.publicAdmin)
        }.status)
        assertEquals(HttpStatusCode.Forbidden,client.get(path) { cookie(config.cookieName,"player-session") }.status)
        assertEquals(0,repository.lookups)
        val response=client.get(path) { cookie(config.cookieName,"admin-session") }
        assertEquals(HttpStatusCode.OK,response.status)
        assertEquals("no-store",response.headers[HttpHeaders.CacheControl])
        assertEquals("noindex, nofollow",response.headers["X-Robots-Tag"])
        val body=Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals(repository.publicAdmin,body.getValue("actorPublicId").jsonPrimitive.content)
        assertTrue(body.getValue("signals").jsonArray.isEmpty())
        assertEquals(HttpStatusCode.BadRequest,client.get("$path?publicId=${repository.publicPlayer}") {
            cookie(config.cookieName,"admin-session")
        }.status)
        assertEquals(0,repository.lookups)
    }

    @Test fun `traffic attributes only verified sessions and leaves forged cookies anonymous`()=testApplication {
        val repository=Repository()
        application { installZhivApi(repository,repository,config,admin=repository) }
        // Forty requests also span a possible minute boundary without making
        // the diagnostic-threshold test depend on the wall clock's exact second.
        repeat(40) {
            assertEquals(HttpStatusCode.Forbidden,client.get(path) {
                cookie(config.cookieName,"player-session"); header("X-User-ID",repository.publicAdmin)
            }.status)
            assertEquals(HttpStatusCode.Unauthorized,client.get(path) {
                cookie(config.cookieName,"forged-$it"); header("X-User-ID",repository.publicPlayer)
            }.status)
        }
        val response=client.get(path) { cookie(config.cookieName,"admin-session") }
        assertEquals(HttpStatusCode.OK,response.status)
        val text=response.bodyAsText()
        val signals=Json.parseToJsonElement(text).jsonObject.getValue("signals").jsonArray.map { it.jsonObject }
        assertEquals(2,signals.size)
        val identified=signals.single { it["publicId"]!=JsonNull }
        assertEquals(repository.publicPlayer,identified.getValue("publicId").jsonPrimitive.content)
        assertEquals("Игрок",identified.getValue("displayName").jsonPrimitive.content)
        assertTrue(identified.getValue("denied").jsonPrimitive.int>=20)
        assertEquals(path,identified.getValue("operation").jsonPrimitive.content)
        assertEquals(JsonNull,signals.single { it["publicId"]==JsonNull }.getValue("displayName"))
        assertEquals(listOf(repository.playerId),repository.requestedIds)
        assertEquals(1,repository.lookups)
        assertFalse(text.contains(repository.playerId.toString()))
        assertFalse(text.contains("player-session")); assertFalse(text.contains("forged-"))
    }

    @Test fun `revoked access during the read cannot return a private snapshot`()=testApplication {
        val repository=Repository().apply { secondAccess={ throw AuthFailure("UNAUTHORIZED","Сессия отозвана",401) } }
        application { installZhivApi(repository,repository,config,admin=repository) }
        val response=client.get(path) { cookie(config.cookieName,"admin-session") }
        assertEquals(HttpStatusCode.Unauthorized,response.status)
        assertFalse(response.bodyAsText().contains("signals"))
        assertEquals(2,repository.acceptedAccesses)
    }

    @Test fun `a changed administrator during the read cannot receive another actor snapshot`()=testApplication {
        val repository=Repository().apply { secondAccess={ AdminAccess(publicPlayer,"Другой администратор","2026-10-18T00:00:00Z") } }
        application { installZhivApi(repository,repository,config,admin=repository) }
        val response=client.get(path) { cookie(config.cookieName,"admin-session") }
        assertEquals(HttpStatusCode.Forbidden,response.status)
        assertFalse(response.bodyAsText().contains("signals"))
        assertEquals(2,repository.acceptedAccesses)
    }
}
