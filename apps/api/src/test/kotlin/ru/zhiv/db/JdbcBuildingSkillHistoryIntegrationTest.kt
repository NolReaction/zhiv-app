package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
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
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

/** The compatibility projection must not silently write a new revision on GET. */
@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcBuildingSkillHistoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var economy: JdbcEconomyRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray)

    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")))
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
        economy = JdbcEconomyRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private suspend fun player(): Player {
        val token = tokens.issue()
        val user = identities.bootstrap("Мохлик", tokens.issue().hash, token.hash, 365)
        return Player(user.id, user.publicId, token.hash)
    }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c -> c.economyUpdate(sql, *values).also { c.commit() } }
    private fun scalar(sql: String, vararg values: Any?): String = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getString(1) }.single()
    }
    private fun raw(p: Player) = scalar("SELECT jsonb_build_object('revision',revision,'state',state)::text FROM economy_profiles WHERE user_id=?", p.id)

    @Test fun `legacy history is read without a write then persisted once by an accepted command and its replay`() = runBlocking<Unit> {
        val p = player()
        economy.snapshot(p.hash) // A current shop cycle makes the following reads genuinely read-only.
        val original = source.connection.use { readEconomyProfile(it, p.id).state }
        val legacy = original.copy(
            buildings = original.buildings + mapOf("home" to 3, "workshop" to 2),
            workshopStarterClaimed = true,
            progression = original.progression.copy(skills = EconomyCraftSkills(cookingSeconds = 11, travelSeconds = 22)),
        )
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(legacy), p.id)
        val persistedBefore = raw(p)
        val before = economy.snapshot(p.hash)
        val skills = before.progression.skills!!
        assertEquals(1, skills.buildingHistoryVersion)
        assertEquals(12_600L, skills.buildingSeconds, "Home 2 + home 3 + workshop 2, without the free first workshop")
        assertEquals(11L, skills.cookingSeconds); assertEquals(22L, skills.travelSeconds)
        assertEquals(skills, JdbcEconomyRepository(source).snapshot(p.hash).progression.skills)
        assertEquals(persistedBefore, raw(p), "Reads cannot change either stored JSON or revision")

        val request = EconomyCommand(UUID.randomUUID().toString(), p.publicId, before.revision, "start_production", "grow_berries")
        assertEquals("ECONOMY_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
            economy.command(p.hash, request.copy(requestId = UUID.randomUUID().toString(), expectedRevision = before.revision + 1))
        }.code)
        assertEquals(persistedBefore, raw(p), "A rejected command must not save the projected history")
        val accepted = economy.command(p.hash, request)
        assertFalse(accepted.replayed)
        assertEquals(before.revision + 1, accepted.state.revision)
        assertEquals(skills, accepted.state.progression.skills)
        assertEquals("1", scalar("SELECT state #>> '{progression,skills,buildingHistoryVersion}' FROM economy_profiles WHERE user_id=?", p.id))
        assertEquals("12600", scalar("SELECT state #>> '{progression,skills,buildingSeconds}' FROM economy_profiles WHERE user_id=?", p.id))
        val persistedAfter = raw(p)
        val replay = JdbcEconomyRepository(source).command(p.hash, request)
        assertTrue(replay.replayed)
        assertEquals(accepted.state.revision, replay.state.revision)
        assertEquals(skills, replay.state.progression.skills)
        assertEquals(persistedAfter, raw(p), "Retrying an accepted command cannot add the same history twice")
        assertEquals("1", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(request.requestId)))
    }

    @Test fun `fresh and recreated starting profiles persist a known zero history behind the conversion fence`() = runBlocking<Unit> {
        val p = player()
        val first = economy.snapshot(p.hash)
        assertEquals(1, first.progression.skills!!.buildingHistoryVersion)
        assertEquals(0L, first.progression.skills!!.buildingSeconds)
        assertEquals("1", scalar("SELECT state #>> '{progression,skills,buildingHistoryVersion}' FROM economy_profiles WHERE user_id=?", p.id))
        assertEquals("1", scalar("SELECT count(*) FROM economy_conversion_audit WHERE user_id=?", p.id))
        execute("DELETE FROM economy_profiles WHERE user_id=?", p.id)
        val recreated = JdbcEconomyRepository(source).snapshot(p.hash)
        assertEquals(1, recreated.progression.skills!!.buildingHistoryVersion)
        assertEquals(0L, recreated.progression.skills!!.buildingSeconds)
        assertEquals("0", scalar("SELECT state #>> '{progression,skills,buildingSeconds}' FROM economy_profiles WHERE user_id=?", p.id))
        assertEquals("1", scalar("SELECT count(*) FROM economy_conversion_audit WHERE user_id=?", p.id))
        val saved = raw(p)
        assertEquals(recreated.progression.skills, economy.snapshot(p.hash).progression.skills)
        assertEquals(saved, raw(p))
    }

    @Test fun `refreshing expired merchant stock does not persist the read-only building history projection`() = runBlocking<Unit> {
        val p = player()
        val before = economy.snapshot(p.hash)
        val original = source.connection.use { readEconomyProfile(it, p.id).state }
        val legacy = original.copy(
            buildings = original.buildings + mapOf("home" to 3, "workshop" to 2),
            workshopStarterClaimed = true,
            progression = original.progression.copy(skills = EconomyCraftSkills()),
            fishingShop = null,
        )
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(legacy), p.id)
        val refreshed = economy.snapshot(p.hash)
        assertNotNull(refreshed.fishingShop)
        assertEquals(before.revision + 1, refreshed.revision, "Only the existing merchant refresh changes the revision")
        assertEquals(1, refreshed.progression.skills!!.buildingHistoryVersion)
        assertEquals(12_600L, refreshed.progression.skills!!.buildingSeconds)
        assertEquals("absent", scalar("SELECT coalesce(state #>> '{progression,skills,buildingHistoryVersion}','absent') FROM economy_profiles WHERE user_id=?", p.id))
        assertEquals("0", scalar("SELECT state #>> '{progression,skills,buildingSeconds}' FROM economy_profiles WHERE user_id=?", p.id))
        val saved = raw(p)
        assertEquals(refreshed.progression.skills, JdbcEconomyRepository(source).snapshot(p.hash).progression.skills)
        assertEquals(saved, raw(p))
    }
}
