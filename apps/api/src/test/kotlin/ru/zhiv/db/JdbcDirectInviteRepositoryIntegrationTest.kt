package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.config.AppConfig
import ru.zhiv.invites.DirectInviteRedeemSnapshot
import ru.zhiv.invites.DirectInviteResult
import ru.zhiv.relationships.PersonCheckInState
import ru.zhiv.relationships.RelationshipResult
import ru.zhiv.relationships.SharingMode
import ru.zhiv.security.TokenCodec
import java.sql.SQLException
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcDirectInviteRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object {
        @Container
        private val postgres = Postgres("postgres:18-alpine")
    }

    private lateinit var dataSource: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var invites: JdbcDirectInviteRepository
    private lateinit var relationships: JdbcRelationshipRepository
    private val tokens = TokenCodec()
    private val legacyToken = tokens.issue().hash
    private val legacyRecipientSession = tokens.issue().hash
    private val legacyKey = UUID.randomUUID()
    private val legacyCircle = UUID.randomUUID()
    private val legacyInvite = UUID.randomUUID()

    @BeforeAll
    fun setUp() {
        dataSource = DatabaseFactory.create(AppConfig(
            databaseUrl = postgres.jdbcUrl, databaseUser = postgres.username,
            databasePassword = postgres.password, production = false,
            allowedOrigins = setOf("http://localhost"),
        ))
        // Exercise the upgrade with real 0.5.2 consumed data, not only an empty schema.
        Flyway.configure().dataSource(dataSource).locations("classpath:db/migration")
            .target("17").cleanDisabled(true).load().migrate()
        val inviter = UUID.randomUUID()
        val recipient = UUID.randomUUID()
        update("INSERT INTO app_users(id,public_id,display_name) VALUES (?,'1111-1111-1111','Legacy inviter'),(?,'2222-2222-2222','Legacy recipient')", inviter, recipient)
        update("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 day')", recipient, legacyRecipientSession)
        update("INSERT INTO circles(id,kind,created_by_user_id,direct_user_low_id,direct_user_high_id) VALUES (?,'DIRECT',?,LEAST(?::uuid,?::uuid),GREATEST(?::uuid,?::uuid))", legacyCircle, inviter, inviter, recipient, inviter, recipient)
        update("INSERT INTO circle_sharing_preferences(circle_id,user_id,sharing_mode) VALUES (?,?,'LATEST_ONLY'),(?,?,'LATEST_ONLY')", legacyCircle, inviter, legacyCircle, recipient)
        update("""WITH stamp AS (SELECT clock_timestamp() AS now)
            INSERT INTO direct_invite_links(id,inviter_user_id,token_hash,idempotency_key,status,
                accepted_by_user_id,accepted_idempotency_key,result_circle_id,result_circle_kind,created_at,expires_at,accepted_at)
            SELECT ?,?,?,?,'ACCEPTED',?,?,?,'DIRECT',stamp.now,stamp.now+interval '7 days',stamp.now FROM stamp""",
            legacyInvite, inviter, legacyToken, UUID.randomUUID(), recipient, legacyKey, legacyCircle)
        DatabaseFactory.migrate(dataSource)
        identities = JdbcZhivRepository(dataSource)
        invites = JdbcDirectInviteRepository(dataSource)
        relationships = JdbcRelationshipRepository(dataSource)
    }

    @AfterAll
    fun tearDown() = dataSource.close()

    private suspend fun identity(name: String): ByteArray {
        val session = tokens.issue().hash
        identities.bootstrap(name, tokens.issue().hash, session, 365)
        return session
    }

    private fun accepted(result: DirectInviteResult<DirectInviteRedeemSnapshot>): DirectInviteRedeemSnapshot =
        assertIs<DirectInviteResult.Success<DirectInviteRedeemSnapshot>>(result).value

    private fun update(sql: String, vararg parameters: Any?) = dataSource.connection.use { connection ->
        connection.prepareStatement(sql).use { statement ->
            parameters.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
            statement.executeUpdate()
        }.also { connection.commit() }
    }

    private fun scalar(sql: String, vararg parameters: Any?): String = dataSource.connection.use { connection ->
        connection.prepareStatement(sql).use { statement ->
            parameters.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
            statement.executeQuery().use { result -> check(result.next()); result.getString(1) }
        }
    }

    @Test
    fun `upgrade retains consumed links as terminal but preserves their exact replay`() = runBlocking<Unit> {
        assertEquals("ACCEPTED", scalar("SELECT status FROM direct_invite_links WHERE id=?", legacyInvite))
        assertEquals("1", scalar("SELECT count(*) FROM direct_invite_redemptions WHERE invite_id=?", legacyInvite))
        assertIs<DirectInviteResult.Expired>(invites.preview(legacyToken))
        val replay = accepted(invites.redeem(legacyRecipientSession, legacyToken, legacyKey))
        assertTrue(replay.replayed)
        assertEquals(legacyCircle, replay.person.circleId)
        assertIs<DirectInviteResult.Expired>(invites.redeem(identity("Legacy outsider"), legacyToken, UUID.randomUUID()))
    }

    @Test
    fun `one link concurrently admits distinct recipients and exact retries only once with no old audience`() = runBlocking<Unit> {
        val inviter = identity("Reusable inviter")
        val first = identity("First recipient")
        val second = identity("Second recipient")
        val oldEvent = assertIs<CheckInResult.Accepted>(identities.record(inviter, UUID.randomUUID()))
        val token = tokens.issue().hash
        assertIs<DirectInviteResult.Success<*>>(invites.create(inviter, token, UUID.randomUUID()))
        val key = UUID.randomUUID()
        val results = withTimeout(15_000) {
            coroutineScope {
                listOf(async { accepted(invites.redeem(first, token, key)) },
                    async { accepted(invites.redeem(first, token, key)) },
                    async { accepted(invites.redeem(second, token, key)) }).awaitAll()
            }
        }
        assertEquals(listOf(false, true), results.take(2).map { it.replayed }.sorted())
        assertEquals(results[0].person.circleId, results[1].person.circleId)
        assertTrue(results[0].person.circleId != results[2].person.circleId)
        assertEquals(false, results[2].replayed)
        results.forEach {
            assertEquals(null, it.person.lastCheckInAt)
            assertEquals(PersonCheckInState.WAITING_INITIAL, it.person.checkInState)
        }
        assertEquals("0", scalar("SELECT count(*) FROM check_in_audiences WHERE check_in_id=?", oldEvent.eventId))
        assertEquals("2", scalar("SELECT count(*) FROM direct_invite_redemptions WHERE invite_id=(SELECT id FROM direct_invite_links WHERE token_hash=?)", token))
        assertEquals("PENDING", scalar("SELECT status FROM direct_invite_links WHERE token_hash=?", token))
        assertIs<DirectInviteResult.Success<*>>(invites.preview(token))
        assertIs<DirectInviteResult.Self>(invites.redeem(inviter, token, UUID.randomUUID()))
        assertIs<DirectInviteResult.Conflict>(invites.redeem(first, token, UUID.randomUUID()))
    }

    @Test
    fun `rotation preserves exact results and removed relationships cannot be recreated by old receipts`() = runBlocking<Unit> {
        val inviter = identity("Rotate inviter")
        val recipient = identity("Rotate recipient")
        val stranger = identity("Rotate stranger")
        val oldToken = tokens.issue().hash
        assertIs<DirectInviteResult.Success<*>>(invites.create(inviter, oldToken, UUID.randomUUID()))
        val key = UUID.randomUUID()
        val first = accepted(invites.redeem(recipient, oldToken, key))
        assertIs<RelationshipResult.Success<*>>(relationships.updateSharing(inviter, first.person.circleId, SharingMode.OFF))
        val replay = accepted(invites.redeem(recipient, oldToken, key))
        assertEquals(SharingMode.OFF, replay.person.theirSharingMode)
        val freshToken = tokens.issue().hash
        assertIs<DirectInviteResult.Success<*>>(invites.create(inviter, freshToken, UUID.randomUUID()))
        assertIs<DirectInviteResult.Expired>(invites.preview(oldToken))
        assertIs<DirectInviteResult.Expired>(invites.redeem(stranger, oldToken, UUID.randomUUID()))
        assertTrue(accepted(invites.redeem(recipient, oldToken, key)).replayed)
        assertIs<DirectInviteResult.Conflict>(invites.redeem(recipient, freshToken, key))
        assertIs<RelationshipResult.Success<*>>(relationships.removePerson(inviter, first.person.circleId))
        assertIs<DirectInviteResult.Conflict>(invites.redeem(recipient, oldToken, key))
        assertIs<DirectInviteResult.Conflict>(invites.redeem(recipient, oldToken, UUID.randomUUID()))
        assertEquals("0", scalar("""SELECT count(*) FROM circles c JOIN circles old ON old.id=?
            WHERE c.kind='DIRECT' AND c.archived_at IS NULL
              AND c.direct_user_low_id=old.direct_user_low_id AND c.direct_user_high_id=old.direct_user_high_id""", first.person.circleId))
        val fresh = accepted(invites.redeem(recipient, freshToken, UUID.randomUUID()))
        assertTrue(fresh.person.circleId != first.person.circleId)
        assertEquals(null, fresh.person.lastCheckInAt)
    }

    @Test
    fun `database rejects mutable receipts mismatched circles and archive timestamps before consent`() = runBlocking<Unit> {
        val inviter = identity("Guard inviter")
        val first = identity("Guard recipient")
        val other = identity("Guard other")
        val token = tokens.issue().hash
        assertIs<DirectInviteResult.Success<*>>(invites.create(inviter, token, UUID.randomUUID()))
        val result = accepted(invites.redeem(first, token, UUID.randomUUID()))
        val otherId = identities.findBySession(other)!!.id
        val mismatched = assertFailsWith<SQLException> {
            update("""INSERT INTO direct_invite_redemptions(invite_id,recipient_user_id,idempotency_key,circle_id)
                SELECT id,?,?,? FROM direct_invite_links WHERE token_hash=?""", otherId, UUID.randomUUID(), result.person.circleId, token)
        }
        assertEquals("23514", mismatched.sqlState)
        val mutation = assertFailsWith<SQLException> {
            update("UPDATE direct_invite_redemptions SET idempotency_key=? WHERE circle_id=?", UUID.randomUUID(), result.person.circleId)
        }
        assertEquals("55000", mutation.sqlState)
        val deletion = assertFailsWith<SQLException> {
            update("DELETE FROM direct_invite_redemptions WHERE circle_id=?", result.person.circleId)
        }
        assertEquals("55000", deletion.sqlState)
        val backdate = assertFailsWith<SQLException> {
            update("UPDATE circles SET archived_at=(SELECT accepted_at FROM direct_invite_redemptions WHERE circle_id=?) WHERE id=?", result.person.circleId, result.person.circleId)
        }
        assertEquals("23514", backdate.sqlState)
    }
}
