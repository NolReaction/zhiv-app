package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import ru.zhiv.world.*
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcWorldRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var games: JdbcGameRepository
    private lateinit var world: JdbcWorldRepository
    private lateinit var config: AppConfig
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)
    @BeforeAll fun setup() {
        config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        source=DatabaseFactory.create(config); DatabaseFactory.migrate(source)
        identities=JdbcZhivRepository(source); games=JdbcGameRepository(source); world=JdbcWorldRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private fun execute(sql: String,vararg values: Any?) = source.connection.use { c ->
        c.prepareStatement(sql).use { s -> values.forEachIndexed { i,v -> s.setObject(i+1,v) }; s.executeUpdate() }.also { c.commit() }
    }
    private fun scalar(sql: String,vararg values: Any?): String = source.connection.use { c ->
        c.prepareStatement(sql).use { s -> values.forEachIndexed { i,v -> s.setObject(i+1,v) }; s.executeQuery().use { it.next(); it.getString(1) } }
    }
    private suspend fun player(): Player {
        val token=tokens.issue(); val user=identities.bootstrap("Мохлик",tokens.issue().hash,token.hash,365)
        return Player(user.id,user.publicId,token.hash,token.raw)
    }
    private fun secondDevice(player: Player): ByteArray {
        val token=tokens.issue();execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')",player.id,token.hash)
        return token.hash
    }
    @Test fun `journey commands survive restart and concurrent devices cannot double claim`() = runBlocking<Unit> {
        val p=player(); val initial=world.snapshot(p.hash)
        assertEquals(WorldResources(),initial.state.resources)
        val upgrade=WorldCommand(UUID.randomUUID().toString(),p.publicId,initial.revision,"upgrade_house")
        assertEquals("WORLD_RESOURCES",assertFailsWith<AuthFailure> { world.command(p.hash,upgrade) }.code)
        val start=upgrade.copy(requestId=UUID.randomUUID().toString(),action="start_journey",target="first_path")
        val started=world.command(p.hash,start);val journey=started.snapshot.state.journeys.single()
        assertEquals(WorldResources(12,8,4),journey.rewards)
        assertTrue(world.command(p.hash,start).replayed)
        assertEquals("WORLD_COMMAND_CONFLICT",assertFailsWith<AuthFailure> { world.command(p.hash,start.copy(target="forest_path")) }.code)
        val claim=start.copy(requestId=UUID.randomUUID().toString(),expectedRevision=started.snapshot.revision,action="claim_journey",target=journey.id)
        assertEquals("WORLD_JOURNEY_NOT_READY",assertFailsWith<AuthFailure> { world.command(p.hash,claim) }.code)
        execute("""UPDATE world_profiles SET state=jsonb_set(jsonb_set(state,'{journeys,0,startedAt}','"2000-01-01T00:00:00Z"'),
            '{journeys,0,finishesAt}','"2000-01-01T00:01:00Z"') WHERE user_id=?""",p.id)
        val other=secondDevice(p); val commands=listOf(claim,claim.copy(requestId=UUID.randomUUID().toString()))
        val results=coroutineScope { commands.mapIndexed { i,c -> async(Dispatchers.IO) { runCatching { JdbcWorldRepository(source).command(if(i==0)p.hash else other,c) } } }.awaitAll() }
        assertEquals(1,results.count { it.isSuccess })
        assertEquals("WORLD_REVISION_CONFLICT",(results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        assertTrue(world.command(other,commands[results.indexOfFirst { it.isSuccess }]).replayed)
        val rewarded=JdbcWorldRepository(source).snapshot(other)
        assertEquals(WorldResources(12,8,4),rewarded.state.resources);assertEquals(listOf("acorn"),rewarded.state.collection)
        assertTrue(rewarded.state.journeys.isEmpty());assertEquals("1",scalar("SELECT count(*) FROM world_ledger WHERE user_id=? AND kind='claim_journey'",p.id))
        assertEquals("WORLD_JOURNEY_GONE",assertFailsWith<AuthFailure> { world.command(p.hash,claim.copy(requestId=UUID.randomUUID().toString(),expectedRevision=rewarded.revision)) }.code)
        val build=upgrade.copy(expectedRevision=rewarded.revision)
        val built=world.command(p.hash,build);assertEquals(2,built.snapshot.state.houseLevel);assertEquals(WorldResources(2,2,2),built.snapshot.state.resources)
        assertTrue(world.command(other,build).replayed)
        assertEquals(built.snapshot.state,JdbcWorldRepository(source).snapshot(p.hash).state)
        assertEquals(0L,identities.findBySession(p.hash)!!.checkInCount)
    }
    @Test fun `only new accepted taps earn sparks with an account wide UTC cap`() = runBlocking<Unit> {
        val p=player(); val id=UUID.fromString(games.openSession(p.hash,UUID.randomUUID(),p.publicId).sessionId)
        games.submitBatch(p.hash,id,1,5,UUID.randomUUID())
        assertEquals(0L,world.snapshot(p.hash).state.resources.sparks)
        val other=secondDevice(p)
        var a=2L
        repeat(6) {
            execute("UPDATE game_profiles SET bucket_tokens=60,bucket_updated_at=clock_timestamp()+interval '1 minute' WHERE user_id=?",p.id)
            val hash=p.hash;val sid=id;val seq=a++;val run=UUID.randomUUID()
            assertEquals(60,games.submitBatch(hash,sid,seq,60,run).acceptedTaps)
            val before=world.snapshot(hash).state.resources
            assertTrue(games.submitBatch(hash,sid,seq,60,run).replayed);assertEquals(before,world.snapshot(hash).state.resources)
        }
        assertEquals(60,world.snapshot(other).dailySparksEarned);assertEquals(60L,world.snapshot(p.hash).state.resources.sparks)
        assertEquals("60",scalar("SELECT sum(sparks) FROM world_ledger WHERE user_id=? AND kind='taps'",p.id))
        assertEquals(365L,games.progress(p.hash).lifetimeTaps)
        identities.updateTimeZone(p.hash,"Pacific/Kiritimati",UUID.randomUUID());assertEquals(60,world.snapshot(p.hash).dailySparksEarned)
        execute("UPDATE world_profiles SET tap_day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1 WHERE user_id=?",p.id)
        execute("UPDATE game_profiles SET bucket_tokens=60,bucket_updated_at=clock_timestamp()+interval '1 minute' WHERE user_id=?",p.id)
        games.submitBatch(p.hash,id,a,60,UUID.randomUUID());assertEquals(12,world.snapshot(other).dailySparksEarned)
        assertEquals(72L,JdbcWorldRepository(source).snapshot(p.hash).state.resources.sparks)
    }
    @Test fun `world HTTP boundary checks authentication origin and command validation`() = testApplication {
        application { installZhivApi(identities,identities,config,tokens,worlds=world) }
        val p=player()
        assertEquals(HttpStatusCode.Unauthorized,client.get("/api/v1/world").status)
        val get=client.get("/api/v1/world") { cookie(config.cookieName,p.raw) }
        assertEquals(HttpStatusCode.OK,get.status);assertEquals("no-store",get.headers[HttpHeaders.CacheControl])
        val snapshot=world.snapshot(p.hash)
        val command=WorldCommand(UUID.randomUUID().toString(),p.publicId,snapshot.revision,"equip","amber_scarf")
        suspend fun post(body: String,origin: String="http://localhost") = client.post("/api/v1/world/commands") {
            cookie(config.cookieName,p.raw);header(HttpHeaders.Origin,origin);contentType(ContentType.Application.Json);setBody(body)
        }
        assertEquals(HttpStatusCode.Forbidden,post(worldJson.encodeToString(command),"https://foreign.example").status)
        assertEquals(HttpStatusCode.BadRequest,post(worldJson.encodeToString(command.copy(requestId="wrong"))).status)
        assertEquals(HttpStatusCode.Conflict,post(worldJson.encodeToString(command.copy(ownerPublicId="XXXX-XXXX-XXXX"))).status)
        assertEquals(HttpStatusCode.OK,post(worldJson.encodeToString(command)).status)
        assertEquals("amber_scarf",world.snapshot(p.hash).state.equipment.neck)
    }
    @Test
    fun `fishing modes persist full durations and credit only confirmed returns`() = runBlocking<Unit> {
        val modes = listOf(
            Triple("fishing_5", 300L, WorldResources(4, 2, 2)),
            Triple("fishing_15", 900L, WorldResources(9, 5, 5)),
            Triple("fishing_30", 1800L, WorldResources(14, 8, 8)),
            Triple("fishing_60", 3600L, WorldResources(24, 14, 14)),
        )
        assertEquals(2, WorldRules.catalog.version)
        for ((routeId, seconds, rewards) in modes) {
            val p = player()
            val initial = world.snapshot(p.hash)
            val start = WorldCommand(UUID.randomUUID().toString(), p.publicId, initial.revision, "start_journey", routeId)
            assertEquals("WORLD_HOUSE_REQUIRED", assertFailsWith<AuthFailure> { world.command(p.hash, start) }.code)
            execute("UPDATE world_profiles SET state=?::jsonb WHERE user_id=?", worldJson.encodeToString(initial.state.copy(houseLevel = 2)), p.id)
            val started = world.command(p.hash, start)
            val journey = started.snapshot.state.journeys.single()
            assertEquals(routeId, journey.routeId)
            assertEquals(2, journey.catalogVersion)
            assertEquals(2, started.snapshot.catalogVersion)
            assertEquals(rewards, journey.rewards)
            assertEquals(listOf("river_stone", "moon_moth"), journey.finds)
            assertEquals(Duration.ofSeconds(seconds), Duration.between(Instant.parse(journey.startedAt), Instant.parse(journey.finishesAt)))
            assertTrue(world.command(p.hash, start).replayed)
            assertEquals(journey, JdbcWorldRepository(source).snapshot(p.hash).state.journeys.single())
            val claim = start.copy(requestId = UUID.randomUUID().toString(), expectedRevision = started.snapshot.revision, action = "claim_journey", target = journey.id)
            assertEquals("WORLD_JOURNEY_NOT_READY", assertFailsWith<AuthFailure> { world.command(p.hash, claim) }.code)
            assertEquals(WorldResources(), world.snapshot(p.hash).state.resources)
            assertEquals("0", scalar("SELECT count(*) FROM world_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(claim.requestId)))
            // Advance the saved trip, without sleeping or changing production clocks.
            val completed = journey.copy(startedAt = "2000-01-01T00:00:00Z", finishesAt = Instant.parse("2000-01-01T00:00:00Z").plusSeconds(seconds).toString())
            execute("UPDATE world_profiles SET state=?::jsonb WHERE user_id=?", worldJson.encodeToString(started.snapshot.state.copy(journeys = listOf(completed))), p.id)
            val other = secondDevice(p)
            val returned = JdbcWorldRepository(source).snapshot(other)
            assertEquals(WorldResources(), returned.state.resources)
            assertEquals(completed, returned.state.journeys.single())
            assertEquals(started.snapshot.revision, returned.revision)
            val paid = JdbcWorldRepository(source).command(other, claim)
            assertFalse(paid.replayed)
            assertEquals(rewards, paid.snapshot.state.resources)
            assertEquals(listOf("river_stone"), paid.snapshot.state.collection)
            assertEquals(1L, paid.snapshot.state.completedJourneys)
            assertTrue(paid.snapshot.state.journeys.isEmpty())
            assertTrue(world.command(p.hash, claim).replayed)
            assertEquals(paid.snapshot.state, world.snapshot(p.hash).state)
            assertEquals("1", scalar("SELECT count(*) FROM world_ledger WHERE user_id=? AND source_key=?", p.id, "journey:${journey.id}"))
        }
    }

    @Test
    fun `saved catalog one brook trips remain claimable after retiring the route`() = runBlocking<Unit> {
        assertTrue(WorldRules.catalog.routes.none { it.id == "brook_path" })
        val p = player()
        val initial = world.snapshot(p.hash)
        val legacy = WorldJourney(UUID.randomUUID().toString(), "brook_path", "2000-01-01T00:00:00Z", "2000-01-01T00:30:00Z", WorldResources(14, 8, 8), listOf("river_stone", "moon_moth"), false, 1)
        val saved = initial.state.copy(houseLevel = 2, resources = WorldResources(3, 4, 5), collection = listOf("river_stone"), firstJourneyCompleted = true, completedJourneys = 7, journeys = listOf(legacy))
        execute("UPDATE world_profiles SET state=?::jsonb WHERE user_id=?", worldJson.encodeToString(saved), p.id)
        val restored = JdbcWorldRepository(source).snapshot(p.hash)
        assertEquals(2, restored.catalogVersion)
        assertEquals(1, restored.state.journeys.single().catalogVersion)
        assertEquals(saved, restored.state)
        val claim = WorldCommand(UUID.randomUUID().toString(), p.publicId, restored.revision, "claim_journey", legacy.id)
        val paid = world.command(p.hash, claim)
        assertEquals(WorldResources(17, 12, 13), paid.snapshot.state.resources)
        assertEquals(listOf("moon_moth", "river_stone"), paid.snapshot.state.collection)
        assertEquals(8L, paid.snapshot.state.completedJourneys)
        assertTrue(paid.snapshot.state.firstJourneyCompleted)
        assertTrue(paid.snapshot.state.journeys.isEmpty())
        assertTrue(world.command(secondDevice(p), claim).replayed)
        assertEquals("1", scalar("SELECT count(*) FROM world_ledger WHERE user_id=? AND source_key=?", p.id, "journey:${legacy.id}"))
        assertEquals("WORLD_ROUTE", assertFailsWith<AuthFailure> {
            world.command(p.hash, claim.copy(requestId = UUID.randomUUID().toString(), expectedRevision = paid.snapshot.revision, action = "start_journey", target = "brook_path"))
        }.code)
    }
}
