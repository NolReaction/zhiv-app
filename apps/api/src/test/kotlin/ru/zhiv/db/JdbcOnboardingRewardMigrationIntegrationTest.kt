package ru.zhiv.db

import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import java.sql.SQLException
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

@Testcontainers(disabledWithoutDocker = true)
class JdbcOnboardingRewardMigrationIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    private fun execute(source: DataSource, sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(source: DataSource, sql: String, vararg values: Any?): String = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getString(1) }.single()
    }
    private fun retained(source: DataSource) = scalar(source, """SELECT jsonb_build_object(
        'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM economy_profiles p),
        'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY source_key) FROM economy_ledger l),
        'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM game_reward_claims r),
        'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank) FROM flyway_schema_history h WHERE version::int<=58)
    )::text""")

    private fun verify(historical: Boolean) {
        val config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            if(historical) Flyway.configure().dataSource(source).locations("classpath:db/migration/history").load().migrate()
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("58").load().migrate()
            val user=UUID.randomUUID()
            execute(source,"INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0059','Saved course')",user)
            execute(source,"INSERT INTO economy_profiles(user_id,revision,state) VALUES (?,7,economy_v4_initial_state('{}',true))",user)
            execute(source,"""INSERT INTO game_daily_rewards(user_id,next_step,last_claim_at,last_claim_date)
                VALUES (?,2,'2026-10-17T00:00:00Z','2026-10-17')""",user)
            execute(source,"""INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,daily_date,claim,accepted_revision,claimed_at)
                VALUES (?,?,?,'old-daily','daily','2026-10-17','{"kind":"daily","step":1,"reward":{"coins":30,"pearls":80,"items":{}},"claimedAt":"2026-10-17T00:00:00Z"}',7,'2026-10-17T00:00:00Z')""",
                user,user,UUID.randomUUID())
            val before=retained(source)
            val daily=scalar(source,"SELECT (to_jsonb(r)-'onboarding_claimed_at'-'completed'-'reward_catalog_version')::text FROM game_daily_rewards r WHERE user_id=?",user)
            DatabaseFactory.migrate(source)
            assertEquals("78",scalar(source,"SELECT max(version::int)::text FROM flyway_schema_history"))
            assertEquals(before,retained(source),"Migration never awards an old local completion or rewrites money and receipts")
            assertEquals(daily,scalar(source,"SELECT (to_jsonb(r)-'onboarding_claimed_at'-'completed'-'reward_catalog_version')::text FROM game_daily_rewards r WHERE user_id=?",user))
            assertEquals("true",scalar(source,"SELECT (onboarding_claimed_at IS NULL)::text FROM game_daily_rewards WHERE user_id=?",user))
            val insert="""INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,claim,accepted_revision,claimed_at)
                VALUES (?,?,?,'intentional-completion',?,'{"kind":"onboarding","reward":{"coins":1000,"pearls":200,"items":{}},"claimedAt":"2026-10-18T00:00:00Z"}',8,'2026-10-18T00:00:00Z')"""
            execute(source,insert,user,user,UUID.randomUUID(),"onboarding")
            assertEquals("23505",assertFailsWith<SQLException> {
                execute(source,insert,user,user,UUID.randomUUID(),"onboarding") }.sqlState)
            assertEquals("23514",assertFailsWith<SQLException> {
                execute(source,insert,user,UUID.randomUUID(),UUID.randomUUID(),"forged") }.sqlState)
            // Another origin's already-paid receipt remains importable during account merge.
            execute(source,insert,user,UUID.randomUUID(),UUID.randomUUID(),"onboarding")
            val after=retained(source)
            DatabaseFactory.migrate(source)
            assertEquals(after,retained(source),"Restart cannot replay a reward migration")
        }
    }
    @Test fun `baseline V59 preserves paid data and adds the onboarding payout fence`() = verify(false)
    @Test fun `historical V59 preserves paid data and adds the onboarding payout fence`() = verify(true)
}
