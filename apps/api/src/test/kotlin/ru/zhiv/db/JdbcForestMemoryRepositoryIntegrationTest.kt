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
import ru.zhiv.forest.*
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcForestMemoryRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var memory: JdbcForestMemoryRepository
    private lateinit var config: AppConfig
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)
    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config); DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source); memory = JdbcForestMemoryRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { connection ->
        connection.prepareStatement(sql).use { statement -> values.forEachIndexed { i, value -> statement.setObject(i + 1, value) }; statement.executeUpdate() }.also { connection.commit() }
    }
    private fun scalar(sql: String, vararg values: Any?): String = source.connection.use { connection ->
        connection.prepareStatement(sql).use { statement -> values.forEachIndexed { i, value -> statement.setObject(i + 1, value) }; statement.executeQuery().use { it.next(); it.getString(1) } }
    }
    private suspend fun player(): Player {
        val token = tokens.issue(); val user = identities.bootstrap("Мохлик", tokens.issue().hash, token.hash, 365)
        return Player(user.id, user.publicId, token.hash, token.raw)
    }
    private fun device(player: Player): ByteArray {
        val token = tokens.issue()
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')", player.id, token.hash)
        return token.hash
    }
    private fun acquire(player: Player, client: UUID = UUID.randomUUID(), revision: Long = 0, takeover: Boolean = false) =
        ForestMemoryCommand(player.publicId, client.toString(), UUID.randomUUID().toString(), revision, "acquire", takeover)
    private fun save(acquire: ForestMemoryCommand, state: ForestMemoryView, energy: Double = 0.7) = acquire.copy(
        requestId = UUID.randomUUID().toString(), expectedRevision = state.revision, action = "save", takeover = false,
        leaseToken = state.lease.token, snapshot = memoryFixture(energy))

    @Test fun `memory persists across devices without changing economy and hides foreign lease tokens`() = runBlocking<Unit> {
        val p = player(); val client = UUID.randomUUID(); val other = device(p)
        val world = JdbcWorldRepository(source); val economy = world.snapshot(p.hash)
        val initial = memory.read(p.hash, p.publicId, client)
        assertEquals(0L, initial.revision); assertNull(initial.snapshot); assertFalse(initial.lease.owned)
        val command = acquire(p, client)
        val leased = memory.command(p.hash, command).state
        assertEquals(1L, leased.revision); assertTrue(leased.lease.owned); assertNotNull(leased.lease.token)
        val stored = memory.command(p.hash, save(command, leased)).state
        assertEquals(2L, stored.revision); assertEquals(memoryFixture(), stored.snapshot)
        val restored = JdbcForestMemoryRepository(source).read(other, p.publicId, client)
        assertEquals(stored.snapshot, restored.snapshot); assertEquals(stored.updatedAt, restored.updatedAt)
        assertFalse(restored.lease.owned); assertNull(restored.lease.token); assertNotNull(restored.lease.expiresAt)
        val sameSessionOtherTab = memory.read(p.hash, p.publicId, UUID.randomUUID())
        assertFalse(sameSessionOtherTab.lease.owned); assertNull(sameSessionOtherTab.lease.token)
        val after = world.snapshot(p.hash)
        assertEquals(economy.revision, after.revision); assertEquals(economy.state, after.state)
        val stranger = player()
        assertEquals("FOREST_MEMORY_ACCOUNT_CHANGED", assertFailsWith<AuthFailure> { memory.read(stranger.hash, p.publicId, client) }.code)
        assertEquals("FOREST_MEMORY_ACCOUNT_CHANGED", assertFailsWith<AuthFailure> { memory.command(stranger.hash, command) }.code)
        assertNull(memory.read(stranger.hash, stranger.publicId, client).snapshot)
    }

    @Test fun `takeover fences prior device and replay only acknowledges original revision`() = runBlocking<Unit> {
        val p = player(); val other = device(p); val a = acquire(p)
        val leased = memory.command(p.hash, a)
        val write = save(a, leased.state); val saved = memory.command(p.hash, write)
        val replay = memory.command(p.hash, write)
        assertTrue(replay.replayed); assertEquals(saved.acceptedRevision, replay.acceptedRevision)
        assertEquals(saved.state.lease.expiresAt, replay.state.lease.expiresAt)
        assertEquals("FOREST_MEMORY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { memory.command(p.hash, write.copy(snapshot = memoryFixture(0.9))) }.code)
        assertEquals("FOREST_MEMORY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { memory.command(other, write) }.code)
        val b = acquire(p, revision = saved.state.revision)
        assertEquals("FOREST_MEMORY_ACTIVE_ELSEWHERE", assertFailsWith<AuthFailure> { memory.command(other, b) }.code)
        val transferred = memory.command(other, b.copy(takeover = true)).state
        assertNotEquals(saved.state.lease.token, transferred.lease.token)
        val acknowledged = memory.command(p.hash, write)
        assertTrue(acknowledged.replayed); assertEquals(saved.acceptedRevision, acknowledged.acceptedRevision)
        assertEquals(transferred.revision, acknowledged.state.revision); assertFalse(acknowledged.state.lease.owned)
        assertNull(acknowledged.state.lease.token)
        assertEquals("FOREST_MEMORY_REVISION_CONFLICT", assertFailsWith<AuthFailure> { memory.command(p.hash, save(a, saved.state)) }.code)
        assertEquals("FOREST_MEMORY_LEASE_LOST", assertFailsWith<AuthFailure> { memory.command(p.hash, save(a, transferred).copy(leaseToken = saved.state.lease.token)) }.code)
        val release = b.copy(requestId = UUID.randomUUID().toString(), action = "release", expectedRevision = transferred.revision, leaseToken = transferred.lease.token)
        val released = memory.command(other, release).state
        assertFalse(released.lease.owned); assertNull(released.lease.expiresAt); assertEquals(saved.state.snapshot, released.snapshot)
        val reacquired = memory.command(p.hash, acquire(p, UUID.fromString(a.clientId), released.revision)).state
        assertTrue(reacquired.lease.owned); assertNotEquals(saved.state.lease.token, reacquired.lease.token)
    }

    @Test fun `expired or revoked writer cannot save and does not block recovery`() = runBlocking<Unit> {
        val p = player(); val other = device(p); val a = acquire(p)
        val first = memory.command(p.hash, a).state
        execute("UPDATE forest_memory SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE user_id=?", p.id)
        assertEquals("FOREST_MEMORY_LEASE_LOST", assertFailsWith<AuthFailure> { memory.command(p.hash, save(a, first)) }.code)
        val expired = memory.read(p.hash, p.publicId, UUID.fromString(a.clientId))
        assertNull(expired.lease.expiresAt); assertFalse(expired.lease.owned)
        val renewedCommand = acquire(p, UUID.fromString(a.clientId), first.revision)
        val renewed = memory.command(p.hash, renewedCommand).state
        assertNotEquals(first.lease.token, renewed.lease.token)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?", p.hash)
        assertEquals("UNAUTHORIZED", assertFailsWith<AuthFailure> { memory.command(p.hash, save(a, renewed)) }.code)
        val recovered = memory.command(other, acquire(p, revision = renewed.revision)).state
        assertTrue(recovered.lease.owned)
        execute("UPDATE app_users SET banned_at=clock_timestamp() WHERE id=?", p.id)
        assertEquals("UNAUTHORIZED", assertFailsWith<AuthFailure> { memory.read(other, p.publicId, UUID.randomUUID()) }.code)
    }

    @Test fun `concurrent same revision saves have one winner and bounded receipts never reopen old commands`() = runBlocking<Unit> {
        val p = player(); val a = acquire(p); var state = memory.command(p.hash, a).state
        val candidates = listOf(save(a, state, 0.2), save(a, state, 0.8))
        val outcomes = coroutineScope { candidates.map { command -> async(Dispatchers.IO) { runCatching { JdbcForestMemoryRepository(source).command(p.hash, command) } } }.awaitAll() }
        assertEquals(1, outcomes.count { it.isSuccess })
        assertEquals("FOREST_MEMORY_REVISION_CONFLICT", (outcomes.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        val accepted = outcomes.single { it.isSuccess }.getOrThrow(); state = accepted.state
        assertEquals(candidates[outcomes.indexOfFirst { it.isSuccess }].snapshot, state.snapshot)
        repeat(70) { state = memory.command(p.hash, save(a, state)).state }
        assertEquals("64", scalar("SELECT count(*) FROM forest_memory_receipts WHERE user_id=?", p.id))
        assertEquals("FOREST_MEMORY_REVISION_CONFLICT", assertFailsWith<AuthFailure> { memory.command(p.hash, a) }.code)
        assertEquals(state.revision, memory.read(p.hash, p.publicId, UUID.fromString(a.clientId)).revision)
    }

    @Test fun `HTTP boundary enforces auth owner origin strict JSON and request bounds`() = testApplication {
        application { installZhivApi(identities, identities, config, tokens, forestMemory = memory) }
        val p = player(); val a = acquire(p)
        val path = "/api/v1/world/forest-memory?expectedOwnerPublicId=${p.publicId}&clientId=${a.clientId}"
        assertEquals(HttpStatusCode.Unauthorized, client.get(path).status)
        val read = client.get(path) { cookie(config.cookieName, p.raw) }
        assertEquals(HttpStatusCode.OK, read.status); assertEquals("no-store", read.headers[HttpHeaders.CacheControl])
        assertEquals(HttpStatusCode.BadRequest, client.get("$path&clientId=${a.clientId}") { cookie(config.cookieName, p.raw) }.status)
        assertEquals(HttpStatusCode.BadRequest, client.get("$path&extra=1") { cookie(config.cookieName, p.raw) }.status)
        suspend fun post(body: String, origin: String = "http://localhost") = client.post("/api/v1/world/forest-memory/commands") {
            cookie(config.cookieName, p.raw); header(HttpHeaders.Origin, origin); contentType(ContentType.Application.Json); setBody(body)
        }
        val body = forestMemoryJson.encodeToString(a)
        assertEquals(HttpStatusCode.Forbidden, post(body, "https://other.example").status)
        assertEquals(HttpStatusCode.BadRequest, post(body.dropLast(1) + ",\"sparks\":100}").status)
        assertEquals(HttpStatusCode.BadRequest, post(forestMemoryJson.encodeToString(a.copy(requestId = "bad"))).status)
        assertEquals(HttpStatusCode.BadRequest, post(body.replace("\"expectedRevision\":0", "\"expectedRevision\":\"0\"")).status)
        assertEquals(HttpStatusCode.BadRequest, post(body.replace("\"takeover\":false", "\"takeover\":\"false\"")).status)
        assertEquals(HttpStatusCode.PayloadTooLarge, post(" ".repeat(65_537) + body).status)
        assertEquals(HttpStatusCode.OK, post(body).status)
    }
}
