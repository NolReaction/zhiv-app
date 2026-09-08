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
import ru.zhiv.groups.GroupResult
import ru.zhiv.groups.GroupsSnapshot
import ru.zhiv.identity.DisplayNameUpdateResult
import ru.zhiv.identity.UserSnapshot
import ru.zhiv.relationships.PeopleSnapshot
import ru.zhiv.relationships.RelationshipResult
import ru.zhiv.relationships.SharingMode
import ru.zhiv.security.TokenCodec
import java.sql.Connection
import java.sql.ResultSet
import java.time.YearMonth
import java.time.ZoneId
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Repository-level history tests. Merge/tombstone fixtures establish the lifecycle
 * contract directly; proof validation and confirmMerge are covered by lifecycle tests. */
@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcMergedHistoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)

    companion object {
        @Container
        private val postgres = Postgres("postgres:18-alpine")
    }

    private lateinit var source: HikariDataSource
    private lateinit var repository: JdbcZhivRepository
    private lateinit var relationships: JdbcRelationshipRepository
    private lateinit var groups: JdbcGroupRepository
    private val tokens = TokenCodec()

    @BeforeAll
    fun setup() {
        source = DatabaseFactory.create(
            AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")),
        )
        DatabaseFactory.migrate(source)
        repository = JdbcZhivRepository(source)
        relationships = JdbcRelationshipRepository(source)
        groups = JdbcGroupRepository(source)
    }

    @AfterAll
    fun close() {
        source.close()
    }

    @Test
    fun `self totals and cooldown include retired source events without relying on the profile cache`() = runBlocking<Unit> {
        val survivor = user("Survivor history")
        val retired = user("Source history")
        val anchor = now().minusSeconds(1)
        val events = listOf(
            event(survivor, anchor.minusHours(48)),
            event(retired, anchor.minusHours(36)),
            event(retired, anchor.minusHours(24)),
            event(survivor, anchor.minusHours(12)),
            event(retired, anchor),
        )
        val originalEvents = eventRows(events)
        mergeFixture(retired, survivor)

        val me = assertNotNull(repository.findBySession(survivor.sessionHash))
        assertEquals(anchor.minusHours(48).toInstant(),assertNotNull(repository.calendar(survivor.sessionHash,null)).streakStartedAt?.toInstant())
        assertEquals(5L, me.checkInCount)
        assertEquals(anchor.toInstant(), me.lastCheckInAt?.toInstant())
        assertEquals(3L, me.streak.currentDays)
        assertEquals(3L, me.streak.longestDays)
        assertEquals(anchor.plusHours(24).toInstant(), me.streak.renewBy?.toInstant())
        val cooldown = assertIs<CheckInResult.Cooldown>(repository.record(survivor.sessionHash, UUID.randomUUID()))
        assertEquals(anchor.toInstant(), cooldown.checkedAt.toInstant())
        assertEquals(anchor.plusSeconds(30).toInstant(), cooldown.nextAllowedAt.toInstant())
        assertEquals(3L, cooldown.streak.currentDays)

        val changed = assertIs<DisplayNameUpdateResult.Success>(
            repository.updateDisplayName(survivor.sessionHash, "Renamed survivor", UUID.randomUUID()),
        ).user
        assertEquals(5L, changed.checkInCount)
        assertEquals(me.lastCheckInAt, changed.lastCheckInAt)
        val nextSession = tokens.issue().hash
        val bootstrapReplay = repository.bootstrap("Ignored", survivor.bootstrapHash, nextSession, 365)
        assertEquals(5L, bootstrapReplay.checkInCount)
        assertEquals(me.lastCheckInAt, bootstrapReplay.lastCheckInAt)
        assertEquals(3L, bootstrapReplay.streak.currentDays)
        assertEquals(originalEvents, eventRows(events))
        assertNull(repository.calendar(survivor.sessionHash, null))
        assertNotNull(repository.calendar(nextSession, null))
        assertNull(repository.findBySession(retired.sessionHash))
        assertIs<CheckInResult.Unauthorized>(repository.record(retired.sessionHash, UUID.randomUUID()))
    }

    @Test
    fun `flattened merge chains retain every event and keep replay keys scoped to their original actor`() = runBlocking<Unit> {
        val first = user("First history")
        val second = user("Second history")
        val destination = user("Final history")
        val sharedKey = UUID.randomUUID()
        val sourceOnlyKey = UUID.randomUUID()
        val anchor = now().minusMinutes(2)
        val events = listOf(
            event(first, anchor.minusMinutes(3), sourceOnlyKey),
            event(first, anchor.minusMinutes(2), sharedKey),
            event(second, anchor.minusMinutes(1), sharedKey),
            event(destination, anchor, sharedKey),
        )
        val originalEvents = eventRows(events)
        mergeFixture(first, second)
        assertEquals(3L, repository.findBySession(second.sessionHash)?.checkInCount)
        mergeFixture(second, destination)
        assertEquals(4L, repository.findBySession(destination.sessionHash)?.checkInCount)
        assertEquals(setOf(first.profile.id, second.profile.id), mappedSources(destination.profile.id))
        assertNull(repository.findSessionUserId(first.sessionHash))
        assertNull(repository.findSessionUserId(second.sessionHash))

        val replay = assertIs<CheckInResult.Accepted>(repository.record(destination.sessionHash, sharedKey))
        assertTrue(replay.replayed)
        assertEquals(events.last().id, replay.eventId)
        assertEquals(4L, replay.checkInCount)
        val accepted = assertIs<CheckInResult.Accepted>(repository.record(destination.sessionHash, sourceOnlyKey))
        assertFalse(accepted.replayed)
        assertNotEquals(events.first().id, accepted.eventId)
        assertEquals(5L, accepted.checkInCount)
        assertEquals(5L, repository.findBySession(destination.sessionHash)?.checkInCount)
        assertEquals(originalEvents, eventRows(events))

        transaction { c -> tombstone(c, destination) }
        assertEquals(setOf(first.profile.id, second.profile.id), mappedSources(destination.profile.id))
        for (account in listOf(first, second, destination)) {
            assertNull(repository.findBySession(account.sessionHash))
            assertIs<CheckInResult.Unauthorized>(repository.record(account.sessionHash, UUID.randomUUID()))
        }
        assertEquals(originalEvents, eventRows(events))
    }

    @Test
    fun `merged simultaneous events count separately but share one daily and rolling streak`() = runBlocking<Unit> {
        val survivor = user("Calendar survivor")
        val retired = user("Calendar source")
        val start = OffsetDateTime.parse("2026-01-01T12:00:00Z")
        event(survivor, start)
        event(retired, start.plusDays(1))
        event(survivor, start.plusDays(2))
        event(retired, start.plusDays(2))
        mergeFixture(retired, survivor)
        assertEquals(4L, repository.findBySession(survivor.sessionHash)?.checkInCount)
        val calendar = assertNotNull(repository.calendar(survivor.sessionHash, YearMonth.of(2026, 1)))
        assertEquals(YearMonth.of(2026, 1), calendar.month)
        assertEquals(YearMonth.of(2026, 1), calendar.firstMonth)
        assertEquals(listOf("2026-01-01" to 1L, "2026-01-02" to 1L, "2026-01-03" to 2L),
            calendar.days.map { it.date.toString() to it.count })
        assertNull(repository.calendar(retired.sessionHash, YearMonth.of(2026, 1)))
        source.connection.use { c ->
            val daily = c.rows("SELECT * FROM daily_check_in_streak(?, ?, 'UTC')", survivor.profile.id, start.plusDays(2).plusHours(1)) {
                Triple(it.getLong("current_days"), it.getLong("longest_days"), it.getBoolean("checked_in_today"))
            }.single()
            assertEquals(Triple(3L, 3L, true), daily)
            val rolling = c.rows("SELECT * FROM rolling_check_in_streak(?, ?)", survivor.profile.id, start.plusDays(2).plusHours(1)) {
                Triple(it.getLong("current_days"), it.getLong("longest_days"), it.getBoolean("is_active"))
            }.single()
            assertEquals(Triple(3L, 3L, true), rolling)
        }
    }

    @Test
    fun `merged own history does not retarget old direct or group audiences in either direction`() = runBlocking<Unit> {
        val retired = user("Audience source")
        val survivor = user("Audience survivor")
        val peer = user("Audience peer")
        val base = now().minusMinutes(3)
        val old = socialFixture(retired, peer, base)
        val fromSource = event(retired, base.plusMinutes(1))
        val fromPeer = event(peer, base.plusMinutes(1))
        transaction { c ->
            audience(c, fromSource, retired, peer, old.direct, "DIRECT", null)
            audience(c, fromSource, retired, peer, old.group, "GROUP", old.peerMembership)
            audience(c, fromPeer, peer, retired, old.direct, "DIRECT", null)
            audience(c, fromPeer, peer, retired, old.group, "GROUP", old.sourceMembership)
        }
        val originalEvents = eventRows(listOf(fromSource, fromPeer))
        val originalAudiences = audienceRows(listOf(fromSource, fromPeer))
        assertEquals(4, originalAudiences.size)

        val newDirect = UUID.randomUUID()
        val newMembership = UUID.randomUUID()
        transaction { c ->
            c.update("UPDATE circle_sharing_preferences SET sharing_mode='OFF' WHERE user_id=? AND circle_id IN (?, ?)", retired.profile.id, old.direct, old.group)
            c.update("UPDATE circles SET archived_at=clock_timestamp() WHERE id=?", old.direct)
            c.update("UPDATE circle_memberships SET left_at=clock_timestamp() WHERE id=?", old.sourceMembership)
            mergeFixture(c, retired, survivor)
            direct(c, newDirect, survivor.profile.id, peer.profile.id, now(c))
            c.update("INSERT INTO circle_memberships(id,circle_id,user_id,share_latest) VALUES (?, ?, ?, false)", newMembership, old.group, survivor.profile.id)
            for (account in listOf(survivor, peer)) preference(c, newDirect, account.profile.id, "OFF", now(c))
            preference(c, old.group, survivor.profile.id, "OFF", now(c))
            for ((actor, recipient) in listOf(survivor to peer, peer to survivor)) {
                c.update("INSERT INTO recipient_sharing_preferences(actor_user_id,recipient_user_id,sharing_mode) VALUES (?, ?, 'OFF')", actor.profile.id, recipient.profile.id)
            }
        }
        assertNotEquals(old.sourceMembership, newMembership)
        assertEquals(1L, repository.findBySession(survivor.sessionHash)?.checkInCount)
        assertHistoryHidden(survivor, peer)
        for (account in listOf(survivor, peer)) {
            assertIs<RelationshipResult.Success<*>>(relationships.updateSharing(account.sessionHash, newDirect, SharingMode.LATEST_ONLY))
        }
        assertHistoryHidden(survivor, peer)

        val survivorEvent = assertIs<CheckInResult.Accepted>(repository.record(survivor.sessionHash, UUID.randomUUID()))
        assertEquals(survivorEvent.checkedAt, people(peer).people.single().lastCheckInAt)
        assertNull(people(survivor).people.single().lastCheckInAt)
        val peerEvent = assertIs<CheckInResult.Accepted>(repository.record(peer.sessionHash, UUID.randomUUID()))
        assertEquals(peerEvent.checkedAt, people(survivor).people.single().lastCheckInAt)
        assertEquals(peerEvent.checkedAt, groupSnapshot(survivor).groups.single().members.single { !it.isMe }.lastCheckInAt)
        assertEquals(survivorEvent.checkedAt, groupSnapshot(peer).groups.single().members.single { !it.isMe }.lastCheckInAt)
        assertEquals(originalEvents, eventRows(listOf(fromSource, fromPeer)))
        assertEquals(originalAudiences, audienceRows(listOf(fromSource, fromPeer)))
    }

    @Test
    fun `calendar preserves local midnight leap days and excludes unrelated profiles`() = runBlocking<Unit> {
        val owner = user("Local calendar")
        val other = user("Unrelated calendar")
        for (at in listOf("2024-02-28T20:59:00Z", "2024-02-28T21:01:00Z", "2024-02-29T20:59:00Z", "2024-02-29T21:01:00Z")) {
            event(owner, OffsetDateTime.parse(at), zone = "Europe/Moscow")
        }
        event(other, OffsetDateTime.parse("2024-02-29T12:00:00Z"))
        val february = assertNotNull(repository.calendar(owner.sessionHash, YearMonth.of(2024, 2)))
        assertEquals(listOf("2024-02-28" to 1L, "2024-02-29" to 2L), february.days.map { it.date.toString() to it.count })
        val march = assertNotNull(repository.calendar(owner.sessionHash, YearMonth.of(2024, 3)))
        assertEquals(listOf("2024-03-01" to 1L), march.days.map { it.date.toString() to it.count })
        val empty = assertNotNull(repository.calendar(owner.sessionHash, YearMonth.of(2024, 1)))
        assertTrue(empty.days.isEmpty())
        assertEquals(YearMonth.of(2024, 2), empty.firstMonth)
        assertTrue(assertNotNull(repository.calendar(owner.sessionHash, YearMonth.of(9999, 12))).days.isEmpty())
    }

    @Test
    fun `empty calendar uses server profile time and replay never adds another mark`() = runBlocking<Unit> {
        val owner = user("Empty calendar")
        val empty = assertNotNull(repository.calendar(owner.sessionHash, null))
        assertNull(empty.streakStartedAt)
        assertEquals("Europe/Moscow", empty.timeZone)
        assertEquals(empty.serverTime.atZoneSameInstant(ZoneId.of(empty.timeZone)).toLocalDate(), empty.today)
        assertEquals(YearMonth.from(empty.today), empty.month)
        assertEquals(empty.month, empty.firstMonth)
        assertTrue(empty.days.isEmpty())
        val key = UUID.randomUUID()
        val first = assertIs<CheckInResult.Accepted>(repository.record(owner.sessionHash, key))
        assertTrue(assertIs<CheckInResult.Accepted>(repository.record(owner.sessionHash, key)).replayed)
        val month = YearMonth.from(first.checkedAt.atZoneSameInstant(ZoneId.of(empty.timeZone)))
        val refreshed=assertNotNull(repository.calendar(owner.sessionHash, month))
        assertEquals(1L, refreshed.days.sumOf { it.count })
        assertEquals(first.checkedAt.toInstant(),refreshed.streakStartedAt?.toInstant())
        transaction { c -> c.update("UPDATE app_sessions SET created_at=clock_timestamp() - interval '2 days', expires_at=clock_timestamp() - interval '1 second' WHERE token_hash=?", owner.sessionHash) }
        assertNull(repository.calendar(owner.sessionHash, null))
        assertNull(repository.calendar(tokens.issue().hash, null))
    }

    private suspend fun assertHistoryHidden(first: Account, second: Account) {
        for (account in listOf(first, second)) {
            assertNull(people(account).people.single().lastCheckInAt)
            assertNull(groupSnapshot(account).groups.single().members.single { !it.isMe }.lastCheckInAt)
        }
    }

    private suspend fun people(account: Account): PeopleSnapshot =
        assertIs<RelationshipResult.Success<PeopleSnapshot>>(relationships.listPeople(account.sessionHash)).value

    private suspend fun groupSnapshot(account: Account): GroupsSnapshot =
        assertIs<GroupResult.Success<GroupsSnapshot>>(groups.listGroups(account.sessionHash)).value

    private data class Account(val profile: UserSnapshot, val sessionHash: ByteArray, val bootstrapHash: ByteArray, val sessionId: UUID)
    private data class Event(val id: UUID)
    private data class Social(val direct: UUID, val group: UUID, val sourceMembership: UUID, val peerMembership: UUID)

    private suspend fun user(name: String): Account {
        val session = tokens.issue().hash
        val bootstrap = tokens.issue().hash
        val profile = repository.bootstrap(name, bootstrap, session, 365)
        val sessionId = source.connection.use { c ->
            c.rows("SELECT id FROM app_sessions WHERE token_hash=?", session) { it.getObject(1, UUID::class.java) }.single()
        }
        return Account(profile, session, bootstrap, sessionId)
    }

    private fun event(account: Account, at: OffsetDateTime, key: UUID = UUID.randomUUID(), zone: String = "UTC"): Event = transaction { c ->
        val id = c.rows("""
            INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
            VALUES (?, ?, ?, ?, ?::timestamptz + interval '30 seconds', ?, (?::timestamptz AT TIME ZONE ?)::date)
            RETURNING id
        """.trimIndent(), account.profile.id, account.sessionId, key, at, at, zone, at, zone) { it.getObject(1, UUID::class.java) }.single()
        c.update("UPDATE app_users SET last_check_in_at=GREATEST(last_check_in_at,?),updated_at=clock_timestamp() WHERE id=?", at, account.profile.id)
        Event(id)
    }

    private fun mergeFixture(retired: Account, survivor: Account) = transaction { c -> mergeFixture(c, retired, survivor) }

    private fun mergeFixture(c: Connection, retired: Account, survivor: Account) {
        c.update("UPDATE account_merge_sources SET target_user_id=? WHERE target_user_id=?", survivor.profile.id, retired.profile.id)
        c.update("INSERT INTO account_merge_sources(source_user_id,target_user_id) VALUES (?, ?)", retired.profile.id, survivor.profile.id)
        // Intentionally leave the survivor cache untouched: reads and cooldown must
        // use the underlying immutable events even after the source cache is erased.
        tombstone(c, retired)
    }

    private fun tombstone(c: Connection, account: Account) {
        c.update("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE user_id=? AND revoked_at IS NULL", account.profile.id)
        c.update("UPDATE app_users SET display_name='Deleted',last_check_in_at=NULL,deleted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=?", account.profile.id)
    }

    private fun mappedSources(target: UUID): Set<UUID> = source.connection.use { c ->
        c.rows("SELECT source_user_id FROM account_merge_sources WHERE target_user_id=?", target) { it.getObject(1, UUID::class.java) }.toSet()
    }

    private fun socialFixture(retired: Account, peer: Account, at: OffsetDateTime): Social = transaction { c ->
        val result = Social(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID())
        direct(c, result.direct, retired.profile.id, peer.profile.id, at)
        c.update("INSERT INTO circles(id,kind,title,created_by_user_id,created_at) VALUES (?, 'GROUP', 'History group', ?, ?)", result.group, peer.profile.id, at)
        c.update("INSERT INTO circle_memberships(id,circle_id,user_id,role,joined_at) VALUES (?, ?, ?, 'OWNER', ?)", result.peerMembership, result.group, peer.profile.id, at)
        c.update("INSERT INTO circle_memberships(id,circle_id,user_id,role,joined_at) VALUES (?, ?, ?, 'MEMBER', ?)", result.sourceMembership, result.group, retired.profile.id, at)
        for (circle in listOf(result.direct, result.group)) {
            for (account in listOf(retired, peer)) preference(c, circle, account.profile.id, "LATEST_ONLY", at)
        }
        result
    }

    private fun direct(c: Connection, circle: UUID, first: UUID, second: UUID, at: OffsetDateTime) {
        c.update("""
            INSERT INTO circles(id,kind,created_by_user_id,direct_user_low_id,direct_user_high_id,created_at)
            VALUES (?, 'DIRECT', ?, LEAST(?::uuid,?::uuid), GREATEST(?::uuid,?::uuid), ?)
        """.trimIndent(), circle, first, first, second, first, second, at)
    }

    private fun preference(c: Connection, circle: UUID, account: UUID, mode: String, at: OffsetDateTime) {
        c.update("""
            INSERT INTO circle_sharing_preferences(circle_id,user_id,sharing_mode,enabled_since,created_at,updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """.trimIndent(), circle, account, mode, if (mode == "OFF") null else at, at, at)
    }

    private fun audience(c: Connection, event: Event, actor: Account, recipient: Account, circle: UUID, kind: String, membership: UUID?) {
        c.update("""
            INSERT INTO check_in_audiences(check_in_id,actor_user_id,circle_id,circle_kind,recipient_user_id,recipient_membership_id)
            VALUES (?, ?, ?, ?, ?, ?)
        """.trimIndent(), event.id, actor.profile.id, circle, kind, recipient.profile.id, membership)
    }

    private fun eventRows(events: List<Event>): List<String> = source.connection.use { c ->
        val placeholders = events.joinToString(",") { "?" }
        c.rows("SELECT to_jsonb(e)::text FROM check_ins e WHERE id IN ($placeholders) ORDER BY id", *events.map { it.id }.toTypedArray()) { it.getString(1) }
    }

    private fun audienceRows(events: List<Event>): List<String> = source.connection.use { c ->
        val placeholders = events.joinToString(",") { "?" }
        c.rows("SELECT to_jsonb(a)::text FROM check_in_audiences a WHERE check_in_id IN ($placeholders) ORDER BY check_in_id,circle_id,recipient_user_id", *events.map { it.id }.toTypedArray()) { it.getString(1) }
    }

    private fun now(): OffsetDateTime = source.connection.use { now(it) }
    private fun now(c: Connection): OffsetDateTime = c.rows("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java) }.single()

    private fun Connection.update(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { statement ->
        values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeUpdate()
    }

    private fun <T> Connection.rows(sql: String, vararg values: Any?, read: (ResultSet) -> T): List<T> = prepareStatement(sql).use { statement ->
        values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
        statement.executeQuery().use { rows -> buildList { while (rows.next()) add(read(rows)) } }
    }

    private fun <T> transaction(action: (Connection) -> T): T = source.connection.use { c ->
        try { action(c).also { c.commit() } } catch (failure: Throwable) { c.rollback(); throw failure }
    }
}
