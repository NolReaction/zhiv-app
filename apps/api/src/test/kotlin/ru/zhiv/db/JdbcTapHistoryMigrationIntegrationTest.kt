package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.AdminConfig
import ru.zhiv.admin.AdminGrantRequest
import ru.zhiv.admin.AdminPlayerCommand
import ru.zhiv.config.AppConfig
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcTapHistoryMigrationIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }

    @Test fun `V28 keeps populated V27 data aggregates remaining seconds and accepts new awards`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("27").cleanDisabled(true).load().migrate()
            val admin = UUID.randomUUID(); val target = UUID.randomUUID()
            val key = ByteArray(32) { 8 }; val oldAudit = UUID.randomUUID()
            val oldAwardAt = OffsetDateTime.parse("2026-08-01T12:00:00Z")
            source.connection.use { c ->
                fun write(sql: String, vararg values: Any?) = c.prepareStatement(sql).use { s ->
                    values.forEachIndexed { i, value -> s.setObject(i+1, value) }; s.executeUpdate()
                }
                write("INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0001','Admin'),(?,'0000-0000-0002','Player')", admin, target)
                write("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 day')", admin, key)
                write("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'hundred_series',?)", target, oldAwardAt)
                // A real V27 aggregate includes the version and all resource balances.
                write("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)", target,
                    """{"schemaVersion":1,"resources":{"sparks":0,"wood":0,"stone":0},"houseLevel":3,"collection":["acorn"]}""")
                write("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,
                    action,reason,affected_sessions,reward_id,granted)
                    VALUES (?,?,?,'0000-0000-0001','0000-0000-0002','grant_achievement','Existing valid legacy award',0,'hundred_series',true)""", oldAudit, admin, target)
                write("""INSERT INTO game_tap_activity_seconds(user_id,bucket_at,received_taps,rejected_taps,event_taps,delayed_taps,legacy_taps,
                    interval_count,interval_sum_ms,interval_squared_sum_ms) VALUES
                    (?,date_trunc('minute',clock_timestamp())-interval '1 hour'+interval '1 second',2,1,2,1,0,2,1000,500000),
                    (?,date_trunc('minute',clock_timestamp())-interval '1 hour'+interval '2 seconds',3,0,3,0,1,3,1500,750000)""", target, target)
                c.commit()
            }
            DatabaseFactory.migrate(source)
            val repo = JdbcAdminRepository(source, AdminConfig(setOf("0000-0000-0001")))
            val first = repo.tapHistory(key, "0000-0000-0002").minutes.single()
            assertEquals(5L, first.receivedTaps)
            assertEquals(1L, first.rejectedTaps)
            assertEquals(5L, first.eventTaps)
            assertEquals(1L, first.delayedTaps)
            assertEquals(1L, first.legacyTaps)
            assertEquals(5L, first.intervalCount)
            assertEquals(2500.0, first.intervalSumMs)
            assertEquals(1250000.0, first.intervalSquaredSumMs)
            assertTrue(first.complete)
            assertFalse(first.reviewSignal)
            assertEquals(3, repo.player(key, "0000-0000-0002").world.houseLevel)
            assertEquals(listOf("acorn"), repo.player(key, "0000-0000-0002").world.collection)
            assertEquals(oldAudit.toString(), repo.audit(key, 0, 25).events.single().requestId)
            source.connection.use { c ->
                c.prepareStatement("SELECT unlocked_at FROM game_achievements WHERE user_id=? AND achievement_id='hundred_series'").use { s ->
                    s.setObject(1, target)
                    s.executeQuery().use { row -> assertTrue(row.next()); assertEquals(oldAwardAt.toInstant(), row.getObject(1, OffsetDateTime::class.java).toInstant()) }
                }
            }
            DatabaseFactory.migrate(source)
            assertEquals(first, repo.tapHistory(key, "0000-0000-0002").minutes.single(), "Flyway replay cannot duplicate the backfill")
            val grantId = UUID.randomUUID()
            assertTrue(repo.grantReward(key, "0000-0000-0002", grantId,
                AdminGrantRequest(grantId.toString(), "0000-0000-0002", "achievement", "full_collection", "Verify new achievement constraint")).granted)
            assertEquals(2L, repo.audit(key, 0, 25).total)
            val request = AdminPlayerCommand(UUID.randomUUID().toString(), "0000-0000-0002", "Verify new fishing inventory", "grant_world_item", "willow_rod")
            assertTrue(repo.managePlayer(key, "0000-0000-0002", UUID.fromString(request.requestId), request).changed)
            assertTrue("willow_rod" in repo.player(key, "0000-0000-0002").world.inventory)
        }
    }
}
