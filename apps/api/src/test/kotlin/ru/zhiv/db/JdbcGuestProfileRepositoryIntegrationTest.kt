package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.installZhivApi
import ru.zhiv.relationships.*
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcGuestProfileRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var config: AppConfig
    private lateinit var identities: JdbcZhivRepository
    private lateinit var relationships: JdbcRelationshipRepository
    private lateinit var profiles: JdbcGuestProfileRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)
    @BeforeAll fun setup() {
        config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        source=DatabaseFactory.create(config);DatabaseFactory.migrate(source)
        identities=JdbcZhivRepository(source);relationships=JdbcRelationshipRepository(source);profiles=JdbcGuestProfileRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private suspend fun player(): Player {
        val token=tokens.issue();val user=identities.bootstrap("Лесник",tokens.issue().hash,token.hash,365)
        return Player(user.id,user.publicId,token.hash,token.raw)
    }
    private fun <T> ok(value: RelationshipResult<T>): T = assertIs<RelationshipResult.Success<T>>(value).value
    private suspend fun connect(a: Player,b: Player): UUID {
        val request=ok(relationships.sendRequest(a.hash,b.publicId,UUID.randomUUID())).request
        return ok(relationships.actOnRequest(b.hash,request.requestId,RequestAction.ACCEPTED)).person!!.circleId
    }
    private fun execute(sql: String,vararg values: Any?) = source.connection.use { c -> c.economyUpdate(sql,*values).also { c.commit() } }
    private fun count(table: String,player: Player): Long = source.connection.use { c ->
        c.economyRows("SELECT count(*) FROM $table WHERE user_id=?",player.id){it.getLong(1)}.single()
    }
    private suspend fun unavailable(viewer: Player,circle: UUID) {
        val failure=assertFailsWith<AuthFailure>{profiles.profile(viewer.hash,circle)}
        assertEquals("GUEST_PROFILE_UNAVAILABLE",failure.code);assertEquals(404,failure.status)
    }

    @Test fun `guest read does not initialize gameplay profiles or grant awards`() = runBlocking<Unit> {
        val a=player();val b=player();val circle=connect(a,b)
        val tables=listOf("economy_profiles","world_profiles","game_profiles","game_achievements","game_achievement_tiers","economy_ledger")
        val before=tables.associateWith { count(it,b) }
        val result=profiles.profile(a.hash,circle)
        assertEquals(a.publicId,result.ownerPublicId);assertEquals(b.publicId,result.user.publicId);assertEquals(circle.toString(),result.circleId)
        assertEquals(1,result.homeLevel);assertEquals(0L,result.completedExplorations)
        assertTrue(result.achievements.isEmpty());assertEquals(GuestCollections(emptyList(),emptyList(),emptyList()),result.collections)
        assertEquals(before,tables.associateWith { count(it,b) })
    }

    @Test fun `projection allowlists discoveries and earned world achievements while withholding private data`() = runBlocking<Unit> {
        val a=player();val b=player();val circle=connect(a,b);val fish=GuestProfileRules.fishIds.first()
        val state=EconomyRules.initial().copy(buildings=mapOf("home" to 3),wallet=EconomyWallet(789,12),inventory=mapOf("wood" to 87L),
            completedExplorations=12,fishing=EconomyFishing(catches=mapOf(fish to 4L,"unknown" to 99L)),
            progression=EconomyProgression(collections=EconomyBookCollection(listOf("acorn","acorn","quartz_cluster","unknown"),123,456)))
        execute("INSERT INTO economy_profiles(user_id,state) VALUES (?,?::jsonb)",b.id,economyJson.encodeToString(state))
        for(id in listOf("home_builder","linked_email","saved_recovery_code","seven_day_streak","five_friends","thousand_taps"))
            execute("INSERT INTO game_achievements(user_id,achievement_id) VALUES (?,?)",b.id,id)
        for(level in 1..2) execute("INSERT INTO game_achievement_tiers(user_id,achievement_id,level) VALUES (?,'home_builder',?)",b.id,level)
        val before=source.connection.use { c -> c.economyRows("SELECT state::text FROM economy_profiles WHERE user_id=?",b.id){it.getString(1)}.single() }
        val result=profiles.profile(a.hash,circle)
        assertEquals(3,result.homeLevel);assertEquals(12L,result.completedExplorations)
        assertEquals(listOf(GuestAchievement("home_builder",2)),result.achievements)
        assertEquals(GuestCollections(listOf("acorn"),listOf(fish),listOf("quartz_cluster")),result.collections)
        val json=Json.parseToJsonElement(Json.encodeToString(result)).jsonObject
        assertEquals(setOf("ownerPublicId","circleId","user","homeLevel","completedExplorations","achievements","collections","serverTime"),json.keys)
        assertEquals(setOf("publicId","displayName"),json.getValue("user").jsonObject.keys)
        for(secret in listOf("wallet","inventory","jobs","rareDropState","fishingCastSeed","travelSeconds","quarrySeconds","linked_email","unlockedAt","status","email","tap"))
            assertFalse(Json.encodeToString(result).contains(secret),secret)
        assertEquals(before,source.connection.use { c -> c.economyRows("SELECT state::text FROM economy_profiles WHERE user_id=?",b.id){it.getString(1)}.single() })
    }

    @Test fun `strangers deleted circles and outgoing denies have the same unavailable response`() = runBlocking<Unit> {
        val a=player();val b=player();val stranger=player();val circle=connect(a,b)
        unavailable(stranger,circle);unavailable(a,UUID.randomUUID())
        // Viewer's outgoing OFF is not the subject's consent; direction matters.
        ok(relationships.updateSharing(a.hash,circle,SharingMode.OFF))
        assertEquals(b.publicId,profiles.profile(a.hash,circle).user.publicId)
        unavailable(b,circle)
        ok(relationships.updateSharing(b.hash,circle,SharingMode.OFF));unavailable(a,circle)
        ok(relationships.updateSharing(b.hash,circle,SharingMode.LATEST_ONLY));profiles.profile(a.hash,circle)
        ok(relationships.removePerson(a.hash,circle));unavailable(a,circle)
    }

    @Test fun `recipient privacy override bans and session revocation cannot be bypassed through profile`() = runBlocking<Unit> {
        val a=player();val b=player();val circle=connect(a,b)
        execute("INSERT INTO recipient_sharing_preferences(actor_user_id,recipient_user_id,sharing_mode) VALUES (?,?,'OFF')",b.id,a.id)
        unavailable(a,circle)
        ok(relationships.updateSharing(b.hash,circle,SharingMode.LATEST_ONLY));profiles.profile(a.hash,circle)
        execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Integration test moderation ban' WHERE id=?",b.id);unavailable(a,circle)
        execute("UPDATE app_users SET banned_at=NULL,ban_reason=NULL WHERE id=?",b.id)
        assertEquals(b.publicId,profiles.profile(a.hash,circle).user.publicId)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE user_id=?",a.id)
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure>{profiles.profile(a.hash,circle)}.code)
    }

    @Test fun `HTTP profile authenticates returns no store and rejects extra scope parameters`() = testApplication {
        application { installZhivApi(identities,identities,config,tokens,guestProfiles=profiles) }
        val a=player();val b=player();val circle=connect(a,b);val path="/api/v1/people/$circle/game-profile"
        assertEquals(HttpStatusCode.Unauthorized,client.get(path).status)
        val response=client.get(path){cookie(config.cookieName,a.raw)}
        assertEquals(HttpStatusCode.OK,response.status);assertEquals("no-store",response.headers[HttpHeaders.CacheControl])
        assertEquals(b.publicId,Json.parseToJsonElement(response.bodyAsText()).jsonObject.getValue("user").jsonObject.getValue("publicId").jsonPrimitive.content)
        for(query in listOf("owner=${b.publicId}","include=inventory","glade=true"))
            assertEquals(HttpStatusCode.BadRequest,client.get("$path?$query"){cookie(config.cookieName,a.raw)}.status)
        assertEquals(HttpStatusCode.BadRequest,client.get("/api/v1/people/not-a-uuid/game-profile"){cookie(config.cookieName,a.raw)}.status)
        ok(relationships.updateSharing(b.hash,circle,SharingMode.OFF))
        val denied=client.get(path){cookie(config.cookieName,a.raw)}
        assertEquals(HttpStatusCode.NotFound,denied.status);assertEquals("no-store",denied.headers[HttpHeaders.CacheControl])
    }
}
