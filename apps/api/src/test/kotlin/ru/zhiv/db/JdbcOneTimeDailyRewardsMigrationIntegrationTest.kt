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

@Testcontainers(disabledWithoutDocker=true)
class JdbcOneTimeDailyRewardsMigrationIntegrationTest {
    private class Postgres: PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres=Postgres()
    private fun execute(source: DataSource,sql: String,vararg values: Any?)=source.connection.use { c ->
        c.economyUpdate(sql,*values).also { c.commit() }
    }
    private fun scalar(source: DataSource,sql: String,vararg values: Any?): String=source.connection.use { c ->
        c.economyRows(sql,*values) { it.getString(1) }.single()
    }
    private fun retained(source: DataSource)=scalar(source,"""SELECT jsonb_build_object(
        'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM economy_profiles p),
        'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY source_key) FROM economy_ledger l),
        'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id,request_id) FROM game_reward_claims r),
        'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank) FROM flyway_schema_history h WHERE version::int<=63)
    )::text""")
    private fun verify(historical: Boolean) {
        val config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            if(historical) Flyway.configure().dataSource(source).locations("classpath:db/migration/history").load().migrate()
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("63").load().migrate()
            fun player(number: Int,next: Int?,last: Boolean=true): UUID {
                val user=UUID.randomUUID()
                execute(source,"INSERT INTO app_users(id,public_id,display_name) VALUES (?,?,'Saved gifts')",user,"0000-0000-${number.toString().padStart(4,'0')}")
                execute(source,"INSERT INTO economy_profiles(user_id,revision,state) VALUES (?,7,economy_v4_initial_state('{}',true))",user)
                if(next!=null) execute(source,"""INSERT INTO game_daily_rewards(user_id,next_step,last_claim_at,last_claim_date,onboarding_claimed_at)
                    VALUES (?,?,?::timestamptz,?::date,'2026-10-01T00:00:00Z')""",user,next,
                    if(last) "2026-10-17T00:00:00Z" else null,if(last) "2026-10-17" else null)
                return user
            }
            fun receipt(user: UUID,step: Int,date: String,origin: UUID=user) {
                val request=UUID.randomUUID()
                execute(source,"""INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,daily_date,claim,accepted_revision,claimed_at)
                    VALUES (?,?,?,'immutable-old-daily','daily',?::date,
                    jsonb_build_object('kind','daily','step',?::int,'reward',jsonb_build_object('coins',30,'pearls',80,'items','{}'::jsonb),'claimedAt',?::text),7,?::timestamptz)""",
                    user,origin,request,date,step,"${date}T00:00:00Z","${date}T00:00:00Z")
                execute(source,"""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items,created_at)
                    VALUES (?,?,'daily_reward',30,80,'{}'::jsonb,?::timestamptz)""",user,"reward:$request","${date}T00:00:00Z")
            }
            val fresh=player(1,1,false)
            val partial=player(2,4); receipt(partial,3,"2026-10-17")
            val wrapped=player(3,3); receipt(wrapped,7,"2026-10-10"); receipt(wrapped,2,"2026-10-17")
            val immediateWrap=player(4,1)
            val awaitingFinal=player(5,7); receipt(awaitingFinal,6,"2026-10-17")
            val missingRow=player(6,null); receipt(missingRow,7,"2026-10-17")
            val regressed=player(7,2); receipt(regressed,5,"2026-10-10",UUID.randomUUID()); receipt(regressed,1,"2026-10-17")
            val before=retained(source)
            DatabaseFactory.migrate(source)
            assertEquals("68",scalar(source,"SELECT max(version::int)::text FROM flyway_schema_history"))
            assertEquals(before,retained(source),"V64 must never change money, revisions, immutable claims, ledger or prior Flyway checksums")
            for((user,expected) in listOf(fresh to "1:false",partial to "4:false",wrapped to "7:true",immediateWrap to "7:true",
                awaitingFinal to "7:false",missingRow to "7:true",regressed to "6:false")) {
                assertEquals(expected,scalar(source,"SELECT next_step::text||':'||completed::text FROM game_daily_rewards WHERE user_id=?",user))
            }
            assertEquals("2026-10-01T00:00:00Z",scalar(source,
                "SELECT to_char(onboarding_claimed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM game_daily_rewards WHERE user_id=?",wrapped))
            assertEquals("23514",assertFailsWith<SQLException> {
                execute(source,"UPDATE game_daily_rewards SET next_step=1 WHERE user_id=?",wrapped) }.sqlState)
            assertEquals("23514",assertFailsWith<SQLException> {
                execute(source,"UPDATE game_daily_rewards SET completed=true WHERE user_id=?",fresh) }.sqlState)
            val rows=scalar(source,"SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id)::text FROM game_daily_rewards r")
            DatabaseFactory.migrate(source)
            assertEquals(rows,scalar(source,"SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id)::text FROM game_daily_rewards r"))
            assertEquals(before,retained(source),"Restart cannot replay a gift or alter paid history")
        }
    }
    @Test fun `baseline V64 completes former loops and preserves partial gifts and paid history`()=verify(false)
    @Test fun `historical V64 completes former loops and preserves partial gifts and paid history`()=verify(true)
}
