package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.config.AppConfig
import ru.zhiv.identity.PublicIdGenerator
import ru.zhiv.relationships.RelationshipResult
import ru.zhiv.relationships.RequestAction
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
class JdbcZhivRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)

    companion object {
        @Container
        private val postgres = Postgres("postgres:18-alpine")
    }

    private lateinit var dataSource: HikariDataSource
    private lateinit var repository: JdbcZhivRepository
    private val tokens = TokenCodec()

    @BeforeAll
    fun setUp() {
        dataSource = DatabaseFactory.create(
            AppConfig(
                databaseUrl = postgres.jdbcUrl,
                databaseUser = postgres.username,
                databasePassword = postgres.password,
                production = false,
                allowedOrigins = setOf("http://localhost"),
            ),
        )
        DatabaseFactory.migrate(dataSource)
        repository = JdbcZhivRepository(dataSource)
    }

    @AfterAll
    fun tearDown() {
        dataSource.close()
    }

    @Test
    fun `bootstrap retry keeps one identity and check-in is idempotent`() = runBlocking<Unit> {
        val bootstrapHash = tokens.hash(UUID.randomUUID().toString())
        val firstSession = tokens.issue()
        val firstUser = repository.bootstrap("Дима", bootstrapHash, firstSession.hash, 365)

        val secondSession = tokens.issue()
        val replayedUser = repository.bootstrap("Другое имя", bootstrapHash, secondSession.hash, 365)
        assertEquals(firstUser.id, replayedUser.id)
        assertEquals("Дима", replayedUser.displayName)

        dataSource.connection.use { connection ->
            connection.prepareStatement("SELECT count(*) FROM app_users WHERE id = ?").use { statement ->
                statement.setObject(1, firstUser.id)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    assertEquals(1, result.getInt(1))
                }
            }
            connection.prepareStatement("SELECT count(*) FROM app_sessions WHERE user_id = ?").use { statement ->
                statement.setObject(1, firstUser.id)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    assertEquals(1, result.getInt(1))
                }
            }
        }

        assertIs<CheckInResult.Unauthorized>(
            repository.record(firstSession.hash, UUID.randomUUID()),
        )

        val eventKey = UUID.randomUUID()
        val accepted = assertIs<CheckInResult.Accepted>(
            repository.record(secondSession.hash, eventKey),
        )
        assertEquals(false, accepted.replayed)
        assertEquals(1, accepted.checkInCount)

        val replay = assertIs<CheckInResult.Accepted>(
            repository.record(secondSession.hash, eventKey),
        )
        assertTrue(replay.replayed)
        assertEquals(accepted.eventId, replay.eventId)
        assertEquals(accepted.checkInCount, replay.checkInCount)

        assertIs<CheckInResult.Cooldown>(
            repository.record(secondSession.hash, UUID.randomUUID()),
        )
    }

    @Test
    fun `relationship guards reject identity rewrites and overlapping memberships`() {
        val firstUser = UUID.randomUUID()
        val secondUser = UUID.randomUUID()
        val thirdUser = UUID.randomUUID()
        val directCircle = UUID.randomUUID()
        val groupCircle = UUID.randomUUID()
        val publicIds = PublicIdGenerator()

        dataSource.connection.use { connection ->
            try {
                connection.prepareStatement(
                    "INSERT INTO app_users (id, public_id, display_name) VALUES (?, ?, ?)",
                ).use { statement ->
                    listOf(firstUser, secondUser, thirdUser).forEachIndexed { index, userId ->
                        statement.setObject(1, userId)
                        statement.setString(2, publicIds.next())
                        statement.setString(3, "User ${index + 1}")
                        statement.addBatch()
                    }
                    statement.executeBatch()
                }
                connection.prepareStatement(
                    """
                    INSERT INTO circles (
                        id, kind, title, created_by_user_id,
                        direct_user_low_id, direct_user_high_id
                    )
                    VALUES (?, 'DIRECT', NULL, ?, LEAST(?, ?), GREATEST(?, ?))
                    """.trimIndent(),
                ).use { statement ->
                    statement.setObject(1, directCircle)
                    statement.setObject(2, firstUser)
                    statement.setObject(3, firstUser)
                    statement.setObject(4, secondUser)
                    statement.setObject(5, firstUser)
                    statement.setObject(6, secondUser)
                    statement.executeUpdate()
                }
                connection.prepareStatement(
                    """
                    INSERT INTO circles (id, kind, title, created_by_user_id)
                    VALUES (?, 'GROUP', 'Test group', ?)
                    """.trimIndent(),
                ).use { statement ->
                    statement.setObject(1, groupCircle)
                    statement.setObject(2, firstUser)
                    statement.executeUpdate()
                }
                connection.prepareStatement(
                    """
                    INSERT INTO circle_memberships (
                        circle_id, user_id, role, joined_at
                    )
                    VALUES (?, ?, 'OWNER', clock_timestamp() - interval '2 days')
                    """.trimIndent(),
                ).use { statement ->
                    statement.setObject(1, groupCircle)
                    statement.setObject(2, firstUser)
                    statement.executeUpdate()
                }
                connection.commit()
            } catch (error: Throwable) {
                connection.rollback()
                throw error
            }
        }

        val identityRewrite = assertFailsWith<SQLException> {
            dataSource.connection.use { connection ->
                connection.prepareStatement(
                    """
                    UPDATE circles
                       SET direct_user_low_id = LEAST(?, ?),
                           direct_user_high_id = GREATEST(?, ?)
                     WHERE id = ?
                    """.trimIndent(),
                ).use { statement ->
                    statement.setObject(1, firstUser)
                    statement.setObject(2, thirdUser)
                    statement.setObject(3, firstUser)
                    statement.setObject(4, thirdUser)
                    statement.setObject(5, directCircle)
                    statement.executeUpdate()
                }
                connection.commit()
            }
        }
        assertEquals("55000", identityRewrite.sqlState)

        val overlap = assertFailsWith<SQLException> {
            dataSource.connection.use { connection ->
                connection.prepareStatement(
                    """
                    INSERT INTO circle_memberships (
                        circle_id, user_id, role, joined_at, left_at
                    )
                    VALUES (
                        ?, ?, 'MEMBER',
                        clock_timestamp() - interval '36 hours',
                        clock_timestamp() - interval '12 hours'
                    )
                    """.trimIndent(),
                ).use { statement ->
                    statement.setObject(1, groupCircle)
                    statement.setObject(2, firstUser)
                    statement.executeUpdate()
                }
                connection.commit()
            }
        }
        assertEquals("23P01", overlap.sqlState)
    }

    @Test
    fun `direct sharing exposes only audience snapshots from the active sharing period`() = runBlocking {
        val relationships = JdbcRelationshipRepository(dataSource)
        val dimaSession = tokens.issue()
        val mamaSession = tokens.issue()
        val dima = repository.bootstrap(
            "Дима privacy",
            tokens.hash(UUID.randomUUID().toString()),
            dimaSession.hash,
            365,
        )
        val mama = repository.bootstrap(
            "Мама privacy",
            tokens.hash(UUID.randomUUID().toString()),
            mamaSession.hash,
            365,
        )

        assertIs<CheckInResult.Accepted>(
            repository.record(dimaSession.hash, UUID.randomUUID()),
        )

        val request = assertIs<RelationshipResult.Success<*>>(
            relationships.sendRequest(dimaSession.hash, mama.publicId, UUID.randomUUID()),
        ).value as ru.zhiv.relationships.DirectRequestMutationSnapshot
        val accepted = assertIs<RelationshipResult.Success<*>>(
            relationships.actOnRequest(
                mamaSession.hash,
                request.request.requestId,
                RequestAction.ACCEPTED,
            ),
        ).value as ru.zhiv.relationships.DirectRequestActionSnapshot
        val circleId = requireNotNull(accepted.person).circleId
        assertEquals(null, accepted.person.lastCheckInAt)

        val mamaMark = assertIs<CheckInResult.Accepted>(
            repository.record(mamaSession.hash, UUID.randomUUID()),
        )
        val visible = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(dimaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        assertEquals(mamaMark.checkedAt, visible.people.single().lastCheckInAt)

        assertIs<RelationshipResult.Success<*>>(
            relationships.updateSharing(mamaSession.hash, circleId, SharingMode.OFF),
        )
        val hidden = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(dimaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        assertEquals(null, hidden.people.single().lastCheckInAt)

        assertIs<RelationshipResult.Success<*>>(
            relationships.updateSharing(mamaSession.hash, circleId, SharingMode.LATEST_ONLY),
        )
        val reenabled = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(dimaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        assertEquals(null, reenabled.people.single().lastCheckInAt)

        assertIs<RelationshipResult.Success<*>>(
            relationships.removePerson(dimaSession.hash, circleId),
        )
        val removed = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(mamaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        assertTrue(removed.people.isEmpty())
    }
}
