package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.config.AppConfig
import ru.zhiv.groups.GroupInviteAction
import ru.zhiv.groups.GroupMutationSnapshot
import ru.zhiv.groups.GroupResult
import ru.zhiv.groups.GroupsSnapshot
import ru.zhiv.identity.PublicIdGenerator
import ru.zhiv.identity.DisplayNameUpdateResult
import ru.zhiv.invites.DirectInviteLinkSnapshot
import ru.zhiv.invites.DirectInvitePreviewSnapshot
import ru.zhiv.invites.DirectInviteRedeemSnapshot
import ru.zhiv.invites.DirectInviteResult
import ru.zhiv.recovery.RecoveryApprovalPreviewSnapshot
import ru.zhiv.recovery.RecoveryAttemptSnapshot
import ru.zhiv.recovery.RecoveryAttemptStatus
import ru.zhiv.recovery.RecoveryCompletionSnapshot
import ru.zhiv.recovery.RecoveryContactsSnapshot
import ru.zhiv.recovery.RecoveryResult
import ru.zhiv.relationships.RelationshipResult
import ru.zhiv.relationships.PersonCheckInState
import ru.zhiv.relationships.RequestAction
import ru.zhiv.relationships.SharingMode
import ru.zhiv.security.TokenCodec
import java.sql.Connection
import java.sql.SQLException
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
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
        assertEquals(1, accepted.streak.currentDays)
        assertTrue(accepted.streak.isActive)
        assertEquals(accepted.checkedAt.plusHours(24).toInstant(), accepted.streak.renewBy?.toInstant())

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
    fun `profile rename keeps identity stable and enforces a rolling cooldown`() = runBlocking<Unit> {
        val session = tokens.issue()
        val original = repository.bootstrap(
            "Старое имя",
            tokens.hash(UUID.randomUUID().toString()),
            session.hash,
            365,
        )
        assertEquals(0, original.streak.currentDays)
        assertEquals(null, original.displayNameChangeAvailableAt)

        val renamed = assertIs<DisplayNameUpdateResult.Success>(
            repository.updateDisplayName(session.hash, "Новое имя", UUID.randomUUID()),
        ).user
        assertEquals(original.id, renamed.id)
        assertEquals(original.publicId, renamed.publicId)
        assertEquals("Новое имя", renamed.displayName)
        assertNotNull(renamed.displayNameChangedAt)
        assertNotNull(renamed.displayNameChangeAvailableAt)

        val cooldown = assertIs<DisplayNameUpdateResult.Cooldown>(
            repository.updateDisplayName(session.hash, "Ещё одно имя", UUID.randomUUID()),
        )
        assertTrue(cooldown.availableAt.isAfter(cooldown.serverTime))

        val noOp = assertIs<DisplayNameUpdateResult.Success>(
            repository.updateDisplayName(session.hash, "Новое имя", UUID.randomUUID()),
        ).user
        assertEquals(renamed.displayNameChangedAt, noOp.displayNameChangedAt)

        dataSource.connection.use { connection ->
            connection.prepareStatement(
                "SELECT avatar_storage_key, avatar_updated_at FROM app_users WHERE id = ?",
            ).use { statement ->
                statement.setObject(1, original.id)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    assertEquals(null, result.getString("avatar_storage_key"))
                    assertEquals(null, result.getObject("avatar_updated_at"))
                }
            }
        }
    }

    @Test
    fun `rolling streak uses only server time and expires after 24 hours`() = runBlocking<Unit> {
        val session = tokens.issue()
        val user = repository.bootstrap(
            "Стрик",
            tokens.hash(UUID.randomUUID().toString()),
            session.hash,
            365,
        )
        val sessionId = dataSource.connection.use { connection ->
            connection.prepareStatement("SELECT id FROM app_sessions WHERE user_id = ?").use { statement ->
                statement.setObject(1, user.id)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    result.getObject(1, UUID::class.java)
                }
            }
        }

        val checkedAt = listOf(
            "2026-01-01T10:00:00Z",
            "2026-01-01T11:00:00Z",
            "2026-01-02T10:00:00Z",
            "2026-01-04T10:00:00Z",
            "2026-01-05T10:00:00Z",
        ).map(OffsetDateTime::parse)
        dataSource.connection.use { connection ->
            connection.prepareStatement(
                """
                INSERT INTO check_ins (
                    user_id, session_id, idempotency_key, checked_at,
                    next_allowed_at, timezone_id, local_date
                ) VALUES (?, ?, ?, ?, ?, 'UTC', (? AT TIME ZONE 'UTC')::date)
                """.trimIndent(),
            ).use { statement ->
                checkedAt.forEach { instant ->
                    statement.setObject(1, user.id)
                    statement.setObject(2, sessionId)
                    statement.setObject(3, UUID.randomUUID())
                    statement.setObject(4, instant)
                    statement.setObject(5, instant.plusSeconds(30))
                    statement.setObject(6, instant)
                    statement.addBatch()
                }
                statement.executeBatch()
            }
            connection.commit()
        }

        val current = loadSqlStreak(user.id, OffsetDateTime.parse("2026-01-05T12:00:00Z"))
        assertEquals(2, current.currentDays)
        assertEquals(2, current.longestDays)
        assertTrue(current.isActive)
        assertEquals(
            OffsetDateTime.parse("2026-01-06T10:00:00Z").toInstant(),
            current.renewBy?.toInstant(),
        )

        val boundary = loadSqlStreak(user.id, OffsetDateTime.parse("2026-01-06T10:00:00Z"))
        assertEquals(2, boundary.currentDays)
        assertTrue(boundary.isActive)

        val broken = loadSqlStreak(user.id, OffsetDateTime.parse("2026-01-06T10:00:00.001Z"))
        assertEquals(0, broken.currentDays)
        assertEquals(2, broken.longestDays)
        assertEquals(false, broken.isActive)
        assertEquals(null, broken.renewBy)
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

        val ownLookup = assertIs<RelationshipResult.Success<*>>(
            relationships.lookup(dimaSession.hash, dima.publicId),
        ).value as ru.zhiv.relationships.UserLookupSnapshot
        assertEquals(ru.zhiv.relationships.RelationshipState.SELF, ownLookup.relationshipState)
        assertIs<RelationshipResult.Success<*>>(relationships.listPeople(dimaSession.hash))

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
        assertEquals(PersonCheckInState.WAITING_INITIAL, accepted.person.checkInState)

        val mamaMark = assertIs<CheckInResult.Accepted>(
            repository.record(mamaSession.hash, UUID.randomUUID()),
        )
        val visible = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(dimaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        assertEquals(mamaMark.checkedAt, visible.people.single().lastCheckInAt)
        assertEquals(PersonCheckInState.AVAILABLE, visible.people.single().checkInState)

        assertIs<RelationshipResult.Success<*>>(
            relationships.updateSharing(mamaSession.hash, circleId, SharingMode.OFF),
        )
        val hidden = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(dimaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        assertEquals(null, hidden.people.single().lastCheckInAt)
        assertEquals(PersonCheckInState.HIDDEN, hidden.people.single().checkInState)

        assertIs<RelationshipResult.Success<*>>(
            relationships.updateSharing(mamaSession.hash, circleId, SharingMode.LATEST_ONLY),
        )
        val reenabled = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(dimaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        assertEquals(null, reenabled.people.single().lastCheckInAt)
        assertEquals(
            PersonCheckInState.WAITING_AFTER_REENABLE,
            reenabled.people.single().checkInState,
        )

        val dedSession = tokens.issue()
        val ded = repository.bootstrap(
            "Дед privacy",
            tokens.hash(UUID.randomUUID().toString()),
            dedSession.hash,
            365,
        )
        val dedRequest = assertIs<RelationshipResult.Success<*>>(
            relationships.sendRequest(dimaSession.hash, ded.publicId, UUID.randomUUID()),
        ).value as ru.zhiv.relationships.DirectRequestMutationSnapshot
        val dedAccepted = assertIs<RelationshipResult.Success<*>>(
            relationships.actOnRequest(
                dedSession.hash,
                dedRequest.request.requestId,
                RequestAction.ACCEPTED,
            ),
        ).value as ru.zhiv.relationships.DirectRequestActionSnapshot
        val dedCircleId = requireNotNull(dedAccepted.person).circleId

        assertIs<RelationshipResult.Success<*>>(
            relationships.updateSharing(dedSession.hash, dedCircleId, SharingMode.OFF),
        )
        assertIs<RelationshipResult.Success<*>>(
            relationships.updateSharing(dedSession.hash, dedCircleId, SharingMode.LATEST_ONLY),
        )
        val dedWaiting = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(dimaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        assertEquals(
            PersonCheckInState.WAITING_AFTER_REENABLE,
            dedWaiting.people.single { it.circleId == dedCircleId }.checkInState,
        )

        val dedMark = assertIs<CheckInResult.Accepted>(
            repository.record(dedSession.hash, UUID.randomUUID()),
        )
        val dedVisible = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(dimaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        val visibleDed = dedVisible.people.single { it.circleId == dedCircleId }
        assertEquals(PersonCheckInState.AVAILABLE, visibleDed.checkInState)
        assertEquals(dedMark.checkedAt, visibleDed.lastCheckInAt)

        assertIs<RelationshipResult.Success<*>>(
            relationships.removePerson(dimaSession.hash, circleId),
        )
        val removed = assertIs<RelationshipResult.Success<*>>(
            relationships.listPeople(mamaSession.hash),
        ).value as ru.zhiv.relationships.PeopleSnapshot
        assertTrue(removed.people.isEmpty())
    }

    @Test
    fun `recovery contact removal key is owner scoped and bound to one contact`() = runBlocking {
        val relationships = JdbcRelationshipRepository(dataSource)
        val recovery = JdbcRecoveryRepository(dataSource)
        val ownerSession = tokens.issue()
        val firstFriendSession = tokens.issue()
        val secondFriendSession = tokens.issue()
        val owner = repository.bootstrap(
            "Recovery removal owner",
            tokens.hash(UUID.randomUUID().toString()),
            ownerSession.hash,
            365,
        )
        val firstFriend = repository.bootstrap(
            "Recovery removal first friend",
            tokens.hash(UUID.randomUUID().toString()),
            firstFriendSession.hash,
            365,
        )
        val secondFriend = repository.bootstrap(
            "Recovery removal second friend",
            tokens.hash(UUID.randomUUID().toString()),
            secondFriendSession.hash,
            365,
        )
        val firstCircleId = connectDirect(
            relationships,
            ownerSession.hash,
            firstFriendSession.hash,
            firstFriend.publicId,
        )
        val secondCircleId = connectDirect(
            relationships,
            ownerSession.hash,
            secondFriendSession.hash,
            secondFriend.publicId,
        )
        val firstContact = (assertIs<RecoveryResult.Success<*>>(
            recovery.add(ownerSession.hash, firstCircleId, UUID.randomUUID()),
        ).value as RecoveryContactsSnapshot).contacts.single()
        val secondContact = (assertIs<RecoveryResult.Success<*>>(
            recovery.add(ownerSession.hash, secondCircleId, UUID.randomUUID()),
        ).value as RecoveryContactsSnapshot).contacts.single { it.user.publicId == secondFriend.publicId }
        val removalKey = UUID.randomUUID()

        val removed = assertIs<RecoveryResult.Success<*>>(
            recovery.remove(ownerSession.hash, firstContact.contactId, removalKey),
        ).value as RecoveryContactsSnapshot
        assertEquals(setOf(secondContact.contactId), removed.contacts.map { it.contactId }.toSet())
        val replayed = assertIs<RecoveryResult.Success<*>>(
            recovery.remove(ownerSession.hash, firstContact.contactId, removalKey),
        ).value as RecoveryContactsSnapshot
        assertEquals(setOf(secondContact.contactId), replayed.contacts.map { it.contactId }.toSet())
        assertIs<RecoveryResult.Conflict>(
            recovery.remove(ownerSession.hash, secondContact.contactId, removalKey),
        )

        val finalContacts = assertIs<RecoveryResult.Success<*>>(
            recovery.list(ownerSession.hash),
        ).value as RecoveryContactsSnapshot
        assertEquals(setOf(secondContact.contactId), finalContacts.contacts.map { it.contactId }.toSet())
        dataSource.connection.use { connection ->
            connection.prepareStatement(
                """SELECT contact_id FROM account_recovery_contact_removals
                    WHERE owner_user_id = ? AND idempotency_key = ?""",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.setObject(2, removalKey)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    assertEquals(firstContact.contactId, result.getObject(1, UUID::class.java))
                    assertEquals(false, result.next())
                }
            }
        }
    }

    @Test
    fun `recovery contact trigger serializes the three contact limit`() = runBlocking {
        val relationships = JdbcRelationshipRepository(dataSource)
        val recovery = JdbcRecoveryRepository(dataSource)
        val ownerSession = tokens.issue()
        val owner = repository.bootstrap(
            "Recovery limit owner",
            tokens.hash(UUID.randomUUID().toString()),
            ownerSession.hash,
            365,
        )
        val friendSessions = List(4) { tokens.issue() }
        val friends = friendSessions.mapIndexed { index, session ->
            repository.bootstrap(
                "Recovery limit friend ${index + 1}",
                tokens.hash(UUID.randomUUID().toString()),
                session.hash,
                365,
            )
        }
        val circleIds = friends.mapIndexed { index, friend ->
            connectDirect(
                relationships,
                ownerSession.hash,
                friendSessions[index].hash,
                friend.publicId,
            )
        }
        for (index in 0..1) {
            assertIs<RecoveryResult.Success<*>>(
                recovery.add(ownerSession.hash, circleIds[index], UUID.randomUUID()),
            )
        }

        val ready = CountDownLatch(2)
        suspend fun insertCandidate(index: Int): String = withContext(Dispatchers.IO) {
            dataSource.connection.use { connection ->
                ready.countDown()
                check(ready.await(5, TimeUnit.SECONDS)) { "recovery contact insert barrier timed out" }
                try {
                    connection.prepareStatement(
                        """INSERT INTO account_recovery_contacts
                               (owner_user_id, trustee_user_id, direct_circle_id, idempotency_key)
                             VALUES (?, ?, ?, ?)""",
                    ).use { statement ->
                        statement.setObject(1, owner.id)
                        statement.setObject(2, friends[index].id)
                        statement.setObject(3, circleIds[index])
                        statement.setObject(4, UUID.randomUUID())
                        check(statement.executeUpdate() == 1)
                    }
                    connection.commit()
                    "SUCCESS"
                } catch (error: SQLException) {
                    connection.rollback()
                    error.sqlState ?: "UNKNOWN"
                }
            }
        }

        val outcomes = withTimeout(15_000) {
            coroutineScope {
                listOf(
                    async { insertCandidate(2) },
                    async { insertCandidate(3) },
                ).awaitAll()
            }
        }
        assertEquals(1, outcomes.count { it == "SUCCESS" })
        assertEquals(listOf("23514"), outcomes.filterNot { it == "SUCCESS" })
        dataSource.connection.use { connection ->
            connection.prepareStatement(
                """SELECT count(*) FROM account_recovery_contacts
                    WHERE owner_user_id = ? AND revoked_at IS NULL""",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    assertEquals(3, result.getInt(1))
                }
            }
        }
    }

    @Test
    fun `recovery completion invalidates authenticated mutations already waiting on the user lock`() = runBlocking {
        val relationships = JdbcRelationshipRepository(dataSource)
        val recovery = JdbcRecoveryRepository(dataSource)
        val invites = JdbcDirectInviteRepository(dataSource)
        val groups = JdbcGroupRepository(dataSource)
        val ownerSession = tokens.issue()
        val friendSession = tokens.issue()
        val attackerSession = tokens.issue()
        val strangerSession = tokens.issue()
        val owner = repository.bootstrap(
            "Stale session owner",
            tokens.hash(UUID.randomUUID().toString()),
            ownerSession.hash,
            365,
        )
        val friend = repository.bootstrap(
            "Stale session recovery friend",
            tokens.hash(UUID.randomUUID().toString()),
            friendSession.hash,
            365,
        )
        val attacker = repository.bootstrap(
            "Stale session contact candidate",
            tokens.hash(UUID.randomUUID().toString()),
            attackerSession.hash,
            365,
        )
        val stranger = repository.bootstrap(
            "Stale session request target",
            tokens.hash(UUID.randomUUID().toString()),
            strangerSession.hash,
            365,
        )
        val recoveryCircleId = connectDirect(
            relationships,
            ownerSession.hash,
            friendSession.hash,
            friend.publicId,
        )
        val attackerCircleId = connectDirect(
            relationships,
            ownerSession.hash,
            attackerSession.hash,
            attacker.publicId,
        )
        val recoveryContact = (assertIs<RecoveryResult.Success<*>>(
            recovery.add(ownerSession.hash, recoveryCircleId, UUID.randomUUID()),
        ).value as RecoveryContactsSnapshot).contacts.single()
        val approval = tokens.issue()
        val claim = tokens.issue()
        assertIs<RecoveryResult.Success<*>>(
            recovery.createAttempt(approval.hash, claim.hash, UUID.randomUUID(), null),
        )
        assertIs<RecoveryResult.Success<*>>(
            recovery.confirmApproval(
                friendSession.hash,
                approval.hash,
                recoveryContact.contactId,
                UUID.randomUUID(),
            ),
        )
        val completionKey = UUID.randomUUID()
        val contactKey = UUID.randomUUID()
        val inviteKey = UUID.randomUUID()
        val requestKey = UUID.randomUUID()
        val groupKey = UUID.randomUUID()
        val checkInKey = UUID.randomUUID()
        val renameKey = UUID.randomUUID()
        val inviteToken = tokens.issue()

        suspend fun awaitLockWaiters(connection: Connection, minimum: Int) {
            withTimeout(10_000) {
                while (true) {
                    val count = connection.prepareStatement(
                        """SELECT count(*) FROM pg_stat_activity
                            WHERE datname = current_database()
                              AND application_name = 'zhiv-api'
                              AND wait_event_type = 'Lock'""",
                    ).use { statement ->
                        statement.executeQuery().use { result ->
                            check(result.next())
                            result.getInt(1)
                        }
                    }
                    if (count >= minimum) return@withTimeout
                    delay(20)
                }
            }
        }

        suspend fun runCompletionRace(
            claimTokenHash: ByteArray,
            key: UUID,
            staleOperations: List<suspend () -> Any>,
        ): Pair<RecoveryResult<RecoveryCompletionSnapshot>, List<Any>> {
            val blocker = dataSource.connection
            return try {
                blocker.prepareStatement("SELECT id FROM app_users WHERE id = ? FOR UPDATE").use { statement ->
                    statement.setObject(1, owner.id)
                    statement.executeQuery().use { result -> assertTrue(result.next()) }
                }
                val baselineWaiters = blocker.prepareStatement(
                    """SELECT count(*) FROM pg_stat_activity
                        WHERE datname = current_database()
                          AND application_name = 'zhiv-api'
                          AND wait_event_type = 'Lock'""",
                ).use { statement ->
                    statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
                }
                coroutineScope {
                    val completion = async {
                        recovery.completeAttempt(claimTokenHash, key, 365)
                    }
                    var blockerReleased = false
                    fun releaseBlocker() {
                        if (!blockerReleased) {
                            blocker.commit()
                            blockerReleased = true
                        }
                    }
                    try {
                        awaitLockWaiters(blocker, baselineWaiters + 1)
                        val stale = staleOperations.map { operation -> async { operation() } }
                        awaitLockWaiters(blocker, baselineWaiters + 1 + stale.size)
                        releaseBlocker()
                        completion.await() to stale.awaitAll()
                    } finally {
                        releaseBlocker()
                    }
                }
            } finally {
                runCatching { blocker.rollback() }
                blocker.close()
            }
        }

        val firstRace = runCompletionRace(
            claim.hash,
            completionKey,
            listOf(
                { recovery.add(ownerSession.hash, attackerCircleId, contactKey) },
                { invites.create(ownerSession.hash, inviteToken.hash, inviteKey) },
                { relationships.sendRequest(ownerSession.hash, stranger.publicId, requestKey) },
            ),
        )
        assertIs<RecoveryResult.Success<*>>(firstRace.first)
        assertIs<RecoveryResult.Unauthorized>(firstRace.second[0])
        assertIs<DirectInviteResult.Unauthorized>(firstRace.second[1])
        assertIs<RelationshipResult.Unauthorized>(firstRace.second[2])

        val secondApproval = tokens.issue()
        val secondClaim = tokens.issue()
        assertIs<RecoveryResult.Success<*>>(
            recovery.createAttempt(secondApproval.hash, secondClaim.hash, UUID.randomUUID(), null),
        )
        assertIs<RecoveryResult.Success<*>>(
            recovery.confirmApproval(
                friendSession.hash,
                secondApproval.hash,
                recoveryContact.contactId,
                UUID.randomUUID(),
            ),
        )
        val secondRace = runCompletionRace(
            secondClaim.hash,
            UUID.randomUUID(),
            listOf(
                {
                    groups.createGroup(
                        claim.hash,
                        "Stale session group",
                        null,
                        emptyList(),
                        groupKey,
                    )
                },
                { repository.record(claim.hash, checkInKey) },
                { repository.updateDisplayName(claim.hash, "Stale session rename", renameKey) },
            ),
        )
        assertIs<RecoveryResult.Success<*>>(secondRace.first)
        assertIs<GroupResult.Unauthorized>(secondRace.second[0])
        assertIs<CheckInResult.Unauthorized>(secondRace.second[1])
        assertIs<DisplayNameUpdateResult.Unauthorized>(secondRace.second[2])

        dataSource.connection.use { connection ->
            val contactCount = connection.prepareStatement(
                """SELECT count(*) FROM account_recovery_contacts
                    WHERE owner_user_id = ? AND trustee_user_id = ?""",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.setObject(2, attacker.id)
                statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
            }
            assertEquals(0, contactCount)
            val inviteCount = connection.prepareStatement(
                """SELECT count(*) FROM direct_invite_links
                    WHERE inviter_user_id = ? AND idempotency_key = ?""",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.setObject(2, inviteKey)
                statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
            }
            assertEquals(0, inviteCount)
            val requestCount = connection.prepareStatement(
                """SELECT count(*) FROM direct_requests
                    WHERE requester_user_id = ? AND idempotency_key = ?""",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.setObject(2, requestKey)
                statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
            }
            assertEquals(0, requestCount)
            val groupCount = connection.prepareStatement(
                """SELECT count(*) FROM circles
                    WHERE created_by_user_id = ? AND creation_idempotency_key = ?""",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.setObject(2, groupKey)
                statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
            }
            assertEquals(0, groupCount)
            val checkInCount = connection.prepareStatement(
                "SELECT count(*) FROM check_ins WHERE user_id = ? AND idempotency_key = ?",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.setObject(2, checkInKey)
                statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
            }
            assertEquals(0, checkInCount)
            val displayName = connection.prepareStatement(
                "SELECT display_name FROM app_users WHERE id = ?",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.executeQuery().use { result -> check(result.next()); result.getString(1) }
            }
            assertEquals("Stale session owner", displayName)
        }
        assertEquals(owner.id, repository.findBySession(secondClaim.hash)?.id)
        assertEquals(null, repository.findBySession(claim.hash))
        assertEquals(null, repository.findBySession(ownerSession.hash))
    }

    @Test
    fun `connected users can check in simultaneously without a foreign key deadlock`() = runBlocking {
        val relationships = JdbcRelationshipRepository(dataSource)
        val firstSession = tokens.issue()
        val secondSession = tokens.issue()
        val first = repository.bootstrap(
            "Concurrent check-in first",
            tokens.hash(UUID.randomUUID().toString()),
            firstSession.hash,
            365,
        )
        val second = repository.bootstrap(
            "Concurrent check-in second",
            tokens.hash(UUID.randomUUID().toString()),
            secondSession.hash,
            365,
        )
        connectDirect(
            relationships,
            firstSession.hash,
            secondSession.hash,
            second.publicId,
        )

        val results = withTimeout(15_000) {
            coroutineScope {
                listOf(
                    async { repository.record(firstSession.hash, UUID.randomUUID()) },
                    async { repository.record(secondSession.hash, UUID.randomUUID()) },
                ).awaitAll()
            }
        }
        val accepted = results.map { assertIs<CheckInResult.Accepted>(it) }
        assertEquals(setOf(first.id, second.id), setOf(
            repository.findBySession(firstSession.hash)?.id,
            repository.findBySession(secondSession.hash)?.id,
        ))
        assertTrue(accepted.all { it.checkInCount == 1L })
    }

    @Test
    fun `group invite and inverse user relationship removal share one lock order`() = runBlocking {
        val relationships = JdbcRelationshipRepository(dataSource)
        val groups = JdbcGroupRepository(dataSource)
        val inviteeSession = tokens.issue()
        val invitee = repository.bootstrap(
            "Lower UUID invitee",
            tokens.hash(UUID.randomUUID().toString()),
            inviteeSession.hash,
            365,
        )
        delay(3)
        val ownerSession = tokens.issue()
        val owner = repository.bootstrap(
            "Higher UUID owner",
            tokens.hash(UUID.randomUUID().toString()),
            ownerSession.hash,
            365,
        )
        assertTrue(invitee.id < owner.id, "the regression needs the invitee UUID before the owner UUID")
        val directCircleId = connectDirect(
            relationships,
            ownerSession.hash,
            inviteeSession.hash,
            invitee.publicId,
        )
        val group = assertIs<GroupResult.Success<*>>(
            groups.createGroup(
                ownerSession.hash,
                "Lock order group",
                null,
                emptyList(),
                UUID.randomUUID(),
            ),
        ).value as GroupMutationSnapshot

        val (invite, removal) = withTimeout(15_000) {
            coroutineScope {
                val inviteJob = async {
                    groups.inviteMember(
                        ownerSession.hash,
                        group.groupId,
                        directCircleId,
                        UUID.randomUUID(),
                    )
                }
                val removalJob = async {
                    relationships.removePerson(inviteeSession.hash, directCircleId)
                }
                inviteJob.await() to removalJob.await()
            }
        }
        assertTrue(
            invite is GroupResult.Success<*> || invite === GroupResult.Forbidden,
            "invite must serialize before or after the relationship removal",
        )
        assertIs<RelationshipResult.Success<*>>(removal)
    }

    @Test
    fun `removing a direct circle serializes with invite redeem`() = runBlocking {
        val relationships = JdbcRelationshipRepository(dataSource)
        val invites = JdbcDirectInviteRepository(dataSource)
        val inviterSession = tokens.issue()
        val recipientSession = tokens.issue()
        val inviter = repository.bootstrap(
            "Invite remove inviter",
            tokens.hash(UUID.randomUUID().toString()),
            inviterSession.hash,
            365,
        )
        val recipient = repository.bootstrap(
            "Invite remove recipient",
            tokens.hash(UUID.randomUUID().toString()),
            recipientSession.hash,
            365,
        )
        val originalCircleId = connectDirect(
            relationships,
            inviterSession.hash,
            recipientSession.hash,
            recipient.publicId,
        )
        val inviteToken = tokens.issue()
        assertIs<DirectInviteResult.Success<*>>(
            invites.create(inviterSession.hash, inviteToken.hash, UUID.randomUUID()),
        )
        val redeemKey = UUID.randomUUID()

        val (removed, redeemed) = withTimeout(15_000) {
            coroutineScope {
                val remove = async { relationships.removePerson(inviterSession.hash, originalCircleId) }
                val redeem = async { invites.redeem(recipientSession.hash, inviteToken.hash, redeemKey) }
                remove.await() to redeem.await()
            }
        }
        assertIs<RelationshipResult.Success<*>>(removed)
        val redeemSnapshot = assertIs<DirectInviteResult.Success<*>>(redeemed).value as DirectInviteRedeemSnapshot

        val activeCount = dataSource.connection.use { connection ->
            val originalArchived = connection.prepareStatement(
                "SELECT archived_at IS NOT NULL FROM circles WHERE id = ?",
            ).use { statement ->
                statement.setObject(1, originalCircleId)
                statement.executeQuery().use { result -> check(result.next()); result.getBoolean(1) }
            }
            assertTrue(originalArchived)
            connection.prepareStatement(
                """SELECT count(*) FROM circles
                    WHERE kind = 'DIRECT' AND archived_at IS NULL
                      AND direct_user_low_id = LEAST(?, ?)
                      AND direct_user_high_id = GREATEST(?, ?)""",
            ).use { statement ->
                statement.setObject(1, inviter.id)
                statement.setObject(2, recipient.id)
                statement.setObject(3, inviter.id)
                statement.setObject(4, recipient.id)
                statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
            }
        }
        assertEquals(
            if (redeemSnapshot.person.circleId == originalCircleId) 0 else 1,
            activeCount,
        )
    }

    @Test
    fun `removing a recovery contact serializes with account completion`() = runBlocking {
        val relationships = JdbcRelationshipRepository(dataSource)
        val recovery = JdbcRecoveryRepository(dataSource)
        val ownerSession = tokens.issue()
        val friendSession = tokens.issue()
        val owner = repository.bootstrap(
            "Recovery remove owner",
            tokens.hash(UUID.randomUUID().toString()),
            ownerSession.hash,
            365,
        )
        val friend = repository.bootstrap(
            "Recovery remove friend",
            tokens.hash(UUID.randomUUID().toString()),
            friendSession.hash,
            365,
        )
        val circleId = connectDirect(
            relationships,
            ownerSession.hash,
            friendSession.hash,
            friend.publicId,
        )
        val contacts = assertIs<RecoveryResult.Success<*>>(
            recovery.add(ownerSession.hash, circleId, UUID.randomUUID()),
        ).value as RecoveryContactsSnapshot
        val contact = contacts.contacts.single()
        val approval = tokens.issue()
        val claim = tokens.issue()
        val attempt = assertIs<RecoveryResult.Success<*>>(
            recovery.createAttempt(approval.hash, claim.hash, UUID.randomUUID(), null),
        ).value as RecoveryAttemptSnapshot
        assertIs<RecoveryResult.Success<*>>(
            recovery.confirmApproval(
                friendSession.hash,
                approval.hash,
                contact.contactId,
                UUID.randomUUID(),
            ),
        )
        val completionKey = UUID.randomUUID()

        val (removed, completion) = withTimeout(15_000) {
            coroutineScope {
                val remove = async { relationships.removePerson(friendSession.hash, circleId) }
                val complete = async { recovery.completeAttempt(claim.hash, completionKey, 365) }
                remove.await() to complete.await()
            }
        }
        assertIs<RelationshipResult.Success<*>>(removed)
        assertTrue(
            completion is RecoveryResult.Success<*>
                || completion === RecoveryResult.Expired
                || completion === RecoveryResult.Forbidden,
        )

        dataSource.connection.use { connection ->
            val state = connection.prepareStatement(
                """SELECT attempt.status, contact.revoked_at IS NOT NULL contact_revoked,
                          circle.archived_at IS NOT NULL circle_archived
                     FROM account_recovery_attempts attempt
                     JOIN account_recovery_contacts contact ON contact.id = attempt.recovery_contact_id
                     JOIN circles circle ON circle.id = contact.direct_circle_id
                    WHERE attempt.id = ?""",
            ).use { statement ->
                statement.setObject(1, attempt.attemptId)
                statement.executeQuery().use { result ->
                    check(result.next())
                    Triple(result.getString(1), result.getBoolean(2), result.getBoolean(3))
                }
            }
            assertTrue(state.first in setOf("COMPLETED", "CANCELLED"))
            assertTrue(state.second)
            assertTrue(state.third)
            val activeClaimSessions = connection.prepareStatement(
                """SELECT count(*) FROM app_sessions
                    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > clock_timestamp()""",
            ).use { statement ->
                statement.setBytes(1, claim.hash)
                statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
            }
            assertEquals(if (state.first == "COMPLETED") 1 else 0, activeClaimSessions)
        }
        if (completion is RecoveryResult.Success<*>) {
            assertEquals(owner.id, repository.findBySession(claim.hash)?.id)
            assertEquals(null, repository.findBySession(ownerSession.hash))
        } else {
            assertEquals(null, repository.findBySession(claim.hash))
            assertEquals(owner.id, repository.findBySession(ownerSession.hash)?.id)
        }
    }

    @Test
    fun `friend approval restores only the claimant browser and completion replay reuses one session`() = runBlocking {
        val relationships = JdbcRelationshipRepository(dataSource)
        val groups = JdbcGroupRepository(dataSource)
        val directInvites = JdbcDirectInviteRepository(dataSource)
        val recovery = JdbcRecoveryRepository(dataSource)
        val ownerSession = tokens.issue()
        val friendSession = tokens.issue()
        val owner = repository.bootstrap(
            "Владелец recovery",
            tokens.hash(UUID.randomUUID().toString()),
            ownerSession.hash,
            365,
        )
        val friend = repository.bootstrap(
            "Друг recovery",
            tokens.hash(UUID.randomUUID().toString()),
            friendSession.hash,
            365,
        )
        val accidentalSession = tokens.issue()
        repository.bootstrap(
            "Случайный новый профиль",
            tokens.hash(UUID.randomUUID().toString()),
            accidentalSession.hash,
            365,
        )

        val inviteCapability = tokens.issue()
        val createdInvite = assertIs<DirectInviteResult.Success<*>>(
            directInvites.create(ownerSession.hash, inviteCapability.hash, UUID.randomUUID()),
        ).value as DirectInviteLinkSnapshot
        assertEquals(false, createdInvite.replayed)

        val preview = assertIs<DirectInviteResult.Success<*>>(
            directInvites.preview(inviteCapability.hash),
        ).value as DirectInvitePreviewSnapshot
        assertEquals(owner.publicId, preview.inviter.publicId)

        val redeemKey = UUID.randomUUID()
        val concurrentRedeems = coroutineScope {
            listOf(
                async { directInvites.redeem(friendSession.hash, inviteCapability.hash, redeemKey) },
                async { directInvites.redeem(friendSession.hash, inviteCapability.hash, redeemKey) },
            ).awaitAll()
        }.map { result ->
            assertIs<DirectInviteResult.Success<*>>(result).value as DirectInviteRedeemSnapshot
        }
        assertEquals(1, concurrentRedeems.count { !it.replayed })
        assertEquals(1, concurrentRedeems.count { it.replayed })
        val redeemed = concurrentRedeems.single { !it.replayed }
        assertEquals(owner.publicId, redeemed.person.user.publicId)
        assertEquals(false, redeemed.replayed)

        val replayedRedeem = concurrentRedeems.single { it.replayed }
        assertEquals(true, replayedRedeem.replayed)
        assertEquals(redeemed.person.circleId, replayedRedeem.person.circleId)

        val contacts = assertIs<RecoveryResult.Success<*>>(
            recovery.add(ownerSession.hash, redeemed.person.circleId, UUID.randomUUID()),
        ).value as RecoveryContactsSnapshot
        val contact = contacts.contacts.single()
        assertEquals(friend.publicId, contact.user.publicId)

        val friendContacts = assertIs<RecoveryResult.Success<*>>(
            recovery.list(friendSession.hash),
        ).value as RecoveryContactsSnapshot
        assertEquals(contact.contactId, friendContacts.trustedBy.single().contactId)

        val colluderSession = tokens.issue()
        val colluder = repository.bootstrap(
            "Предварительно добавленный recovery контакт",
            tokens.hash(UUID.randomUUID().toString()),
            colluderSession.hash,
            365,
        )
        val pendingRecipientSession = tokens.issue()
        val pendingRecipient = repository.bootstrap(
            "Получатель старых приглашений",
            tokens.hash(UUID.randomUUID().toString()),
            pendingRecipientSession.hash,
            365,
        )
        val expiredRecipientSession = tokens.issue()
        val expiredRecipient = repository.bootstrap(
            "Получатель просроченного запроса",
            tokens.hash(UUID.randomUUID().toString()),
            expiredRecipientSession.hash,
            365,
        )
        val colluderCircleId = connectDirect(
            relationships,
            ownerSession.hash,
            colluderSession.hash,
            colluder.publicId,
        )
        val colluderContact = (assertIs<RecoveryResult.Success<*>>(
            recovery.add(ownerSession.hash, colluderCircleId, UUID.randomUUID()),
        ).value as RecoveryContactsSnapshot).contacts.single { it.user.publicId == colluder.publicId }
        val pendingInviteCapability = tokens.issue()
        val pendingInvite = assertIs<DirectInviteResult.Success<*>>(
            directInvites.create(
                ownerSession.hash,
                pendingInviteCapability.hash,
                UUID.randomUUID(),
            ),
        ).value as DirectInviteLinkSnapshot
        val pendingDirectRequest = assertIs<RelationshipResult.Success<*>>(
            relationships.sendRequest(
                ownerSession.hash,
                pendingRecipient.publicId,
                UUID.randomUUID(),
            ),
        ).value as ru.zhiv.relationships.DirectRequestMutationSnapshot
        val expiredDirectRequestId = dataSource.connection.use { connection ->
            val requestId = connection.prepareStatement(
                """INSERT INTO direct_requests (
                       requester_user_id, recipient_user_id, idempotency_key,
                       created_at, expires_at
                     ) VALUES (
                       ?, ?, ?, clock_timestamp() - interval '8 days',
                       clock_timestamp() - interval '1 day'
                     ) RETURNING id""",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.setObject(2, expiredRecipient.id)
                statement.setObject(3, UUID.randomUUID())
                statement.executeQuery().use { result ->
                    check(result.next())
                    result.getObject(1, UUID::class.java)
                }
            }
            connection.commit()
            requestId
        }
        val group = assertIs<GroupResult.Success<*>>(
            groups.createGroup(
                ownerSession.hash,
                "Recovery cleanup group",
                null,
                emptyList(),
                UUID.randomUUID(),
            ),
        ).value as GroupMutationSnapshot
        assertIs<GroupResult.Success<*>>(
            groups.inviteMember(
                ownerSession.hash,
                group.groupId,
                colluderCircleId,
                UUID.randomUUID(),
            ),
        )
        val pendingGroupInvite = (assertIs<GroupResult.Success<*>>(
            groups.listGroups(colluderSession.hash),
        ).value as GroupsSnapshot).incomingInvites.single { it.groupId == group.groupId }

        val bobSession = tokens.issue()
        val bob = repository.bootstrap(
            "Профиль с вредоносным одобрением",
            tokens.hash(UUID.randomUUID().toString()),
            bobSession.hash,
            365,
        )
        val bobAliceCircleId = connectDirect(
            relationships,
            bobSession.hash,
            ownerSession.hash,
            owner.publicId,
        )
        val bobRecoveryContact = (assertIs<RecoveryResult.Success<*>>(
            recovery.add(bobSession.hash, bobAliceCircleId, UUID.randomUUID()),
        ).value as RecoveryContactsSnapshot).contacts.single()
        val bobApproval = tokens.issue()
        val bobClaim = tokens.issue()
        assertIs<RecoveryResult.Success<*>>(
            recovery.createAttempt(bobApproval.hash, bobClaim.hash, UUID.randomUUID(), null),
        )
        assertIs<RecoveryResult.Success<*>>(
            recovery.confirmApproval(
                ownerSession.hash,
                bobApproval.hash,
                bobRecoveryContact.contactId,
                UUID.randomUUID(),
            ),
        )

        val approvalCapability = tokens.issue()
        val firstClaim = tokens.issue()
        val creationKey = UUID.randomUUID()
        val createdAttempt = assertIs<RecoveryResult.Success<*>>(
            recovery.createAttempt(
                approvalCapability.hash,
                firstClaim.hash,
                creationKey,
                accidentalSession.hash,
            ),
        ).value as RecoveryAttemptSnapshot
        assertEquals(RecoveryAttemptStatus.PENDING, createdAttempt.status)
        assertEquals(null, createdAttempt.target)
        assertEquals(false, createdAttempt.replayed)

        val current = assertIs<RecoveryResult.Success<*>>(
            recovery.currentAttempt(firstClaim.hash),
        ).value as RecoveryAttemptSnapshot
        assertEquals(createdAttempt.attemptId, current.attemptId)

        val replayedCreation = assertIs<RecoveryResult.Success<*>>(
            recovery.createAttempt(
                approvalCapability.hash,
                firstClaim.hash,
                creationKey,
                accidentalSession.hash,
            ),
        ).value as RecoveryAttemptSnapshot
        assertEquals(true, replayedCreation.replayed)
        assertEquals(createdAttempt.attemptId, replayedCreation.attemptId)

        val approvalPreview = assertIs<RecoveryResult.Success<*>>(
            recovery.previewApproval(friendSession.hash, approvalCapability.hash),
        ).value as RecoveryApprovalPreviewSnapshot
        val candidate = approvalPreview.eligible.single()
        assertEquals(contact.contactId, candidate.contactId)
        assertEquals(owner.publicId, candidate.target.publicId)

        val approvalKey = UUID.randomUUID()
        val approved = assertIs<RecoveryResult.Success<*>>(
            recovery.confirmApproval(
                friendSession.hash,
                approvalCapability.hash,
                contact.contactId,
                approvalKey,
            ),
        ).value as RecoveryAttemptSnapshot
        assertEquals(RecoveryAttemptStatus.APPROVED, approved.status)
        assertEquals(owner.publicId, approved.target?.publicId)
        val replayedApproval = assertIs<RecoveryResult.Success<*>>(
            recovery.confirmApproval(
                friendSession.hash,
                approvalCapability.hash,
                contact.contactId,
                approvalKey,
            ),
        ).value as RecoveryAttemptSnapshot
        assertEquals(true, replayedApproval.replayed)

        val mismatchedSession = assertFailsWith<SQLException> {
            dataSource.connection.use { connection ->
                try {
                    val ownerSessionId = connection.prepareStatement(
                        "SELECT id FROM app_sessions WHERE token_hash = ?",
                    ).use { statement ->
                        statement.setBytes(1, ownerSession.hash)
                        statement.executeQuery().use { result ->
                            check(result.next())
                            result.getObject("id", UUID::class.java)
                        }
                    }
                    connection.prepareStatement(
                        """UPDATE account_recovery_attempts
                              SET status = 'COMPLETED',
                                  completed_session_id = ?,
                                  completion_idempotency_key = ?,
                                  completed_at = clock_timestamp()
                            WHERE id = ?""",
                    ).use { statement ->
                        statement.setObject(1, ownerSessionId)
                        statement.setObject(2, UUID.randomUUID())
                        statement.setObject(3, createdAttempt.attemptId)
                        statement.executeUpdate()
                    }
                    connection.commit()
                } catch (error: SQLException) {
                    connection.rollback()
                    throw error
                }
            }
        }
        assertEquals("23514", mismatchedSession.sqlState)

        assertIs<RecoveryResult.NotFound>(
            recovery.completeAttempt(
                approvalCapability.hash,
                UUID.randomUUID(),
                365,
            ),
        )

        val completionKey = UUID.randomUUID()
        suspend fun awaitRecoveryLockWaiters(minimum: Int) {
            withTimeout(10_000) {
                while (true) {
                    val count = dataSource.connection.use { connection ->
                        connection.prepareStatement(
                            """SELECT count(*) FROM pg_stat_activity
                                WHERE datname = current_database()
                                  AND application_name = 'zhiv-api'
                                  AND wait_event_type = 'Lock'""",
                        ).use { statement ->
                            statement.executeQuery().use { result ->
                                check(result.next())
                                result.getInt(1)
                            }
                        }
                    }
                    if (count >= minimum) return@withTimeout
                    delay(20)
                }
            }
        }
        val completionBlocker = dataSource.connection
        val concurrentResults = try {
            completionBlocker.prepareStatement(
                "SELECT id FROM app_users WHERE id = ? FOR UPDATE",
            ).use { statement ->
                statement.setObject(1, owner.id)
                statement.executeQuery().use { result -> assertTrue(result.next()) }
            }
            val baselineWaiters = dataSource.connection.use { connection ->
                connection.prepareStatement(
                    """SELECT count(*) FROM pg_stat_activity
                        WHERE datname = current_database()
                          AND application_name = 'zhiv-api'
                          AND wait_event_type = 'Lock'""",
                ).use { statement ->
                    statement.executeQuery().use { result -> check(result.next()); result.getInt(1) }
                }
            }
            coroutineScope {
                val firstCompletion = async {
                    recovery.completeAttempt(firstClaim.hash, completionKey, 365)
                }
                var blockerReleased = false
                fun releaseBlocker() {
                    if (!blockerReleased) {
                        completionBlocker.commit()
                        blockerReleased = true
                    }
                }
                try {
                    awaitRecoveryLockWaiters(baselineWaiters + 1)
                    val replayedCompletion = async {
                        recovery.completeAttempt(firstClaim.hash, completionKey, 365)
                    }
                    val maliciousBobCompletion = async {
                        recovery.completeAttempt(bobClaim.hash, UUID.randomUUID(), 365)
                    }
                    awaitRecoveryLockWaiters(baselineWaiters + 3)
                    releaseBlocker()
                    Pair(
                        listOf(firstCompletion.await(), replayedCompletion.await()),
                        maliciousBobCompletion.await(),
                    )
                } finally {
                    releaseBlocker()
                }
            }
        } finally {
            runCatching { completionBlocker.rollback() }
            completionBlocker.close()
        }
        val concurrentCompletions = concurrentResults.first.map { result ->
            assertIs<RecoveryResult.Success<*>>(result).value as RecoveryCompletionSnapshot
        }
        assertIs<RecoveryResult.Expired>(concurrentResults.second)
        assertEquals(1, concurrentCompletions.count { !it.attempt.replayed })
        assertEquals(1, concurrentCompletions.count { it.attempt.replayed })
        assertEquals(
            setOf(RecoveryAttemptStatus.COMPLETED),
            concurrentCompletions.map { it.attempt.status }.toSet(),
        )
        assertEquals(setOf(owner.id), concurrentCompletions.map { it.user.id }.toSet())
        assertEquals(null, repository.findBySession(ownerSession.hash))
        assertEquals(null, repository.findBySession(accidentalSession.hash))
        assertEquals(owner.id, repository.findBySession(firstClaim.hash)?.id)
        assertEquals(null, repository.findBySession(bobClaim.hash))
        assertEquals(bob.id, repository.findBySession(bobSession.hash)?.id)
        assertIs<RecoveryResult.Expired>(recovery.currentAttempt(bobClaim.hash))

        val replayedCompletion = assertIs<RecoveryResult.Success<*>>(
            recovery.completeAttempt(
                firstClaim.hash,
                completionKey,
                365,
            ),
        ).value as RecoveryCompletionSnapshot
        assertEquals(true, replayedCompletion.attempt.replayed)
        assertEquals(owner.id, repository.findBySession(firstClaim.hash)?.id)
        assertIs<RecoveryResult.Conflict>(
            recovery.completeAttempt(
                firstClaim.hash,
                UUID.randomUUID(),
                365,
            ),
        )

        val recoveredContacts = assertIs<RecoveryResult.Success<*>>(
            recovery.list(firstClaim.hash),
        ).value as RecoveryContactsSnapshot
        assertEquals(setOf(contact.contactId), recoveredContacts.contacts.map { it.contactId }.toSet())
        assertIs<DirectInviteResult.Expired>(directInvites.preview(pendingInviteCapability.hash))
        assertIs<RelationshipResult.Conflict>(
            relationships.actOnRequest(
                pendingRecipientSession.hash,
                pendingDirectRequest.request.requestId,
                RequestAction.ACCEPTED,
            ),
        )
        assertIs<RelationshipResult.Expired>(
            relationships.actOnRequest(
                expiredRecipientSession.hash,
                expiredDirectRequestId,
                RequestAction.ACCEPTED,
            ),
        )
        assertIs<GroupResult.Conflict>(
            groups.actOnInvite(
                colluderSession.hash,
                pendingGroupInvite.inviteId,
                GroupInviteAction.ACCEPTED,
            ),
        )
        dataSource.connection.use { connection ->
            connection.prepareStatement(
                "SELECT status FROM direct_invite_links WHERE id = ?",
            ).use { statement ->
                statement.setObject(1, pendingInvite.inviteId)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    assertEquals("REVOKED", result.getString(1))
                }
            }
            connection.prepareStatement(
                "SELECT status FROM direct_requests WHERE id = ?",
            ).use { statement ->
                statement.setObject(1, pendingDirectRequest.request.requestId)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    assertEquals("CANCELLED", result.getString(1))
                }
            }
            connection.prepareStatement(
                "SELECT status FROM direct_requests WHERE id = ?",
            ).use { statement ->
                statement.setObject(1, expiredDirectRequestId)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    assertEquals("EXPIRED", result.getString(1))
                }
            }
            connection.prepareStatement(
                "SELECT status FROM circle_invites WHERE id = ?",
            ).use { statement ->
                statement.setObject(1, pendingGroupInvite.inviteId)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    assertEquals("REVOKED", result.getString(1))
                }
            }
        }

        val nextApproval = tokens.issue()
        val nextClaim = tokens.issue()
        assertIs<RecoveryResult.Success<*>>(
            recovery.createAttempt(nextApproval.hash, nextClaim.hash, UUID.randomUUID(), null),
        )
        val colluderPreview = assertIs<RecoveryResult.Success<*>>(
            recovery.previewApproval(colluderSession.hash, nextApproval.hash),
        ).value as RecoveryApprovalPreviewSnapshot
        assertTrue(colluderPreview.eligible.none { it.target.publicId == owner.publicId })
        assertIs<RecoveryResult.Forbidden>(
            recovery.confirmApproval(
                colluderSession.hash,
                nextApproval.hash,
                colluderContact.contactId,
                UUID.randomUUID(),
            ),
        )
        val retainedFriendPreview = assertIs<RecoveryResult.Success<*>>(
            recovery.previewApproval(friendSession.hash, nextApproval.hash),
        ).value as RecoveryApprovalPreviewSnapshot
        assertEquals(
            setOf(contact.contactId),
            retainedFriendPreview.eligible.map { it.contactId }.toSet(),
        )
        assertIs<RecoveryResult.Success<*>>(recovery.cancelAttempt(nextClaim.hash))
    }

    private suspend fun connectDirect(
        relationships: JdbcRelationshipRepository,
        requesterSessionHash: ByteArray,
        recipientSessionHash: ByteArray,
        recipientPublicId: String,
    ): UUID {
        val request = assertIs<RelationshipResult.Success<*>>(
            relationships.sendRequest(requesterSessionHash, recipientPublicId, UUID.randomUUID()),
        ).value as ru.zhiv.relationships.DirectRequestMutationSnapshot
        val accepted = assertIs<RelationshipResult.Success<*>>(
            relationships.actOnRequest(
                recipientSessionHash,
                request.request.requestId,
                RequestAction.ACCEPTED,
            ),
        ).value as ru.zhiv.relationships.DirectRequestActionSnapshot
        return requireNotNull(accepted.person).circleId
    }

    private fun loadSqlStreak(userId: UUID, serverTime: OffsetDateTime): SqlStreak =
        dataSource.connection.use { connection ->
            connection.prepareStatement(
                "SELECT * FROM rolling_check_in_streak(?, ?)",
            ).use { statement ->
                statement.setObject(1, userId)
                statement.setObject(2, serverTime)
                statement.executeQuery().use { result ->
                    assertTrue(result.next())
                    SqlStreak(
                        currentDays = result.getLong("current_days"),
                        longestDays = result.getLong("longest_days"),
                        isActive = result.getBoolean("is_active"),
                        renewBy = result.getObject("renew_by", OffsetDateTime::class.java),
                    )
                }
            }
        }

    private data class SqlStreak(
        val currentDays: Long,
        val longestDays: Long,
        val isActive: Boolean,
        val renewBy: OffsetDateTime?,
    )
}
