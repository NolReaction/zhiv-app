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
import ru.zhiv.economy.*
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
    @Test fun `gift switches persist across devices and retries without removing ownership`() = runBlocking<Unit> {
        val p = player(); val initial = world.snapshot(p.hash)
        val hide = WorldCommand(UUID.randomUUID().toString(), p.publicId, initial.revision, "set_decoration", "hide_flower")
        assertEquals("WORLD_ITEM_NOT_OWNED", assertFailsWith<AuthFailure> { world.command(p.hash, hide) }.code)
        execute("INSERT INTO game_items(user_id,item_id) VALUES (?,?)", p.id, "flower")
        val hidden = world.command(p.hash, hide)
        assertEquals(listOf("flower"), hidden.snapshot.state.hiddenGifts)
        assertTrue("flower" in hidden.snapshot.gifts)
        assertEquals(initial.state.resources, hidden.snapshot.state.resources)
        val other = secondDevice(p)
        assertEquals(hidden.snapshot.state, JdbcWorldRepository(source).snapshot(other).state)
        assertTrue(world.command(other, hide).replayed)
        val show = hide.copy(requestId = UUID.randomUUID().toString(), target = "show_flower")
        assertEquals("WORLD_REVISION_CONFLICT", assertFailsWith<AuthFailure> { world.command(other, show) }.code)
        assertEquals(emptyList(), world.command(other, show.copy(expectedRevision = hidden.snapshot.revision)).snapshot.state.hiddenGifts)
    }
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
    @Test fun `old journeys convert once while legacy spending and new journeys are retired`() = runBlocking<Unit> {
        val p=player()
        val journey=WorldJourney(UUID.randomUUID().toString(),"first_path","2000-01-01T00:00:00Z","2000-01-01T00:01:00Z",WorldResources(12,8,4),listOf("acorn"),true,3)
        execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)",p.id,worldJson.encodeToString(WorldState(journeys=listOf(journey))))
        val initial=world.snapshot(p.hash)
        val upgrade=WorldCommand(UUID.randomUUID().toString(),p.publicId,initial.revision,"upgrade_house")
        for(action in listOf("upgrade_house","build_workshop","upgrade_workshop","craft","start_journey"))
            assertEquals("WORLD_ECONOMY_MOVED",assertFailsWith<AuthFailure> { world.command(p.hash,upgrade.copy(action=action)) }.code)
        val claim=upgrade.copy(requestId=UUID.randomUUID().toString(),action="claim_journey",target=journey.id)
        val other=secondDevice(p)
        val commands=listOf(claim,claim.copy(requestId=UUID.randomUUID().toString()))
        val results=coroutineScope { commands.mapIndexed { i,c -> async(Dispatchers.IO) { runCatching { JdbcWorldRepository(source).command(if(i==0)p.hash else other,c) } } }.awaitAll() }
        assertEquals(1,results.count { it.isSuccess })
        assertEquals("WORLD_REVISION_CONFLICT",(results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        assertTrue(world.command(other,commands[results.indexOfFirst { it.isSuccess }]).replayed)
        val rewarded=JdbcWorldRepository(source).snapshot(other)
        assertEquals(WorldResources(),rewarded.state.resources)
        assertEquals(listOf("acorn"),rewarded.state.collection)
        assertTrue(rewarded.state.journeys.isEmpty())
        val converted=EconomyRules.legacyConversion(12,8,4)
        val economy=JdbcEconomyRepository(source).snapshot(other)
        assertEquals(converted.coinsGranted,economy.wallet.coins)
        assertEquals(converted.woodGranted,economy.inventory["wood"])
        assertEquals(converted.stoneGranted,economy.inventory["stone"])
        assertEquals("1",scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND source_key=?",p.id,"legacy-journey:${journey.id}"))
        assertEquals(0L,identities.findBySession(p.hash)!!.checkInCount)
    }
    @Test fun `old savings convert once with bounded grants and keep possessions`() = runBlocking<Unit> {
        val p=player()
        val saved=WorldState(resources=WorldResources(1_000_000,100_000,100_000),houseLevel=5,workshop=true,workshopLevel=3,
            inventory=listOf("moss","amber_scarf","explorer_cap"),collection=listOf("acorn"))
        execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)",p.id,worldJson.encodeToString(saved))
        val initial=world.snapshot(p.hash)
        assertEquals(saved.copy(resources=WorldResources()),initial.state)
        val economy=JdbcEconomyRepository(source).snapshot(p.hash)
        assertEquals(500L,economy.wallet.coins)
        assertEquals(mapOf("wood" to 30L,"stone" to 30L),economy.inventory)
        assertEquals(5,economy.buildings["home"])
        assertEquals(3,economy.buildings["workshop"])
        world.snapshot(secondDevice(p))
        assertEquals(economy.wallet,JdbcEconomyRepository(source).snapshot(p.hash).wallet)
        assertEquals("1",scalar("SELECT count(*) FROM economy_conversion_audit WHERE user_id=?",p.id))
    }
    @Test fun `accepted taps retain achievements and records but never mint retired currency`() = runBlocking<Unit> {
        val p=player(); val id=UUID.fromString(games.openSession(p.hash,UUID.randomUUID(),p.publicId).sessionId)
        games.submitBatch(p.hash,id,1,5,UUID.randomUUID())
        world.snapshot(p.hash)
        var sequence=2L
        repeat(6) {
            execute("UPDATE game_profiles SET bucket_tokens=60,bucket_updated_at=clock_timestamp()+interval '1 minute' WHERE user_id=?",p.id)
            val seq=sequence++;val run=UUID.randomUUID()
            assertEquals(60,games.submitBatch(p.hash,id,seq,60,run).acceptedTaps)
            assertTrue(games.submitBatch(p.hash,id,seq,60,run).replayed)
        }
        assertEquals(WorldResources(),world.snapshot(secondDevice(p)).state.resources)
        assertEquals(0,world.snapshot(p.hash).dailySparksEarned)
        assertEquals(0L,JdbcEconomyRepository(source).snapshot(p.hash).wallet.coins)
        assertEquals("0",scalar("SELECT count(*) FROM world_ledger WHERE user_id=? AND kind='taps'",p.id))
        assertEquals(365L,games.progress(p.hash).lifetimeTaps)
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
    fun `saved fishing trips keep duration and convert only confirmed returns`() = runBlocking<Unit> {
        val modes=listOf(Triple("fishing_5",300L,WorldResources(4,2,6)),Triple("fishing_15",900L,WorldResources(12,6,18)),
            Triple("fishing_30",1800L,WorldResources(24,12,36)),Triple("fishing_60",3600L,WorldResources(48,24,72)))
        for((routeId,seconds,rewards) in modes) {
            val p=player()
            val start=Instant.now()
            val journey=WorldJourney(UUID.randomUUID().toString(),routeId,start.toString(),start.plusSeconds(seconds).toString(),rewards,listOf("river_stone"),false,3)
            execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)",p.id,worldJson.encodeToString(WorldState(houseLevel=2,journeys=listOf(journey))))
            val initial=world.snapshot(p.hash)
            assertEquals(Duration.ofSeconds(seconds),Duration.between(Instant.parse(journey.startedAt),Instant.parse(journey.finishesAt)))
            val claim=WorldCommand(UUID.randomUUID().toString(),p.publicId,initial.revision,"claim_journey",journey.id)
            assertEquals("WORLD_JOURNEY_NOT_READY",assertFailsWith<AuthFailure> { world.command(p.hash,claim) }.code)
            assertEquals(0L,JdbcEconomyRepository(source).snapshot(p.hash).wallet.coins)
            val completed=journey.copy(startedAt="2000-01-01T00:00:00Z",finishesAt="2000-01-01T01:00:00Z")
            execute("UPDATE world_profiles SET state=?::jsonb WHERE user_id=?",worldJson.encodeToString(initial.state.copy(journeys=listOf(completed))),p.id)
            val paid=world.command(secondDevice(p),claim)
            assertEquals(WorldResources(),paid.snapshot.state.resources)
            assertEquals(listOf("river_stone"),paid.snapshot.state.collection)
            assertEquals(EconomyRules.legacyConversion(rewards.sparks,rewards.wood,rewards.stone).coinsGranted,JdbcEconomyRepository(source).snapshot(p.hash).wallet.coins)
            assertTrue(world.command(p.hash,claim).replayed)
            assertEquals("1",scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND source_key=?",p.id,"legacy-journey:${journey.id}"))
        }
    }

    @Test
    fun `saved catalog one brook trips remain claimable after retiring the route`() = runBlocking<Unit> {
        assertTrue(WorldRules.catalog.routes.none { it.id == "brook_path" })
        val p = player()
        val legacy = WorldJourney(UUID.randomUUID().toString(), "brook_path", "2000-01-01T00:00:00Z", "2000-01-01T00:30:00Z", WorldResources(14, 8, 8), listOf("river_stone", "moon_moth"), false, 1)
        val saved = WorldState(houseLevel = 2, resources = WorldResources(3, 4, 5), collection = listOf("river_stone"), firstJourneyCompleted = true, completedJourneys = 7, journeys = listOf(legacy))
        execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)", p.id, worldJson.encodeToString(saved))
        val restored = JdbcWorldRepository(source).snapshot(p.hash)
        assertEquals(3, restored.catalogVersion)
        assertEquals(1, restored.state.journeys.single().catalogVersion)
        assertEquals(saved.copy(resources=WorldResources()), restored.state)
        val claim = WorldCommand(UUID.randomUUID().toString(), p.publicId, restored.revision, "claim_journey", legacy.id)
        val paid = world.command(p.hash, claim)
        assertEquals(WorldResources(), paid.snapshot.state.resources)
        assertEquals(EconomyRules.legacyConversion(3,4,5).coinsGranted + EconomyRules.legacyConversion(14,8,8).coinsGranted,
            JdbcEconomyRepository(source).snapshot(p.hash).wallet.coins)
        assertEquals(listOf("moon_moth", "river_stone"), paid.snapshot.state.collection)
        assertEquals(8L, paid.snapshot.state.completedJourneys)
        assertTrue(paid.snapshot.state.firstJourneyCompleted)
        assertTrue(paid.snapshot.state.journeys.isEmpty())
        assertTrue(world.command(secondDevice(p), claim).replayed)
        assertEquals("1", scalar("SELECT count(*) FROM world_ledger WHERE user_id=? AND source_key=?", p.id, "journey:${legacy.id}"))
        assertEquals("WORLD_ECONOMY_MOVED", assertFailsWith<AuthFailure> {
            world.command(p.hash, claim.copy(requestId = UUID.randomUUID().toString(), expectedRevision = paid.snapshot.revision, action = "start_journey", target = "brook_path"))
        }.code)
    }

    @Test
    fun `collection medal counts only known finds and commits with the final claim exactly once`() = runBlocking<Unit> {
        val p = player()
        val initial = world.snapshot(p.hash)
        val known = WorldRules.catalog.finds.map { it.id }
        val missing = known.last()
        val trip = WorldJourney(UUID.randomUUID().toString(), "fishing_5", "2000-01-01T00:00:00Z", "2000-01-01T00:05:00Z",
            WorldResources(4, 2, 6), listOf(missing), false, 3)
        val partial = initial.state.copy(
            collection = known.dropLast(1) + known.first() + "unknown", journeys = listOf(trip))
        execute("UPDATE world_profiles SET state=?::jsonb WHERE user_id=?", worldJson.encodeToString(partial), p.id)
        val progress = games.achievements(p.hash).achievements.single { it.id == "full_collection" }
        assertEquals(11L, progress.progress); assertEquals(12L, progress.target); assertNull(progress.unlockedAt)
        assertEquals("0", scalar("SELECT count(*) FROM game_achievements WHERE user_id=? AND achievement_id='full_collection'", p.id))
        val claim = WorldCommand(UUID.randomUUID().toString(), p.publicId, initial.revision, "claim_journey", trip.id)
        val paid = world.command(p.hash, claim)
        assertTrue("willow_rod" in paid.snapshot.state.inventory)
        assertTrue("explorer_cap" in paid.snapshot.state.inventory)
        // Verify the qualifying transaction awards the medal before any achievement read.
        val at = scalar("SELECT unlocked_at::text FROM game_achievements WHERE user_id=? AND achievement_id='full_collection'", p.id)
        assertTrue(world.command(secondDevice(p), claim).replayed)
        assertEquals(at, scalar("SELECT unlocked_at::text FROM game_achievements WHERE user_id=? AND achievement_id='full_collection'", p.id))
        assertEquals("1", scalar("SELECT count(*) FROM game_achievements WHERE user_id=? AND achievement_id='full_collection'", p.id))
        val unlocked = JdbcGameRepository(source).achievements(p.hash).achievements.single { it.id == "full_collection" }
        assertEquals(12L, unlocked.progress); assertEquals(12L, unlocked.target); assertNotNull(unlocked.unlockedAt)
    }

}
