package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.*
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.game.*
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker=true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcProgressionRewardsIntegrationTest {
    private class Postgres(image: String): PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres=Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var rewards: JdbcProgressionRewardsRepository
    private lateinit var economy: JdbcEconomyRepository
    private val tokens=TokenCodec()
    private data class Player(val id: UUID,val publicId: String,val hash: ByteArray)
    @BeforeAll fun setup() {
        source=DatabaseFactory.create(AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost")))
        DatabaseFactory.migrate(source); identities=JdbcZhivRepository(source)
        rewards=JdbcProgressionRewardsRepository(source); economy=JdbcEconomyRepository(source)
    }
    @AfterAll fun close()=source.close()
    private suspend fun player(): Player {
        val token=tokens.issue(); val user=identities.bootstrap("Мохлик",tokens.issue().hash,token.hash,365)
        return Player(user.id,user.publicId,token.hash)
    }
    private fun execute(sql: String,vararg values: Any?)=source.connection.use { c -> c.economyUpdate(sql,*values).also { c.commit() } }
    private fun scalar(sql: String,vararg values: Any?): String=source.connection.use { c -> c.economyRows(sql,*values) { it.getString(1) }.single() }
    private fun command(p: Player,id: String=UUID.randomUUID().toString(),achievement: String?=null,level: Int?=null)=
        ProgressionRewardClaim(id,p.publicId,if(achievement==null) "daily" else "achievement",achievement,level)

    @Test fun `same key concurrency credits once and replay retains immutable receipt`()=runBlocking<Unit> {
        val p=player(); val initial=economy.snapshot(p.hash); val request=command(p)
        val both=List(2) { async(Dispatchers.IO) { rewards.claim(p.hash,request) } }.awaitAll()
        assertEquals(1,both.count { it.replayed }); assertEquals(both[0].claim,both[1].claim)
        assertEquals(initial.wallet.coins+300,economy.snapshot(p.hash).wallet.coins)
        assertEquals(initial.revision+1,economy.snapshot(p.hash).revision)
        assertEquals("1",scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='daily_reward'",p.id))
        val conflict=assertFailsWith<AuthFailure> { rewards.claim(p.hash,request.copy(kind="achievement",achievementId="first_path",level=1)) }
        assertEquals("REWARD_REQUEST_CONFLICT",conflict.code)
        assertEquals("DAILY_REWARD_COOLDOWN",assertFailsWith<AuthFailure> { rewards.claim(p.hash,command(p)) }.code)
    }
    @Test fun `ordinary economy cannot reuse a reward request UUID and reward cannot reuse economy UUID`()=runBlocking<Unit> {
        val p=player(); val paid=rewards.claim(p.hash,command(p))
        val reused=EconomyCommand(paid.requestId,p.publicId,paid.economy.revision,"start_exploration","forest")
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure> { economy.command(p.hash,reused) }.code)
        val ordinary=reused.copy(requestId=UUID.randomUUID().toString())
        economy.command(p.hash,ordinary)
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure> { rewards.claim(p.hash,command(p,ordinary.requestId)) }.code)
    }

    @Test fun `different keys serialize one daily claim and current date is server UTC`()=runBlocking<Unit> {
        val p=player(); val both=List(2) { async(Dispatchers.IO) { runCatching { rewards.claim(p.hash,command(p)) } } }.awaitAll()
        assertEquals(1,both.count { it.isSuccess }); assertEquals("DAILY_REWARD_COOLDOWN",(both.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        assertEquals("true",scalar("SELECT last_claim_date=(last_claim_at AT TIME ZONE 'UTC')::date FROM game_daily_rewards WHERE user_id=?",p.id))
    }
    @Test fun `storage failure leaves sequence and receipt intact and retries after capacity is freed`()=runBlocking<Unit> {
        val p=player(); rewards.snapshot(p.hash)
        val original=source.connection.use { readEconomyProfile(it,p.id).state }
        val capacity=EconomyRules.storage(original).capacity
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(original.copy(inventory=mapOf("wood" to capacity))),p.id)
        execute("UPDATE game_daily_rewards SET next_step=2,last_claim_at=clock_timestamp()-interval '25 hours',last_claim_date=((clock_timestamp()-interval '25 hours') AT TIME ZONE 'UTC')::date WHERE user_id=?",p.id)
        val request=command(p); val before=economy.snapshot(p.hash)
        assertEquals("ECONOMY_STORAGE_FULL",assertFailsWith<AuthFailure> { rewards.claim(p.hash,request) }.code)
        assertEquals(before.revision,economy.snapshot(p.hash).revision); assertEquals(2,rewards.snapshot(p.hash).daily.step)
        assertEquals("0",scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=?",p.id))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(original.copy(inventory=mapOf("wood" to capacity-3))),p.id)
        val success=rewards.claim(p.hash,request); assertFalse(success.replayed); assertEquals(2,success.claim.step)
        assertEquals(capacity-3,success.economy.inventory["wood"]); assertEquals(3L,success.economy.inventory["stone"])
    }
    @Test fun `final gift keeps all currencies when full and pays its relic once after retry`()=runBlocking<Unit> {
        val p=player(); rewards.snapshot(p.hash)
        val original=source.connection.use { readEconomyProfile(it,p.id).state }
        val capacity=EconomyRules.storage(original).capacity
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(original.copy(inventory=mapOf("wood" to capacity))),p.id)
        execute("UPDATE game_daily_rewards SET next_step=7,last_claim_at=NULL,last_claim_date=NULL WHERE user_id=?",p.id)
        val request=command(p); val before=economy.snapshot(p.hash)
        assertEquals("ECONOMY_STORAGE_FULL",assertFailsWith<AuthFailure> { rewards.claim(p.hash,request) }.code)
        assertEquals(before.wallet,economy.snapshot(p.hash).wallet)
        assertEquals(7,rewards.snapshot(p.hash).daily.step)
        assertEquals("0",scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=?",p.id))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(original.copy(inventory=mapOf("wood" to capacity-1))),p.id)
        val paid=rewards.claim(p.hash,request); val repeated=rewards.claim(p.hash,request)
        assertEquals(1L,paid.economy.inventory["ancient_core"])
        assertEquals(before.wallet.coins+500,paid.economy.wallet.coins)
        assertEquals(before.wallet.pearls+300,paid.economy.wallet.pearls)
        assertTrue(repeated.replayed); assertEquals(paid.claim,repeated.claim)
        assertEquals(paid.economy.wallet,repeated.economy.wallet)
        assertEquals(paid.economy.inventory,repeated.economy.inventory)
        assertEquals(1,repeated.rewards.daily.step)
    }
    @Test fun `admin award cannot pay until actual tier and ownership revocation cannot reset paid fence`()=runBlocking<Unit> {
        val p=player(); economy.snapshot(p.hash)
        source.connection.use { c -> recordAchievementTiers(c,p.id,"explorer",200,OffsetDateTime.now(),rewardEligible=false); c.commit() }
        assertTrue(rewards.snapshot(p.hash).achievementRewards.filter { it.achievementId=="explorer" }.all { it.blockedReason=="admin_grant" })
        val state=source.connection.use { readEconomyProfile(it,p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(state.copy(completedExplorations=10)),p.id)
        val rows=rewards.snapshot(p.hash).achievementRewards.filter { it.achievementId=="explorer" }
        assertTrue(rows[0].eligible); assertFalse(rows[1].eligible)
        val paid=rewards.claim(p.hash,command(p,achievement="explorer",level=1))
        execute("DELETE FROM game_achievements WHERE user_id=? AND achievement_id='explorer'",p.id)
        assertEquals(paid.claim.claimedAt,rewards.snapshot(p.hash).achievementRewards.single { it.achievementId=="explorer" && it.level==1 }.claimedAt)
        assertEquals("ACHIEVEMENT_REWARD_CLAIMED",assertFailsWith<AuthFailure> { rewards.claim(p.hash,command(p,achievement="explorer",level=1)) }.code)
    }
    @Test fun `historical owned tier is eligible and manual pearl credits have ledger and revision`()=runBlocking<Unit> {
        val p=player(); val initial=economy.snapshot(p.hash)
        execute("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'thousand_taps','2020-01-01T00:00:00Z')",p.id)
        val row=rewards.snapshot(p.hash).achievementRewards.single { it.achievementId=="thousand_taps" }
        assertTrue(row.eligible); assertEquals("2020-01-01T00:00:00Z",row.earnedAt)
        val command=command(p,achievement="thousand_taps",level=1); val paid=rewards.claim(p.hash,command)
        assertEquals(initial.wallet.pearls+50,paid.economy.wallet.pearls); assertEquals(initial.revision+1,paid.acceptedRevision)
        assertEquals("50",scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND source_key=?",p.id,"reward:${command.requestId}"))
        assertEquals(paid.claim,rewards.claim(p.hash,command).claim)
    }
    @Test fun `reward merge unions paid tiers and receipts retaining latest daily without crediting twice`()=runBlocking<Unit> {
        val left=player(); val right=player(); val leftClaim=rewards.claim(left.hash,command(left)); val rightClaim=rewards.claim(right.hash,command(right))
        // Both original accounts claimed the same UTC date. Origin fences preserve both request keys.
        source.connection.use { c ->
            c.autoCommit=false
            c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE",left.id,right.id) { true }
            mergeProgressionRewards(c,left.id,right.id); c.commit()
        }
        assertEquals("2",scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=?",left.id))
        assertEquals(rightClaim.rewards.daily.lastClaimAt,rewards.snapshot(left.hash).daily.lastClaimAt)
        assertEquals(leftClaim.economy.wallet,rewards.claim(left.hash,command(left,leftClaim.requestId)).economy.wallet)
        assertEquals("DAILY_REWARD_COOLDOWN",assertFailsWith<AuthFailure> { rewards.claim(left.hash,command(left)) }.code)
        assertEquals("REWARD_REQUEST_CONFLICT",assertFailsWith<AuthFailure> { rewards.claim(left.hash,command(left,rightClaim.requestId)) }.code)
    }
}
