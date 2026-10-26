package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.*
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
import ru.zhiv.game.*
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

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
    private suspend fun completeTutorial(p: Player): EconomyView {
        val before=economy.snapshot(p.hash)
        val state=source.connection.use { readEconomyProfile(it,p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(
            state.copy(inventory=state.inventory+("berries" to 1L))),p.id)
        return economy.command(p.hash,EconomyCommand(UUID.randomUUID().toString(),p.publicId,before.revision,
            "complete_resident_order","tutorial_first_order")).state
    }

    @Test fun `initialized snapshots do not wait for the gameplay mutation lock or write reward rows`()=runBlocking<Unit> {
        val p=player(); val initial=rewards.snapshot(p.hash)
        val stored=scalar("SELECT row_to_json(r)::text FROM game_daily_rewards r WHERE user_id=?",p.id)
        source.connection.use { locked ->
            locked.autoCommit=false
            locked.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",p.id) { true }
            try {
                val snapshots=withTimeout(2_000) { List(3) { async(Dispatchers.IO) { rewards.snapshot(p.hash) } }.awaitAll() }
                assertTrue(snapshots.all { it.ownerPublicId==p.publicId && it.daily.step==initial.daily.step })
                assertTrue(snapshots.all { it.achievementRewards==initial.achievementRewards })
            } finally { locked.rollback() }
        }
        assertEquals(stored,scalar("SELECT row_to_json(r)::text FROM game_daily_rewards r WHERE user_id=?",p.id))
        assertEquals("0",scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=?",p.id))
    }

    @Test fun `historical reconciliation remains durable and subsequent reads no longer lock`()=runBlocking<Unit> {
        val p=player(); rewards.snapshot(p.hash)
        val state=source.connection.use { readEconomyProfile(it,p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(state.copy(completedExplorations=10)),p.id)
        val discovered=rewards.snapshot(p.hash).achievementRewards.single { it.achievementId=="explorer" && it.level==1 }
        assertTrue(discovered.eligible)
        assertEquals("true",scalar("SELECT reward_eligible::text FROM game_achievement_tiers WHERE user_id=? AND achievement_id='explorer' AND level=1",p.id))
        assertEquals(discovered,rewards.snapshot(p.hash).achievementRewards.single { it.achievementId=="explorer" && it.level==1 })
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",p.hash)
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure> { rewards.snapshot(p.hash) }.code)
    }

    @Test fun `parallel early onboarding claims cannot earn or consume the UUID before the actual lesson`()=runBlocking<Unit> {
        val p=player(); val initial=economy.snapshot(p.hash); val request=command(p).copy(kind="onboarding")
        val results=List(6) { index -> async(Dispatchers.IO) {
            runCatching { rewards.claim(p.hash,if(index%2==0) request else command(p).copy(kind="onboarding")) }
        } }.awaitAll()
        assertTrue(results.all { (it.exceptionOrNull() as? AuthFailure)?.code=="ONBOARDING_REWARD_UNAVAILABLE" })
        assertEquals(initial.wallet,economy.snapshot(p.hash).wallet)
        assertEquals(initial.revision,economy.snapshot(p.hash).revision)
        assertEquals("0",scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=?",p.id))
        val qualified=completeTutorial(p)
        val paid=rewards.claim(p.hash,request)
        assertFalse(paid.replayed); assertEquals(qualified.wallet.coins+100,paid.economy.wallet.coins)
        assertEquals(paid.claim,rewards.claim(p.hash,request).claim)
    }

    @Test fun `onboarding concurrent same and distinct UUIDs pay one fixed gift independently of daily`()=runBlocking<Unit> {
        val p=player(); val before=completeTutorial(p)
        assertEquals(null,rewards.snapshot(p.hash).onboarding.claimedAt)
        assertEquals(before.wallet,economy.snapshot(p.hash).wallet,"A snapshot does not reward historical local tutorial state")
        val request=command(p).copy(kind="onboarding")
        val same=List(2) { async(Dispatchers.IO) { rewards.claim(p.hash,request) } }.awaitAll()
        assertEquals(1,same.count { it.replayed }); assertEquals(same[0].claim,same[1].claim)
        val paid=same.first()
        assertEquals(ProgressionRewardRules.onboarding,paid.claim.reward)
        assertEquals(before.wallet.coins+100,paid.economy.wallet.coins)
        assertEquals(before.wallet.pearls+20,paid.economy.wallet.pearls)
        assertEquals(before.inventory,paid.economy.inventory)
        assertEquals(before.revision+1,paid.economy.revision)
        assertEquals(paid.claim.claimedAt,rewards.snapshot(p.hash).onboarding.claimedAt)
        assertEquals("1",scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='onboarding_reward'",p.id))
        assertTrue(paid.rewards.daily.claimable); assertEquals(1,paid.rewards.daily.step)
        assertEquals("REWARD_REQUEST_CONFLICT",assertFailsWith<AuthFailure> { rewards.claim(p.hash,request.copy(kind="daily")) }.code)
        assertEquals("ONBOARDING_REWARD_CLAIMED",assertFailsWith<AuthFailure> { rewards.claim(p.hash,command(p).copy(kind="onboarding")) }.code)
        val other=player(); completeTutorial(other); val different=List(2) { async(Dispatchers.IO) {
            runCatching { rewards.claim(other.hash,command(other).copy(kind="onboarding")) }
        } }.awaitAll()
        assertEquals(1,different.count { it.isSuccess })
        assertEquals("ONBOARDING_REWARD_CLAIMED",(different.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
    }

    @Test fun `onboarding wallet failure rolls back the marker and same UUID succeeds later with full pantry`()=runBlocking<Unit> {
        val p=player(); completeTutorial(p)
        val original=source.connection.use { readEconomyProfile(it,p.id).state }
        val capacity=EconomyRules.storage(original).capacity
        val full=original.copy(wallet=original.wallet.copy(pearls=ECONOMY_MAX_PEARLS-10),inventory=mapOf("wood" to capacity))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(full),p.id)
        val request=command(p).copy(kind="onboarding"); val before=economy.snapshot(p.hash)
        assertEquals("ECONOMY_CAPACITY",assertFailsWith<AuthFailure> { rewards.claim(p.hash,request) }.code)
        assertEquals(before.wallet,economy.snapshot(p.hash).wallet); assertEquals(before.revision,economy.snapshot(p.hash).revision)
        assertEquals(null,rewards.snapshot(p.hash).onboarding.claimedAt)
        assertEquals("0",scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=?",p.id))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(full.copy(wallet=original.wallet)),p.id)
        val paid=rewards.claim(p.hash,request)
        assertFalse(paid.replayed); assertEquals(capacity,paid.economy.storage.used)
        assertEquals(original.wallet.pearls+20,paid.economy.wallet.pearls)
        assertEquals(paid.claim,rewards.claim(p.hash,request).claim)
    }

    @Test fun `onboarding merge preserves source fence despite target newer daily and retains both paid origins`()=runBlocking<Unit> {
        val target=player(); val origin=player(); completeTutorial(origin)
        val sourcePaid=rewards.claim(origin.hash,command(origin).copy(kind="onboarding"))
        rewards.claim(target.hash,command(target))
        val before=economy.snapshot(target.hash)
        source.connection.use { c -> c.autoCommit=false; mergeProgressionRewards(c,target.id,origin.id); c.commit() }
        assertEquals(sourcePaid.claim.claimedAt,rewards.snapshot(target.hash).onboarding.claimedAt)
        assertEquals(before.wallet,economy.snapshot(target.hash).wallet,"Merging payout fences never credits currencies")
        assertEquals("ONBOARDING_REWARD_CLAIMED",assertFailsWith<AuthFailure> { rewards.claim(target.hash,command(target).copy(kind="onboarding")) }.code)
        val second=player(); completeTutorial(second); rewards.claim(second.hash,command(second).copy(kind="onboarding"))
        source.connection.use { c -> c.autoCommit=false; mergeProgressionRewards(c,target.id,second.id); c.commit() }
        assertEquals("2",scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=? AND kind='onboarding'",target.id))
        assertEquals("ONBOARDING_REWARD_CLAIMED",assertFailsWith<AuthFailure> { rewards.claim(target.hash,command(target).copy(kind="onboarding")) }.code)
    }

    @Test fun `v6 accepted tutorial and daily course survive reset merge and replay after fresh v7 rollout`()=runBlocking<Unit> {
        val legacy=player(); completeTutorial(legacy); rewards.snapshot(legacy.hash)
        val original=source.connection.use { readEconomyProfile(it,legacy.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(
            original.copy(tutorialOrder=original.tutorialOrder.copy(rewardVersion=6))),legacy.id)
        execute("UPDATE game_daily_rewards SET reward_catalog_version=6 WHERE user_id=?",legacy.id)
        assertEquals(300L,rewards.snapshot(legacy.hash).daily.cycle.sumOf { it.reward.pearls })
        val tutorialRequest=command(legacy).copy(kind="onboarding")
        val tutorial=rewards.claim(legacy.hash,tutorialRequest)
        assertEquals(40L,tutorial.claim.reward.pearls)
        assertEquals(original.wallet.pearls+40,tutorial.economy.wallet.pearls)
        val dailyRequest=command(legacy); val daily=rewards.claim(legacy.hash,dailyRequest)
        assertEquals(20L,daily.claim.reward.pearls)
        assertEquals(daily.claim,rewards.claim(legacy.hash,dailyRequest).claim)
        execute("DELETE FROM economy_profiles WHERE user_id=?",legacy.id)
        economy.snapshot(legacy.hash)
        assertEquals(300L,rewards.snapshot(legacy.hash).daily.cycle.sumOf { it.reward.pearls })
        assertEquals(tutorial.claim,rewards.claim(legacy.hash,tutorialRequest).claim)
        val fresh=player(); val before=economy.snapshot(fresh.hash); rewards.snapshot(fresh.hash)
        assertEquals(140L,rewards.snapshot(fresh.hash).daily.cycle.sumOf { it.reward.pearls })
        source.connection.use { c -> mergeProgressionRewards(c,fresh.id,legacy.id); c.commit() }
        assertEquals("6",scalar("SELECT reward_catalog_version::text FROM game_daily_rewards WHERE user_id=?",fresh.id))
        assertEquals(300L,rewards.snapshot(fresh.hash).daily.cycle.sumOf { it.reward.pearls })
        assertEquals(before.wallet,economy.snapshot(fresh.hash).wallet)
        assertEquals("DAILY_REWARD_COOLDOWN",assertFailsWith<AuthFailure> { rewards.claim(fresh.hash,command(fresh)) }.code)
        assertEquals("ONBOARDING_REWARD_CLAIMED",assertFailsWith<AuthFailure> { rewards.claim(fresh.hash,command(fresh).copy(kind="onboarding")) }.code)
    }

    @Test fun `same key concurrency credits once and replay retains immutable receipt`()=runBlocking<Unit> {
        val p=player(); val initial=economy.snapshot(p.hash); val request=command(p)
        val both=List(2) { async(Dispatchers.IO) { rewards.claim(p.hash,request) } }.awaitAll()
        assertEquals(1,both.count { it.replayed }); assertEquals(both[0].claim,both[1].claim)
        assertEquals(initial.wallet.coins+30,economy.snapshot(p.hash).wallet.coins)
        assertEquals(initial.wallet.pearls+10,economy.snapshot(p.hash).wallet.pearls)
        assertEquals(7,rewards.snapshot(p.hash).catalogVersion)
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

    @Test fun `daily uses completed server house and replay preserves the originally granted tier`()=runBlocking<Unit> {
        val p=player(); val preview=rewards.snapshot(p.hash)
        assertEquals(1,preview.daily.homeLevel)
        val original=source.connection.use { readEconomyProfile(it,p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(original.copy(
            buildings=original.buildings+mapOf("home" to 4,"warehouse" to 4),productionSlots=mapOf("workshop" to 3))),p.id)
        val request=command(p); val paid=rewards.claim(p.hash,request)
        assertEquals(ProgressionRewardRules.dailyCycle(4)[0],paid.claim.reward)
        val after=source.connection.use { readEconomyProfile(it,p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(after.copy(
            buildings=after.buildings+("home" to 5))),p.id)
        val replay=rewards.claim(p.hash,request)
        assertTrue(replay.replayed); assertEquals(paid.claim,replay.claim)
        assertEquals(paid.economy.wallet,replay.economy.wallet)
        assertEquals(5,replay.rewards.daily.homeLevel)
    }

    @Test fun `different keys serialize one daily claim and current date is server UTC`()=runBlocking<Unit> {
        val p=player(); val both=List(2) { async(Dispatchers.IO) { runCatching { rewards.claim(p.hash,command(p)) } } }.awaitAll()
        assertEquals(1,both.count { it.isSuccess }); assertEquals("DAILY_REWARD_COOLDOWN",(both.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        assertTrue(source.connection.use { c ->
            c.economyRows("SELECT last_claim_date=(last_claim_at AT TIME ZONE 'UTC')::date FROM game_daily_rewards WHERE user_id=?",p.id) {
                it.getBoolean(1)
            }.single()
        },"the daily claim date must match its server timestamp in UTC")
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
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(original.copy(inventory=mapOf("wood" to capacity-4))),p.id)
        val success=rewards.claim(p.hash,request); assertFalse(success.replayed); assertEquals(2,success.claim.step)
        assertEquals(capacity-4,success.economy.inventory["wood"]); assertEquals(2L,success.economy.inventory["fiber"]); assertEquals(2L,success.economy.inventory["berries"])
        assertEquals(capacity,success.economy.storage.used)
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
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(original.copy(inventory=mapOf("wood" to capacity-3))),p.id)
        val paid=rewards.claim(p.hash,request); val repeated=rewards.claim(p.hash,request)
        assertEquals(1L,paid.economy.inventory["ancient_core"])
        assertEquals(before.wallet.coins+80,paid.economy.wallet.coins)
        assertEquals(before.wallet.pearls+40,paid.economy.wallet.pearls)
        assertEquals(capacity,paid.economy.storage.used)
        assertTrue(repeated.replayed); assertEquals(paid.claim,repeated.claim)
        assertEquals(paid.economy.wallet,repeated.economy.wallet)
        assertEquals(paid.economy.inventory,repeated.economy.inventory)
        assertEquals(7,repeated.rewards.daily.step)
        assertTrue(repeated.rewards.daily.completed)
        assertFalse(repeated.rewards.daily.claimable)
        assertEquals(null,repeated.rewards.daily.nextClaimAt)
        assertEquals("DAILY_REWARD_COMPLETED",assertFailsWith<AuthFailure> { rewards.claim(p.hash,command(p)) }.code)
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
    @Test fun `parallel final gift pays once and survives reload time and economy reset`()=runBlocking<Unit> {
        val p=player(); val before=economy.snapshot(p.hash); rewards.snapshot(p.hash)
        execute("UPDATE game_daily_rewards SET next_step=7 WHERE user_id=?",p.id)
        val request=command(p)
        val attempts=List(4) { index -> async(Dispatchers.IO) {
            runCatching { rewards.claim(p.hash,if(index<2) request else command(p)) }
        } }.awaitAll()
        val success=attempts.mapNotNull { it.getOrNull() }
        assertTrue(success.size in 1..2); assertEquals(1,success.count { !it.replayed })
        assertTrue(attempts.filter { it.isFailure }.all { (it.exceptionOrNull() as AuthFailure).code=="DAILY_REWARD_COMPLETED" })
        val paid=success.first()
        assertEquals(before.wallet.pearls+40,paid.economy.wallet.pearls)
        assertEquals(1L,paid.economy.inventory["ancient_core"])
        assertEquals("1",scalar("SELECT count(*) FROM game_reward_claims WHERE user_id=? AND kind='daily'",p.id))
        assertEquals("1",scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='daily_reward'",p.id))
        // A new repository instance and an elapsed cooldown cannot start another round.
        val reloaded=JdbcProgressionRewardsRepository(source)
        execute("UPDATE game_daily_rewards SET last_claim_at=clock_timestamp()-interval '90 days',last_claim_date=((clock_timestamp()-interval '90 days') AT TIME ZONE 'UTC')::date WHERE user_id=?",p.id)
        val complete=reloaded.snapshot(p.hash).daily
        assertTrue(complete.completed); assertFalse(complete.claimable); assertEquals(null,complete.nextClaimAt)
        assertEquals("DAILY_REWARD_COMPLETED",assertFailsWith<AuthFailure> { reloaded.claim(p.hash,command(p)) }.code)
        // Administrative gameplay reset only removes the economy profile, not account payouts.
        execute("DELETE FROM economy_profiles WHERE user_id=?",p.id)
        val reset=economy.snapshot(p.hash)
        assertTrue(reloaded.snapshot(p.hash).daily.completed)
        assertEquals("DAILY_REWARD_COMPLETED",assertFailsWith<AuthFailure> { reloaded.claim(p.hash,command(p)) }.code)
        val replay=reloaded.claim(p.hash,command(p,paid.requestId))
        assertTrue(replay.replayed); assertEquals(paid.claim,replay.claim)
        assertEquals(reset.wallet,replay.economy.wallet)
        assertEquals(reset.revision,replay.economy.revision)
    }
    @Test fun `merge never regresses gift progress and completion survives either merge direction`()=runBlocking<Unit> {
        val advanced=player(); val recent=player()
        rewards.snapshot(advanced.hash); rewards.snapshot(recent.hash)
        execute("UPDATE game_daily_rewards SET next_step=6,last_claim_at=clock_timestamp()-interval '50 hours',last_claim_date=((clock_timestamp()-interval '50 hours') AT TIME ZONE 'UTC')::date WHERE user_id=?",advanced.id)
        val latest=rewards.claim(recent.hash,command(recent)).rewards.daily.lastClaimAt
        source.connection.use { c -> mergeProgressionRewards(c,advanced.id,recent.id); c.commit() }
        val combined=rewards.snapshot(advanced.hash).daily
        assertEquals(6,combined.step); assertEquals(latest,combined.lastClaimAt); assertFalse(combined.completed)
        assertEquals("DAILY_REWARD_COOLDOWN",assertFailsWith<AuthFailure> { rewards.claim(advanced.hash,command(advanced)) }.code)
        val finished=player(); rewards.snapshot(finished.hash)
        execute("UPDATE game_daily_rewards SET next_step=7 WHERE user_id=?",finished.id)
        val request=command(finished); val final=rewards.claim(finished.hash,request)
        val wallet=economy.snapshot(advanced.hash).wallet
        source.connection.use { c -> mergeProgressionRewards(c,advanced.id,finished.id); c.commit() }
        assertTrue(rewards.snapshot(advanced.hash).daily.completed)
        assertEquals(wallet,economy.snapshot(advanced.hash).wallet,"Merging payout fences never grants currency")
        assertEquals("DAILY_REWARD_COMPLETED",assertFailsWith<AuthFailure> { rewards.claim(advanced.hash,command(advanced)) }.code)
        source.connection.use { c -> mergeProgressionRewards(c,finished.id,recent.id); c.commit() }
        assertTrue(rewards.snapshot(finished.hash).daily.completed)
        assertEquals("DAILY_REWARD_COMPLETED",assertFailsWith<AuthFailure> { rewards.claim(finished.hash,command(finished)) }.code)
        assertEquals(final.claim,rewards.claim(finished.hash,request).claim)
    }
    @Test fun `historical owned tier is eligible and manual pearl credits have ledger and revision`()=runBlocking<Unit> {
        val p=player(); val initial=economy.snapshot(p.hash)
        execute("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'thousand_taps','2020-01-01T00:00:00Z')",p.id)
        val row=rewards.snapshot(p.hash).achievementRewards.single { it.achievementId=="thousand_taps" }
        assertTrue(row.eligible); assertEquals("2020-01-01T00:00:00Z",row.earnedAt)
        val command=command(p,achievement="thousand_taps",level=1); val paid=rewards.claim(p.hash,command)
        assertEquals(initial.wallet.pearls+40,paid.economy.wallet.pearls); assertEquals(initial.revision+1,paid.acceptedRevision)
        assertEquals("40",scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND source_key=?",p.id,"reward:${command.requestId}"))
        assertEquals(paid.claim,rewards.claim(p.hash,command).claim)
    }
    @Test fun `a paid v3 achievement keeps its receipt ledger and wallet after the v4 increase`()=runBlocking<Unit> {
        val p=player(); val initial=economy.snapshot(p.hash)
        val request=command(p,achievement="thousand_taps",level=1)
        val original=ProgressionRewardReceipt("achievement",ProgressionReward(pearls=4),
            "2026-10-01T00:00:00Z",achievementId="thousand_taps",level=1)
        val signature=progressionRewardsJson.encodeToString(request)
        val state=source.connection.use { readEconomyProfile(it,p.id).state }
        // Import a consistent previously paid v3 fixture; this is not a fresh v4 grant.
        source.connection.use { c ->
            c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb,revision=revision+1 WHERE user_id=?",
                economyJson.encodeToString(state.copy(wallet=state.wallet.copy(pearls=state.wallet.pearls+4))),p.id)
            c.economyUpdate("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'thousand_taps','2026-10-01T00:00:00Z')",p.id)
            c.economyUpdate("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,'thousand_taps',1,4,'2026-10-01T00:00:00Z')",p.id)
            c.economyUpdate("""INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,claim,accepted_revision,claimed_at)
                VALUES (?,?,?,?,'achievement',?::jsonb,?,'2026-10-01T00:00:00Z')""",p.id,p.id,UUID.fromString(request.requestId),
                signature,progressionRewardsJson.encodeToString(original),initial.revision+1)
            c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items,created_at)
                VALUES (?,?,'achievement_reward',0,4,'{}'::jsonb,'2026-10-01T00:00:00Z')""",p.id,"reward:${request.requestId}")
            c.commit()
        }
        val preview=rewards.snapshot(p.hash).achievementRewards.single { it.achievementId=="thousand_taps" }
        assertEquals(40L,preview.pearls); assertFalse(preview.eligible); assertEquals(original.claimedAt,preview.claimedAt)
        val replay=rewards.claim(p.hash,request)
        assertTrue(replay.replayed); assertEquals(original,replay.claim); assertEquals(initial.revision+1,replay.acceptedRevision)
        assertEquals(initial.wallet.copy(pearls=initial.wallet.pearls+4),replay.economy.wallet)
        assertEquals(initial.revision+1,replay.economy.revision)
        assertEquals("ACHIEVEMENT_REWARD_CLAIMED",assertFailsWith<AuthFailure> {
            rewards.claim(p.hash,command(p,achievement="thousand_taps",level=1)) }.code)
        assertEquals("4",scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND source_key=?",p.id,"reward:${request.requestId}"))
        assertEquals("4",scalar("SELECT pearls FROM game_achievement_reward_claims WHERE user_id=? AND achievement_id='thousand_taps'",p.id))
        source.connection.use { c ->
            assertEquals(original,c.economyRows("SELECT claim FROM game_reward_claims WHERE user_id=? AND request_id=?",p.id,
                UUID.fromString(request.requestId)) { progressionRewardsJson.decodeFromString<ProgressionRewardReceipt>(it.getString(1)) }.single())
            assertEquals(signature,c.economyRows("SELECT signature FROM game_reward_claims WHERE user_id=? AND request_id=?",p.id,
                UUID.fromString(request.requestId)) { it.getString(1) }.single())
        }
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
    @Test fun `new activity achievements reconcile durable play and each tier pays once`()=runBlocking<Unit> {
        val p=player(); val before=economy.snapshot(p.hash)
        val state=source.connection.use { readEconomyProfile(it,p.id).state }
        val played=state.copy(fishing=state.fishing.copy(catches=mapOf("fish" to 200L)),
            progression=state.progression.copy(recipes=mapOf("cook_grilled_fish" to 100L,"grow_berries" to 200L)),
            residentOrders=state.residentOrders.copy(completed=100L))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(played),p.id)
        val names=setOf("patient_angler","campfire_cook","helpful_neighbor","generous_garden")
        val opened=rewards.snapshot(p.hash)
        assertEquals(7,opened.catalogVersion); assertEquals(33,opened.achievementRewards.size)
        assertEquals(12,opened.achievementRewards.count { it.achievementId in names && it.eligible })
        assertEquals(before.wallet,economy.snapshot(p.hash).wallet,"Reading achievements never pays automatically")
        var paid=0L
        for(id in names) for(level in 1..3) {
            val request=command(p,achievement=id,level=level)
            val result=rewards.claim(p.hash,request); paid+=result.claim.reward.pearls
            assertEquals(before.wallet.pearls+paid,result.economy.wallet.pearls)
            assertTrue(rewards.claim(p.hash,request).replayed)
            assertEquals("ACHIEVEMENT_REWARD_CLAIMED",assertFailsWith<AuthFailure> {
                rewards.claim(p.hash,command(p,achievement=id,level=level)) }.code)
        }
        assertEquals(1120L,paid)
        val restarted=JdbcProgressionRewardsRepository(source)
        assertEquals(0,restarted.snapshot(p.hash).achievementRewards.count { it.achievementId in names && it.eligible })
        assertEquals("12",scalar("SELECT count(*) FROM game_achievement_reward_claims WHERE user_id=?",p.id))
        // V70 retains historical IDs and rejects impossible fourth new tiers.
        execute("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'thirty_day_streak','2020-01-01T00:00:00Z')",p.id)
        assertFailsWith<java.sql.SQLException> {
            execute("INSERT INTO game_achievement_tiers(user_id,achievement_id,level) VALUES (?,'patient_angler',4)",p.id)
        }
        assertFailsWith<java.sql.SQLException> {
            execute("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,'patient_angler',4,1,clock_timestamp())",p.id)
        }
    }

    @Test fun `former biome ownership and its paid receipt survive the current route condition`()=runBlocking<Unit> {
        val p=player(); economy.snapshot(p.hash)
        execute("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'familiar_trails','2020-01-01T00:00:00Z')",p.id)
        execute("INSERT INTO game_achievement_tiers(user_id,achievement_id,level,unlocked_at) VALUES (?,'familiar_trails',1,'2020-01-01T00:00:00Z')",p.id)
        val request=command(p,achievement="familiar_trails",level=1)
        val paid=rewards.claim(p.hash,request)
        assertEquals(100L,paid.claim.reward.pearls)
        val medal=JdbcGameRepository(source).achievements(p.hash).achievements.single { it.id=="familiar_trails" }
        assertEquals("2020-01-01T00:00:00Z",medal.unlockedAt); assertEquals(3L,medal.progress)
        assertEquals(paid.claim,rewards.claim(p.hash,request).claim)
        assertEquals("ACHIEVEMENT_REWARD_CLAIMED",assertFailsWith<AuthFailure> {
            rewards.claim(p.hash,command(p,achievement="familiar_trails",level=1)) }.code)
    }

}
