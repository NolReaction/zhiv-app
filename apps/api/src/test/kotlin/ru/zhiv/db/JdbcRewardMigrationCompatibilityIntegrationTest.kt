package ru.zhiv.db

import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcRewardMigrationCompatibilityIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    @TempDir lateinit var branchDirectory: Path
    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String): String = source.connection.use { c ->
        c.economyRows(sql) { it.getString(1) }.single()
    }
    private fun history(source: DataSource, where: String = "true") = scalar(source,
        "SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE $where")
    private fun rewardHistory(source: DataSource) = scalar(source, """SELECT
        (to_jsonb(h)-'version'-'script')::text FROM flyway_schema_history h WHERE script LIKE '%economy_reward_promises.sql'""")
    private fun legacy(test: (DataSource) -> Unit) {
        val scripts = listOf("B49__current_schema.sql") + canonicalTailScripts.filterKeys { it <= 70 }.values
        scripts.forEach { name -> javaClass.getResourceAsStream("/db/migration/$name")!!.use { Files.copy(it, branchDirectory.resolve(name)) } }
        javaClass.getResourceAsStream("/db/migration/V73__economy_reward_promises.sql")!!.use {
            Files.copy(it, branchDirectory.resolve("V71__economy_reward_promises.sql"))
        }
        DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))).use { source ->
            Flyway.configure().dataSource(source).locations("filesystem:$branchDirectory").load().migrate()
            val user = UUID.randomUUID()
            execute(source, "INSERT INTO app_users(id,public_id,display_name) VALUES(?,'0000-0000-0071','Reward branch')", user)
            execute(source, "INSERT INTO economy_profiles(user_id,revision,state) VALUES(?,12,economy_v4_initial_state('{}',true))", user)
            execute(source, "INSERT INTO game_daily_rewards(user_id,next_step) VALUES(?,3)", user)
            execute(source, """INSERT INTO player_mail_messages(user_id,source_key,type,title,body,notify,welcome_pearls)
                VALUES(?,'welcome:v1','event','Welcome','Saved thirty',false,30)""", user)
            test(source)
        }
    }
    private fun promises(source: DataSource): List<String> = listOf("economy_profiles", "game_daily_rewards", "player_mail_messages")
        .map { table -> scalar(source, "SELECT jsonb_agg(to_jsonb(t)-'achievement_reward_version')::text FROM $table t") }
    private fun assertFinished(source: DataSource) {
        assertEquals("78", scalar(source, "SELECT max(version::int)::text FROM flyway_schema_history"))
        assertEquals("30", scalar(source, "SELECT count(*)::text FROM flyway_schema_history"))
        assertEquals("V73__economy_reward_promises.sql", scalar(source, "SELECT script FROM flyway_schema_history WHERE version='73'"))
        assertEquals("7", scalar(source, "SELECT economy_v4_initial_state('{}',true)#>>'{tutorialOrder,rewardVersion}'"))
        assertEquals("true", scalar(source, "SELECT (to_regclass('neighbor_settings') IS NOT NULL)::text"))
    }

    @Test fun `known former reward V71 becomes V73 without replaying SQL or changing promises`() = legacy { source ->
        val before = promises(source); val prefix = history(source, "version::int<=70"); val reward = rewardHistory(source)
        migrateWithLegacyAdminHistory(source)
        assertFinished(source)
        assertEquals(before, promises(source)); assertEquals(prefix, history(source, "version::int<=70"))
        assertEquals(reward, rewardHistory(source), "Rank/checksum/time/success remain unchanged")
        val complete = history(source)
        migrateWithLegacyAdminHistory(source)
        DatabaseFactory.migrate(source)
        assertEquals(complete, history(source)); assertEquals(before, promises(source))
    }

    @Test fun `interruption after metadata relabel safely resumes missing neighbor migrations`() = legacy { source ->
        val before = promises(source)
        assertTrue(normalizeLegacyRewardPromiseHistory(source))
        val normalized = history(source)
        assertTrue(normalizeLegacyRewardPromiseHistory(source)); assertEquals(normalized, history(source))
        migrateWithLegacyAdminHistory(source)
        assertFinished(source); assertEquals(before, promises(source))
    }

    @Test fun `interruption after neighbor V71 resumes only V72 and newer migrations`() = legacy { source ->
        val before = promises(source)
        assertTrue(normalizeLegacyRewardPromiseHistory(source))
        Flyway.configure().dataSource(source).locations("classpath:db/migration").outOfOrder(true)
            .target("71").load().migrate()
        assertEquals("1", scalar(source, "SELECT count(*)::text FROM flyway_schema_history WHERE version='71'"))
        assertTrue(normalizeLegacyRewardPromiseHistory(source))
        migrateWithLegacyAdminHistory(source)
        assertFinished(source); assertEquals(before, promises(source))
    }

    @Test fun `unknown checksum script prefix future or failed history never receives a repair`() = legacy { source ->
        val changes = listOf(
            "UPDATE flyway_schema_history SET checksum=checksum+1 WHERE version='71'" to "UPDATE flyway_schema_history SET checksum=checksum-1 WHERE version='71'",
            "UPDATE flyway_schema_history SET script='V71__unknown.sql' WHERE version='71'" to "UPDATE flyway_schema_history SET script='V71__economy_reward_promises.sql' WHERE version='71'",
            "UPDATE flyway_schema_history SET checksum=checksum+1 WHERE version='70'" to "UPDATE flyway_schema_history SET checksum=checksum-1 WHERE version='70'",
            "UPDATE flyway_schema_history SET checksum=checksum+1 WHERE version='49'" to "UPDATE flyway_schema_history SET checksum=checksum-1 WHERE version='49'",
            "UPDATE flyway_schema_history SET success=false WHERE version='71'" to "UPDATE flyway_schema_history SET success=true WHERE version='71'",
            "UPDATE flyway_schema_history SET version='76' WHERE version='71'" to "UPDATE flyway_schema_history SET version='71' WHERE version='76'",
        )
        changes.forEach { (change, restore) ->
            execute(source, change); val before = history(source); val data = promises(source)
            assertFailsWith<IllegalStateException> { migrateWithLegacyAdminHistory(source) }
            assertEquals(before, history(source)); assertEquals(data, promises(source)); execute(source, restore)
        }
        migrateWithLegacyAdminHistory(source); assertFinished(source)
    }

    @Test fun `incompatible reward schema blocks relabel even with an authentic checksum`() = legacy { source ->
        execute(source, "ALTER TABLE game_daily_rewards ALTER COLUMN reward_catalog_version SET DEFAULT 99")
        val before = history(source)
        assertFailsWith<IllegalStateException> { migrateWithLegacyAdminHistory(source) }
        assertEquals(before, history(source))
    }
}
