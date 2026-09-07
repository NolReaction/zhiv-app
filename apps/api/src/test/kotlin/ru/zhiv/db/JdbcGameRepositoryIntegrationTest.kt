package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.invites.DirectInviteResult
import ru.zhiv.relationships.RelationshipResult
import ru.zhiv.relationships.RequestAction
import ru.zhiv.relationships.DirectRequestMutationSnapshot
import ru.zhiv.relationships.DirectRequestActionSnapshot
import ru.zhiv.config.AppConfig
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcGameRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var games: JdbcGameRepository
    private lateinit var config: AppConfig
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)
    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
        games = JdbcGameRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c ->
        c.prepareStatement(sql).use { s -> values.forEachIndexed { i, v -> s.setObject(i + 1, v) }; s.executeUpdate() }.also { c.commit() }
    }
    private suspend fun player(name: String = "Игрок"): Player {
        val token = tokens.issue()
        val user = identities.bootstrap(name, tokens.issue().hash, token.hash, 365)
        return Player(user.id, user.publicId, token.hash, token.raw)
    }
    private fun secondDevice(player: Player): ByteArray {
        val token = tokens.issue()
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')", player.id, token.hash)
        return token.hash
    }
    private suspend fun session(player: Player, hash: ByteArray = player.hash) = games.openSession(hash, UUID.randomUUID(), player.publicId)
    private suspend fun score(player: Player, count: Int): Long {
        val session = session(player)
        return games.submitBatch(player.hash, UUID.fromString(session.sessionId), 1, count, UUID.randomUUID()).progress.monthlyTaps
    }

    @Test fun `new accounts start private and exact batch retries never increase accepted totals`() = runBlocking<Unit> {
        val p = player()
        val empty = games.progress(p.hash)
        assertEquals(0L, empty.lifetimeTaps)
        assertFalse(empty.leaderboardOptIn)
        val key = UUID.randomUUID()
        val session = games.openSession(p.hash, key, p.publicId)
        assertEquals(session.sessionId, games.openSession(p.hash, key, p.publicId).sessionId)
        val id = UUID.fromString(session.sessionId); val run = UUID.randomUUID()
        val first = games.submitBatch(p.hash, id, 1, 12, run)
        assertEquals(12, first.acceptedTaps)
        assertEquals(12L, first.runTaps)
        val replay = games.submitBatch(p.hash, id, 1, 12, run)
        assertTrue(replay.replayed)
        assertEquals(12L, replay.runTaps)
        assertEquals(12L, replay.progress.lifetimeTaps)
        assertEquals("GAME_SEQUENCE_CONFLICT", assertFailsWith<AuthFailure> { games.submitBatch(p.hash, id, 1, 13, run) }.code)
        assertEquals("GAME_SEQUENCE_CONFLICT", assertFailsWith<AuthFailure> { games.submitBatch(p.hash, id, 3, 1, run) }.code)
        val second = games.submitBatch(p.hash, id, 2, 8, run)
        assertEquals(20L, second.progress.bestSeries)
        assertEquals(20L, second.progress.lifetimeTaps)
        assertEquals(3L, games.openSession(p.hash, key, p.publicId).nextSequence)
        assertEquals("GAME_SEQUENCE_CONFLICT", assertFailsWith<AuthFailure> { games.submitBatch(p.hash, id, 1, 12, run) }.code)
        assertEquals(0L, identities.findBySession(p.hash)!!.checkInCount, "game taps must never write check-ins")
    }

    @Test fun `concurrent devices and new repository instances share a persistent user budget`() = runBlocking<Unit> {
        val p = player(); val otherHash = secondDevice(p)
        val a = session(p); val b = session(p, otherHash)
        execute("UPDATE game_profiles SET bucket_tokens=60,bucket_updated_at=clock_timestamp()+interval '1 minute' WHERE user_id=?", p.id)
        val results = coroutineScope {
            listOf(
                async(Dispatchers.IO) { games.submitBatch(p.hash, UUID.fromString(a.sessionId), 1, 60, UUID.randomUUID()) },
                async(Dispatchers.IO) { JdbcGameRepository(source).submitBatch(otherHash, UUID.fromString(b.sessionId), 1, 60, UUID.randomUUID()) },
            ).awaitAll()
        }
        assertEquals(60, results.sumOf { it.acceptedTaps })
        assertEquals(60, results.sumOf { it.rejectedTaps })
        assertEquals(60L, games.progress(p.hash).lifetimeTaps)
        val next = session(p)
        assertEquals(0, games.submitBatch(p.hash, UUID.fromString(next.sessionId), 1, 60, UUID.randomUUID()).acceptedTaps)
        assertEquals("GAME_SESSION_CONFLICT", assertFailsWith<AuthFailure> {
            games.submitBatch(otherHash, UUID.fromString(a.sessionId), 2, 1, UUID.randomUUID())
        }.code)
    }

    @Test fun `a paced 719 tap run is persisted completely and returned in retry receipts`() = runBlocking<Unit> {
        val p = player(); val opened = session(p)
        val id = UUID.fromString(opened.sessionId); val run = UUID.randomUUID()
        var accepted = 0L
        // Advance only the persisted budget's refill origin. Each batch represents
        // three seconds at 20 taps/sec without sleeping or trusting client clocks.
        for (sequence in 1L..12L) {
            execute("UPDATE game_profiles SET bucket_updated_at=clock_timestamp()-interval '3 seconds' WHERE user_id=?", p.id)
            val count = minOf(60L, 719L - accepted).toInt()
            val sent = games.submitBatch(p.hash,id,sequence,count,run)
            accepted += count
            assertEquals(count,sent.acceptedTaps)
            assertEquals(0,sent.rejectedTaps)
            assertEquals(accepted,sent.runTaps)
            assertEquals(accepted,sent.progress.bestSeries)
            val replay = games.submitBatch(p.hash,id,sequence,count,run)
            assertTrue(replay.replayed)
            assertEquals(accepted,replay.runTaps)
            assertEquals(accepted,replay.progress.lifetimeTaps)
        }
        val persisted = JdbcGameRepository(source).progress(p.hash)
        assertEquals(719L,persisted.bestSeries)
        assertEquals(719L,persisted.lifetimeTaps)
        assertEquals(719L,persisted.monthlyTaps)
    }

    @Test fun `zero accepted taps do not report the previous run as the requested run`() = runBlocking<Unit> {
        val p = player(); val opened = session(p); val id = UUID.fromString(opened.sessionId)
        val previous = UUID.randomUUID()
        assertEquals(20L,games.submitBatch(p.hash,id,1,20,previous).runTaps)
        execute("UPDATE game_profiles SET bucket_tokens=0,bucket_updated_at=clock_timestamp()+interval '1 minute' WHERE user_id=?", p.id)
        val next = UUID.randomUUID()
        val rejected = games.submitBatch(p.hash,id,2,4,next)
        assertEquals(0,rejected.acceptedTaps)
        assertEquals(0L,rejected.runTaps)
        assertEquals(20L,rejected.progress.bestSeries)
        val replay = games.submitBatch(p.hash,id,2,4,next)
        assertTrue(replay.replayed)
        assertEquals(0L,replay.runTaps)
        assertEquals(20L,replay.progress.lifetimeTaps)
        assertEquals(20L,games.submitBatch(p.hash,id,3,1,previous).runTaps)
    }

    @Test fun `a purged receipt is gone rather than an uncommitted expired batch`() = runBlocking<Unit> {
        val p = player(); val opened = session(p)
        val id = UUID.fromString(opened.sessionId); val run = UUID.randomUUID()
        games.submitBatch(p.hash,id,1,9,run)
        // Cleanup after retention, or account merge, can remove transport receipts
        // while keeping their accepted counters. Clients must not replay these
        // counts under a fresh session/sequence.
        execute("DELETE FROM game_sessions WHERE id=?",id)
        val missing = assertFailsWith<AuthFailure> { games.submitBatch(p.hash,id,1,9,run) }
        assertEquals("GAME_SESSION_GONE",missing.code)
        assertEquals(410,missing.status)
        assertEquals(9L,games.progress(p.hash).lifetimeTaps)
        val stranger = player()
        val hidden = assertFailsWith<AuthFailure> { games.submitBatch(stranger.hash,id,1,9,run) }
        assertEquals(missing.code,hidden.code)
        assertEquals(missing.status,hidden.status)
    }

    @Test fun `only server receipts extend a record and timezone changes cannot choose scoring month`() = runBlocking<Unit> {
        val p = player(); val session = session(p); val id = UUID.fromString(session.sessionId); val run = UUID.randomUUID()
        val first = games.submitBatch(p.hash, id, 1, 10, run)
        val second = games.submitBatch(p.hash, id, 2, 4, UUID.randomUUID())
        assertEquals(10L, second.progress.bestSeries)
        val third = games.submitBatch(p.hash, id, 3, 6, UUID.randomUUID())
        assertEquals(10L, third.progress.bestSeries)
        identities.updateTimeZone(p.hash, "Pacific/Kiritimati", UUID.randomUUID())
        identities.updateTimeZone(p.hash, "Etc/GMT+12", UUID.randomUUID())
        val progress = games.progress(p.hash)
        assertEquals(first.progress.month, progress.month)
        assertEquals(20L, progress.monthlyTaps)
        assertEquals(20L, progress.lifetimeTaps)
    }

    @Test fun `expired previous month sessions cannot carry a new batch into this month`() = runBlocking<Unit> {
        val p = player(); val session = session(p); val id = UUID.fromString(session.sessionId)
        val currentMonth = OffsetDateTime.parse(session.progress.serverTime).withOffsetSameInstant(ZoneOffset.UTC).toLocalDate().withDayOfMonth(1)
        val boundary = currentMonth.atStartOfDay().atOffset(ZoneOffset.UTC)
        execute("UPDATE game_sessions SET month=?,created_at=?,expires_at=? WHERE id=?", currentMonth.minusMonths(1), boundary.minusMinutes(5), boundary, id)
        assertEquals("GAME_SESSION_EXPIRED", assertFailsWith<AuthFailure> { games.submitBatch(p.hash, id, 1, 60, UUID.randomUUID()) }.code)
        assertEquals(0L, games.progress(p.hash).monthlyTaps)
        val newSession = session(p)
        assertEquals(currentMonth.toString().take(7), newSession.progress.month)
        assertTrue(OffsetDateTime.parse(newSession.expiresAt) <= currentMonth.plusMonths(1).atStartOfDay().atOffset(ZoneOffset.UTC))
    }

    @Test fun `visibility requires opt in and stale or different owner writes cannot republish`() = runBlocking<Unit> {
        val p = player(); val other = player()
        score(p, 20)
        assertFalse(games.leaderboard(other.hash).entries.any { it.isMe })
        val yes = games.setVisibility(p.hash, true, 0, p.publicId)
        assertEquals(1L, yes.visibilityVersion)
        assertEquals(yes.visibilityVersion, games.setVisibility(p.hash, true, 0, p.publicId).visibilityVersion)
        assertNotNull(games.leaderboard(p.hash).myRank)
        val no = games.setVisibility(p.hash, false, 1, p.publicId)
        assertEquals(2L, no.visibilityVersion)
        assertEquals("GAME_VISIBILITY_CONFLICT", assertFailsWith<AuthFailure> { games.setVisibility(p.hash, true, 0, p.publicId) }.code)
        assertNull(games.leaderboard(p.hash).myRank)
        assertEquals("GAME_OWNER_CHANGED", assertFailsWith<AuthFailure> { games.setVisibility(other.hash, true, 0, p.publicId) }.code)
        assertEquals("GAME_OWNER_CHANGED", assertFailsWith<AuthFailure> { games.openSession(other.hash, UUID.randomUUID(), p.publicId) }.code)
        assertFalse(games.progress(other.hash).leaderboardOptIn)
    }

    @Test fun `leaderboard is top 100 but returns own rank outside it without contact identifiers`() = runBlocking<Unit> {
        val p = player(); score(p, 1); games.setVisibility(p.hash, true, 0, p.publicId)
        execute("""
            INSERT INTO app_users(public_id,display_name)
            SELECT 'RANK-0000-' || lpad(i::text,4,'0'),'Игрок ' || i FROM generate_series(1,105) i
        """.trimIndent())
        execute("INSERT INTO game_profiles(user_id,lifetime_taps,leaderboard_opt_in) SELECT id,1000,true FROM app_users WHERE public_id LIKE 'RANK-0000-%'")
        execute("""
            INSERT INTO game_monthly_scores(user_id,month,taps)
            SELECT id,date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,1000 FROM app_users WHERE public_id LIKE 'RANK-0000-%'
        """.trimIndent())
        val board = games.leaderboard(p.hash)
        assertEquals(100, board.entries.size)
        assertTrue(assertNotNull(board.myRank) > 100)
        assertTrue(board.entries.zipWithNext().all { (a,b) -> a.rank + 1 == b.rank && a.taps >= b.taps })
        assertEquals(p.publicId, board.ownerPublicId)
        assertEquals(1L, board.monthlyTaps)
    }

    @Test fun `HTTP guards reject anonymous writes untrusted origins and invented totals`() = testApplication {
        application { installZhivApi(identities, identities, config, games = games) }
        val p = player()
        val cookie = "${config.cookieName}=${p.raw}"
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/game/leaderboard").status)
        val body = """{"requestId":"${UUID.randomUUID()}","ownerPublicId":"${p.publicId}"}"""
        val forbidden = client.post("/api/v1/game/sessions") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Cookie,cookie); header(HttpHeaders.Origin,"https://other.example"); setBody(body)
        }
        assertEquals(HttpStatusCode.Forbidden, forbidden.status)
        val opened = client.post("/api/v1/game/sessions") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Cookie,cookie); setBody(body)
        }
        assertEquals(HttpStatusCode.OK, opened.status)
        assertEquals("no-store", opened.headers[HttpHeaders.CacheControl])
        val id = Json.parseToJsonElement(opened.bodyAsText()).jsonObject.getValue("sessionId").jsonPrimitive.content
        val invented = client.post("/api/v1/game/batches") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Cookie,cookie)
            setBody("""{"sessionId":"$id","sequence":1,"tapCount":10,"runId":"${UUID.randomUUID()}","lifetimeTaps":999999}""")
        }
        assertEquals(HttpStatusCode.BadRequest, invented.status)
        assertEquals(0L, games.progress(p.hash).lifetimeTaps)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",p.hash)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/game/progress") { header(HttpHeaders.Cookie,cookie) }.status)
    }

    @Test fun `session renewal carries a recent run once without combining active parallel games`() = runBlocking<Unit> {
        val p = player(); val run = UUID.randomUUID()
        val original = session(p); val originalId = UUID.fromString(original.sessionId)
        games.submitBatch(p.hash, originalId, 1, 20, run)
        val parallel = session(p)
        val independent = games.submitBatch(p.hash, UUID.fromString(parallel.sessionId), 1, 5, run)
        assertEquals(20L, independent.progress.bestSeries, "active sessions must not borrow each other's run")
        // Deterministically expire the predecessor with a recent receipt. Clamp at its
        // month's end so this fixture also works during the first seconds of a month.
        val instant = OffsetDateTime.parse(games.progress(p.hash).serverTime)
        val created = instant.minusSeconds(5)
        val scoreMonth = created.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate().withDayOfMonth(1)
        val expiry = minOf(instant.minusNanos(1_000_000), scoreMonth.plusMonths(1).atStartOfDay().atOffset(ZoneOffset.UTC))
        val acceptedAt = expiry.minusNanos(1_000_000)
        execute("UPDATE game_sessions SET month=?,created_at=?,expires_at=?,last_batch_at=?,run_updated_at=? WHERE id=?", scoreMonth, created, expiry, acceptedAt, acceptedAt, originalId)
        val renewed = session(p); val renewedId = UUID.fromString(renewed.sessionId)
        val continued = games.submitBatch(p.hash, renewedId, 1, 5, run)
        assertEquals(25L, continued.progress.bestSeries)
        assertEquals(30L, continued.progress.lifetimeTaps)
        val replay = games.submitBatch(p.hash, renewedId, 1, 5, run)
        assertTrue(replay.replayed)
        assertEquals(25L, replay.progress.bestSeries)
        assertEquals(30L, replay.progress.lifetimeTaps)
        val extra = session(p)
        val noSecondClaim = games.submitBatch(p.hash, UUID.fromString(extra.sessionId), 1, 7, run)
        assertEquals(25L, noSecondClaim.progress.bestSeries, "an expired predecessor can be inherited only once")
        val more = games.submitBatch(p.hash, renewedId, 2, 10, run)
        assertEquals(35L, more.progress.bestSeries)
        assertEquals(47L, more.progress.lifetimeTaps)
        val restarted = games.submitBatch(p.hash, renewedId, 3, 3, UUID.randomUUID())
        assertEquals(35L, restarted.progress.bestSeries, "a fresh runId begins a separate run")
    }

    private fun scalar(sql: String, vararg values: Any?): String? = source.connection.use { c ->
        c.prepareStatement(sql).use { statement ->
            values.forEachIndexed { i,v -> statement.setObject(i+1,v) }
            statement.executeQuery().use { if (it.next()) it.getString(1) else null }
        }
    }
    private suspend fun connect(a: Player, b: Player): UUID {
        val relationships = JdbcRelationshipRepository(source)
        val request = assertIs<RelationshipResult.Success<DirectRequestMutationSnapshot>>(
            relationships.sendRequest(a.hash,b.publicId,UUID.randomUUID())).value.request
        val accepted = assertIs<RelationshipResult.Success<DirectRequestActionSnapshot>>(
            relationships.actOnRequest(b.hash,request.requestId,RequestAction.ACCEPTED)).value
        return assertNotNull(accepted.person).circleId
    }
    private fun awardAt(player: Player, id: String): String? = scalar(
        "SELECT unlocked_at FROM game_achievements WHERE user_id=? AND achievement_id=?",player.id,id)
    private fun seedCheckIn(player: Player, at: OffsetDateTime, localDate: java.time.LocalDate = at.toLocalDate()) {
        execute("""
            INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
            SELECT ?,id,?,?,?,'UTC',? FROM app_sessions WHERE token_hash=?
        """.trimIndent(),player.id,UUID.randomUUID(),at,at.plusSeconds(30),localDate,player.hash)
    }

    @Test fun `friends scope filters before ranking and excludes pending groups removed deleted and private players`() = runBlocking<Unit> {
        val me=player("Мой рейтинг"); val friend=player("Друг"); val pending=player("Заявка")
        val stranger=player("Посторонний"); val privateFriend=player("Скрытый")
        val removed=player("Удалённая связь"); val deleted=player("Удалённый участник"); val groupPeer=player("Общая группа")
        val players=listOf(me,friend,pending,stranger,privateFriend,removed,deleted,groupPeer)
        players.forEachIndexed { i,p -> score(p,10+i); if (p!=privateFriend) games.setVisibility(p.hash,true,0,p.publicId) }
        val relationships=JdbcRelationshipRepository(source)
        connect(me,friend); connect(me,privateFriend)
        val removedCircle=connect(me,removed); relationships.removePerson(me.hash,removedCircle)
        connect(me,deleted); execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",deleted.id)
        relationships.sendRequest(me.hash,pending.publicId,UUID.randomUUID())
        val groupId=UUID.randomUUID()
        source.connection.use { c ->
            c.prepareStatement("INSERT INTO circles(id,kind,title,created_by_user_id,creation_idempotency_key) VALUES (?,'GROUP','Группа',?,?)").use {
                it.setObject(1,groupId);it.setObject(2,me.id);it.setObject(3,UUID.randomUUID());it.executeUpdate()
            }
            c.prepareStatement("INSERT INTO circle_memberships(circle_id,user_id,role) VALUES (?,?,?)").use { statement ->
                listOf(me,groupPeer).forEach {
                    statement.setObject(1,groupId);statement.setObject(2,it.id)
                    statement.setString(3,if(it==me) "OWNER" else "MEMBER");statement.addBatch()
                }
                statement.executeBatch()
            }
            c.commit() // Deferred invariant: an active group already has its OWNER.
        }
        val board=games.leaderboard(me.hash,"friends")
        assertEquals("friends",board.scope)
        assertEquals(listOf("Друг","Мой рейтинг"),board.entries.map { it.displayName })
        assertEquals(listOf(1L,2L),board.entries.map { it.rank })
        assertEquals(2L,board.myRank)
        games.setVisibility(friend.hash,false,1,friend.publicId)
        assertEquals(listOf("Мой рейтинг"),games.leaderboard(me.hash,"friends").entries.map { it.displayName })
        games.setVisibility(me.hash,false,1,me.publicId)
        assertNull(games.leaderboard(me.hash,"friends").myRank)
        assertTrue(games.leaderboard(me.hash,"friends").entries.isEmpty())
        assertEquals("global",games.leaderboard(stranger.hash).scope)
    }

    @Test fun `friends top 100 still reports own position outside its limit`() = runBlocking<Unit> {
        val p=player(); score(p,1); games.setVisibility(p.hash,true,0,p.publicId)
        execute("INSERT INTO app_users(public_id,display_name) SELECT 'FRND-0000-'||lpad(i::text,4,'0'),'Друг '||i FROM generate_series(1,105) i")
        execute("INSERT INTO game_profiles(user_id,lifetime_taps,leaderboard_opt_in) SELECT id,1000,true FROM app_users WHERE public_id LIKE 'FRND-0000-%'")
        execute("INSERT INTO game_monthly_scores(user_id,month,taps) SELECT id,date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,1000 FROM app_users WHERE public_id LIKE 'FRND-0000-%'")
        execute("""
            INSERT INTO circles(kind,created_by_user_id,direct_user_low_id,direct_user_high_id)
            SELECT 'DIRECT',?,LEAST(?::uuid,id),GREATEST(?::uuid,id) FROM app_users WHERE public_id LIKE 'FRND-0000-%'
        """.trimIndent(),p.id,p.id,p.id)
        val board=games.leaderboard(p.hash,"friends")
        assertEquals(100,board.entries.size)
        assertEquals(106L,board.myRank)
        assertEquals((1L..100L).toList(),board.entries.map { it.rank })
    }

    @Test fun `thousand taps unlocks on accepted write before achievements are opened and replay cannot rewrite the award`() = runBlocking<Unit> {
        val p=player(); val session=session(p); val id=UUID.fromString(session.sessionId); val run=UUID.randomUUID()
        execute("UPDATE game_profiles SET lifetime_taps=995 WHERE user_id=?",p.id)
        games.submitBatch(p.hash,id,1,4,run)
        assertNull(awardAt(p,"thousand_taps"))
        games.submitBatch(p.hash,id,2,1,run)
        val unlocked=assertNotNull(awardAt(p,"thousand_taps"))
        games.submitBatch(p.hash,id,2,1,run)
        assertEquals(unlocked,awardAt(p,"thousand_taps"))
        val snapshot=JdbcGameRepository(source).achievements(secondDevice(p))
        assertEquals(p.publicId,snapshot.ownerPublicId)
        val achievement=snapshot.achievements.single { it.id=="thousand_taps" }
        assertEquals(1000L,achievement.progress)
        assertEquals(1000L,achievement.target)
        assertNotNull(achievement.unlockedAt)
        assertNull(snapshot.achievements.single { it.id=="seven_day_streak" }.unlockedAt)
    }

    @Test fun `seven days uses server rolling time not local calendar dates and unlocks on check in`() = runBlocking<Unit> {
        val p=player(); val instant=OffsetDateTime.parse(games.progress(p.hash).serverTime)
        val start=instant.minusDays(6).minusMinutes(1)
        repeat(7) { seedCheckIn(p,start.plusHours(it*23L)) }
        identities.updateTimeZone(p.hash,"Pacific/Kiritimati",UUID.randomUUID())
        identities.updateTimeZone(p.hash,"Etc/GMT+12",UUID.randomUUID())
        assertNull(awardAt(p,"seven_day_streak"))
        val accepted=assertIs<CheckInResult.Accepted>(identities.record(p.hash,UUID.randomUUID()))
        assertEquals(7L,accepted.streak.longestDays)
        assertNotNull(awardAt(p,"seven_day_streak"),"the successful check-in writes the award in its transaction")
        assertEquals(7L,games.achievements(secondDevice(p)).achievements.single { it.id=="seven_day_streak" }.progress)
        val short=player()
        val forgedDate=assertFailsWith<java.sql.SQLException> {
            seedCheckIn(short,instant.minusMinutes(11),instant.toLocalDate().minusDays(5))
        }
        assertEquals("23514",forgedDate.sqlState,"the database rejects a calendar date inconsistent with its timestamp and zone")
        repeat(7) { seedCheckIn(short,instant.minusMinutes(10).plusSeconds(it*31L)) }
        assertEquals(1L,games.achievements(short.hash).achievements.single { it.id=="seven_day_streak" }.progress)
        assertNull(awardAt(short,"seven_day_streak"))
    }

    @Test fun `five friends is awarded to both invitation participants and survives removal before first read`() = runBlocking<Unit> {
        val a=player(); val b=player(); val others=List(8) { player() }
        repeat(4) { connect(a,others[it]); connect(b,others[it+4]) }
        assertNull(awardAt(a,"five_friends")); assertNull(awardAt(b,"five_friends"))
        val invites=JdbcDirectInviteRepository(source)
        val invitation=tokens.issue()
        assertIs<DirectInviteResult.Success<*>>(invites.create(a.hash,invitation.hash,UUID.randomUUID()))
        val accepted=assertIs<DirectInviteResult.Success<ru.zhiv.invites.DirectInviteRedeemSnapshot>>(
            invites.redeem(b.hash,invitation.hash,UUID.randomUUID())).value
        val firstA=assertNotNull(awardAt(a,"five_friends")); val firstB=assertNotNull(awardAt(b,"five_friends"))
        JdbcRelationshipRepository(source).removePerson(a.hash,accepted.person.circleId)
        assertEquals(5L,games.achievements(a.hash).achievements.single { it.id=="five_friends" }.progress)
        assertEquals(5L,JdbcGameRepository(source).achievements(secondDevice(b)).achievements.single { it.id=="five_friends" }.progress)
        connect(a,b)
        assertEquals(firstA,awardAt(a,"five_friends")); assertEquals(firstB,awardAt(b,"five_friends"))
        // The ID acceptance path also unlocks a previously unawarded user.
        val c=player()
        repeat(5) { connect(c,others[it]) }
        assertNotNull(awardAt(c,"five_friends"))
    }

    @Test fun `HTTP achievements are private and leaderboard scope rejects unknown or repeated values`() = testApplication {
        application { installZhivApi(identities,identities,config,games=games) }
        val p=player(); val cookie="${config.cookieName}=${p.raw}"
        assertEquals(HttpStatusCode.Unauthorized,client.get("/api/v1/game/achievements").status)
        for (query in listOf("scope=other","scope=","scope=friends&scope=global","scope=friends&scope=friends")) {
            assertEquals(HttpStatusCode.BadRequest,client.get("/api/v1/game/leaderboard?$query") { header(HttpHeaders.Cookie,cookie) }.status)
        }
        val response=client.get("/api/v1/game/achievements") { header(HttpHeaders.Cookie,cookie) }
        assertEquals(HttpStatusCode.OK,response.status)
        assertEquals("no-store",response.headers[HttpHeaders.CacheControl])
        val json=Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals(setOf("ownerPublicId","serverTime","achievements"),json.keys)
        assertEquals(p.publicId,json.getValue("ownerPublicId").jsonPrimitive.content)
        assertEquals(3,json.getValue("achievements").jsonArray.size)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",p.hash)
        assertEquals(HttpStatusCode.Unauthorized,client.get("/api/v1/game/achievements") { header(HttpHeaders.Cookie,cookie) }.status)
    }


    @Test fun `V21 upgrade backfills historical streak verified taps and current friends once`() = runBlocking<Unit> {
        val database="achievement_upgrade_"+UUID.randomUUID().toString().replace("-", "")
        source.connection.use { c -> c.autoCommit=true; c.createStatement().use { it.execute("CREATE DATABASE $database") } }
        try {
            val upgraded=DatabaseFactory.create(config.copy(databaseUrl=postgres.jdbcUrl.substringBeforeLast('/')+"/"+database))
            upgraded.use { db ->
                Flyway.configure().dataSource(db).locations("classpath:db/migration").target("20").load().migrate()
                val repo=JdbcZhivRepository(db); val token=tokens.issue()
                val owner=repo.bootstrap("До обновления",tokens.issue().hash,token.hash,365)
                val friends=List(5) { repo.bootstrap("Друг",tokens.issue().hash,tokens.issue().hash,365) }
                db.connection.use { c ->
                    c.prepareStatement("INSERT INTO game_profiles(user_id,lifetime_taps) VALUES (?,1000)").use { it.setObject(1,owner.id);it.executeUpdate() }
                    c.prepareStatement("""
                        INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
                        SELECT ?,s.id,uuidv7(),d.at,d.at+interval '30 seconds','UTC',(d.at AT TIME ZONE 'UTC')::date
                        FROM app_sessions s CROSS JOIN LATERAL (
                            SELECT statement_timestamp()-interval '20 days'+i*interval '24 hours' AS at FROM generate_series(0,6) i
                        ) d WHERE s.token_hash=?
                    """.trimIndent()).use { it.setObject(1,owner.id);it.setBytes(2,token.hash);it.executeUpdate() }
                    c.prepareStatement("INSERT INTO circles(kind,created_by_user_id,direct_user_low_id,direct_user_high_id) VALUES ('DIRECT',?,LEAST(?::uuid,?::uuid),GREATEST(?::uuid,?::uuid))").use {
                        friends.forEach { friend ->
                            it.setObject(1,owner.id);it.setObject(2,owner.id);it.setObject(3,friend.id);it.setObject(4,owner.id);it.setObject(5,friend.id);it.addBatch()
                        };it.executeBatch()
                    }
                    c.commit()
                }
                DatabaseFactory.migrate(db)
                db.connection.use { c ->
                    c.prepareStatement("SELECT count(*) FROM game_achievements WHERE user_id=?").use {
                        it.setObject(1,owner.id)
                        it.executeQuery().use { rows -> assertTrue(rows.next());assertEquals(3,rows.getInt(1),"migration must award before the first achievements read") }
                    }
                }
                val first=JdbcGameRepository(db).achievements(token.hash).achievements
                assertEquals(listOf(7L,1000L,5L),first.map { it.progress })
                assertTrue(first.all { it.unlockedAt!=null })
                db.connection.use { c ->
                    c.prepareStatement("UPDATE circles SET archived_at=clock_timestamp() WHERE kind='DIRECT' AND ? IN (direct_user_low_id,direct_user_high_id)").use { it.setObject(1,owner.id);it.executeUpdate() };c.commit()
                }
                DatabaseFactory.migrate(db)
                assertEquals(first,JdbcGameRepository(db).achievements(token.hash).achievements)
            }
        } finally {
            source.connection.use { c -> c.autoCommit=true;c.createStatement().use { it.execute("DROP DATABASE $database WITH (FORCE)") } }
        }
    }

    @Test fun `achievements reconcile verified progress accepted by an old API after migration exactly once`() = runBlocking<Unit> {
        val p=player(); session(p)
        // Simulate the old API's committed score after V21 finished backfilling.
        execute("UPDATE game_profiles SET lifetime_taps=1005 WHERE user_id=?",p.id)
        assertNull(awardAt(p,"thousand_taps"))
        val otherDevice=secondDevice(p)
        val results=coroutineScope {
            listOf(
                async(Dispatchers.IO) { games.achievements(p.hash) },
                async(Dispatchers.IO) { JdbcGameRepository(source).achievements(otherDevice) },
            ).awaitAll()
        }
        val awards=results.map { it.achievements.single { award -> award.id=="thousand_taps" } }
        assertTrue(awards.all { it.progress==1000L && it.target==1000L && it.unlockedAt!=null })
        assertEquals(1,awards.map { it.unlockedAt }.distinct().size)
        assertEquals("1",scalar("SELECT count(*) FROM game_achievements WHERE user_id=?",p.id))
        assertEquals(awards.first(),games.achievements(p.hash).achievements.single { it.id=="thousand_taps" })
        val fresh=player()
        identities.updateTimeZone(fresh.hash,"Pacific/Kiritimati",UUID.randomUUID())
        val unearned=games.achievements(fresh.hash).achievements
        assertTrue(unearned.all { it.progress==0L && it.unlockedAt==null },"reconciliation never imports device-local counters or dates")
        assertEquals("0",scalar("SELECT count(*) FROM game_achievements WHERE user_id=?",fresh.id))
    }

}
