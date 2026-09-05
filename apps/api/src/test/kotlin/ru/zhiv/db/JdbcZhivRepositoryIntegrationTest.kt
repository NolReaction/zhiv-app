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
import ru.zhiv.relationships.RelationshipResult
import ru.zhiv.relationships.PersonCheckInState
import ru.zhiv.relationships.RequestAction
import ru.zhiv.relationships.SharingMode
import ru.zhiv.security.TokenCodec
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
    fun `recovery code is atomic single use and old sessions cannot mutate`() = runBlocking<Unit> {
        val recovery=JdbcCodeRecoveryRepository(dataSource)
        val old=tokens.issue()
        val user=repository.bootstrap("Code owner",tokens.issue().hash,old.hash,365)
        val code=tokens.issue().hash
        assertEquals(false,recovery.hasCode(old.hash))
        assertTrue(recovery.activate(old.hash,code))
        assertTrue(recovery.activate(old.hash,code))
        val retry=tokens.issue().hash
        val newSession=tokens.issue().hash
        val results=coroutineScope {
            List(2) { async { recovery.redeem(code,retry,newSession,365) } }.awaitAll()
        }
        assertTrue(results.all { it })
        assertEquals(null,repository.findBySession(old.hash))
        assertEquals(user.id,repository.findBySession(newSession)?.id)
        assertEquals(false,recovery.hasCode(newSession))
        assertEquals(false,recovery.redeem(code,tokens.issue().hash,tokens.issue().hash,365))
        assertEquals(false,recovery.activate(newSession,code))
        assertIs<CheckInResult.Unauthorized>(repository.record(old.hash,UUID.randomUUID()))
        val nextCode=tokens.issue().hash
        assertTrue(recovery.activate(newSession,nextCode))
        val newest=tokens.issue().hash
        assertTrue(recovery.redeem(nextCode,tokens.issue().hash,newest,365))
        assertEquals(false,recovery.redeem(code,retry,newSession,365))
        assertEquals(user.id,repository.findBySession(newest)?.id)
    }

    @Test
    fun `different recovery attempts race for exactly one code`() = runBlocking<Unit> {
        val recovery=JdbcCodeRecoveryRepository(dataSource)
        val session=tokens.issue()
        repository.bootstrap("Code race",tokens.issue().hash,session.hash,365)
        val first=tokens.issue().hash
        val code=tokens.issue().hash
        assertTrue(recovery.activate(session.hash,first))
        assertTrue(recovery.activate(session.hash,code))
        assertEquals(false,recovery.redeem(first,tokens.issue().hash,tokens.issue().hash,365))
        val results=coroutineScope {
            List(4) { async { recovery.redeem(code,tokens.issue().hash,tokens.issue().hash,365) } }.awaitAll()
        }
        assertEquals(1,results.count {it})
    }


    @Test
    fun `group privacy and status use the same outgoing recipient decision`() = runBlocking<Unit> {
        val relationships=JdbcRelationshipRepository(dataSource)
        val groups=JdbcGroupRepository(dataSource)
        val a=tokens.issue(); val b=tokens.issue(); val d=tokens.issue()
        val owner=repository.bootstrap("Status owner",tokens.issue().hash,a.hash,365)
        val friend=repository.bootstrap("Status friend",tokens.issue().hash,b.hash,365)
        val other=repository.bootstrap("Status other",tokens.issue().hash,d.hash,365)
        val first=connectDirect(relationships,a.hash,b.hash,friend.publicId)
        val second=connectDirect(relationships,a.hash,d.hash,other.publicId)
        val group=(assertIs<ru.zhiv.groups.GroupResult.Success<*>>(groups.createGroup(a.hash,"Семья",null,listOf(first,second),UUID.randomUUID())).value as ru.zhiv.groups.GroupMutationSnapshot).groupId
        for (session in listOf(b,d)) {
            val invite=(assertIs<ru.zhiv.groups.GroupResult.Success<*>>(groups.listGroups(session.hash)).value as ru.zhiv.groups.GroupsSnapshot).incomingInvites.single()
            assertIs<ru.zhiv.groups.GroupResult.Success<*>>(groups.actOnInvite(session.hash,invite.inviteId,ru.zhiv.groups.GroupInviteAction.ACCEPTED))
        }
        val before=assertNotNull(repository.findBySession(a.hash))
        val writeKey=UUID.randomUUID()
        assertIs<ru.zhiv.identity.DisplayNameUpdateResult.Success>(repository.updateStatus(a.hash,"гуляю",writeKey))
        assertIs<ru.zhiv.identity.DisplayNameUpdateResult.IdempotencyConflict>(repository.updateStatus(a.hash,"дома",writeKey))
        val after=assertNotNull(repository.findBySession(a.hash))
        assertEquals(before.checkInCount,after.checkInCount)
        assertEquals(before.lastCheckInAt,after.lastCheckInAt)
        fun person(snapshot:Any?)= (snapshot as ru.zhiv.relationships.PeopleSnapshot).people.single {it.user.publicId==owner.publicId}
        assertEquals("гуляю",person(assertIs<RelationshipResult.Success<*>>(relationships.listPeople(b.hash)).value).statusText)
        assertIs<ru.zhiv.groups.GroupResult.Success<*>>(groups.updateSharing(a.hash,group,SharingMode.OFF))
        val hidden=person(assertIs<RelationshipResult.Success<*>>(relationships.listPeople(b.hash)).value)
        assertEquals(SharingMode.OFF,hidden.theirSharingMode);assertEquals(null,hidden.statusText)
        assertIs<RelationshipResult.Success<*>>(relationships.updateSharing(a.hash,first,SharingMode.LATEST_ONLY))
        val mixed=(assertIs<ru.zhiv.groups.GroupResult.Success<*>>(groups.listGroups(a.hash)).value as ru.zhiv.groups.GroupsSnapshot).groups.single()
        assertTrue(mixed.sharingMixed)
        assertEquals(null,person(assertIs<RelationshipResult.Success<*>>(relationships.listPeople(b.hash)).value).statusText)
        assertIs<ru.zhiv.identity.DisplayNameUpdateResult.Success>(repository.updateStatus(a.hash,"дома",UUID.randomUUID()))
        assertEquals("дома",person(assertIs<RelationshipResult.Success<*>>(relationships.listPeople(b.hash)).value).statusText)
        assertEquals(null,person(assertIs<RelationshipResult.Success<*>>(relationships.listPeople(d.hash)).value).statusText)
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
