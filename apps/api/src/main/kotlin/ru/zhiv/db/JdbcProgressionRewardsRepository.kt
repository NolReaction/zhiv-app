package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import ru.zhiv.game.*
import java.sql.Connection
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

/** User row lock serializes reward, inventory, market, merge and gameplay mutations. */
class JdbcProgressionRewardsRepository(private val source: DataSource) : ProgressionRewardsRepository {
    private data class Actor(val id: UUID, val publicId: String)
    private data class Ownership(val id: String, val level: Int, val at: String, val eligible: Boolean)
    private data class Receipt(val signature: String, val claim: ProgressionRewardReceipt, val revision: Long)
    private fun actor(c: Connection, hash: ByteArray): Actor = c.economyRows("""
        SELECT u.id,u.public_id FROM app_users u JOIN app_sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            AND u.deleted_at IS NULL AND u.banned_at IS NULL
    """.trimIndent(),hash) { Actor(it.getObject(1,UUID::class.java),it.getString(2)) }.firstOrNull()
        ?: throw AuthFailure("UNAUTHORIZED","Войдите в профиль ещё раз",401)
    private suspend fun <T> transaction(hash: ByteArray, owner: String? = null, block: (Connection,Actor,Instant)->T): T = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit=false
            try {
                val initial=actor(c,hash)
                c.economyUpdate("SET LOCAL lock_timeout = '5s'")
                c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",initial.id) { true }
                val current=actor(c,hash)
                if(current.id!=initial.id || (owner!=null && current.publicId!=owner)) economyFailure("ECONOMY_OWNER_CHANGED","Аккаунт изменился. Обновите награды")
                ensureEconomyProfile(c,current.id)
                c.economyUpdate("INSERT INTO game_daily_rewards(user_id) VALUES (?) ON CONFLICT DO NOTHING",current.id)
                val now=c.economyRows("SELECT clock_timestamp()") { it.getObject(1,OffsetDateTime::class.java).toInstant() }.single()
                recordMergedAchievements(c,current.id,now.atOffset(ZoneOffset.UTC))
                val result=block(c,current,now)
                c.commit(); result
            } catch(error: Exception) { c.rollback(); throw error }
        }
    }
    private fun daily(c: Connection,user: UUID): DailyRewardsState = c.economyRows(
        "SELECT next_step,last_claim_at FROM game_daily_rewards WHERE user_id=?",user) {
        DailyRewardsState(it.getInt(1),it.getObject(2,OffsetDateTime::class.java)?.toInstant()) }.single()
    private fun view(c: Connection,actor: Actor,now: Instant): ProgressionRewardsView {
        val owned=c.economyRows("""
            SELECT achievement_id,1 AS level,unlocked_at,reward_eligible FROM game_achievements
            WHERE user_id=? AND achievement_id IN ('seven_day_streak','thousand_taps','five_friends','ten_thousand_series',
                'linked_email','saved_recovery_code','full_collection')
            UNION ALL SELECT achievement_id,level,unlocked_at,reward_eligible FROM game_achievement_tiers WHERE user_id=?
        """.trimIndent(),actor.id,actor.id) { Ownership(it.getString(1),it.getInt(2),it.getObject(3,OffsetDateTime::class.java).toInstant().toString(),it.getBoolean(4)) }
            .associateBy { it.id to it.level }
        val paid=c.economyRows("SELECT achievement_id,level,claimed_at FROM game_achievement_reward_claims WHERE user_id=?",actor.id) {
            (it.getString(1) to it.getInt(2)) to it.getObject(3,OffsetDateTime::class.java).toInstant().toString() }.toMap()
        val rows=GameRewards.tiers.flatMap { (id,targets) -> targets.mapIndexed { i,target ->
            val level=i+1; val ownership=owned[id to level]; val claimedAt=paid[id to level]
            val pearls=ProgressionRewardRules.achievementPearls.getValue(id)[i]
            val blocked=when { pearls==0L -> "no_reward"; ownership==null -> "not_earned"; !ownership.eligible -> "admin_grant"; else -> null }
            AchievementRewardView(id,level,target,pearls,ownership?.at,claimedAt,ownership!=null && ownership.eligible && pearls>0 && claimedAt==null,blocked)
        } }
        val homeLevel=readEconomyProfile(c,actor.id).state.buildings["home"] ?: 1
        return ProgressionRewardsView(actor.publicId,now.toString(),daily=ProgressionRewardRules.dailyView(daily(c,actor.id),now,homeLevel),achievementRewards=rows)
    }
    override suspend fun snapshot(sessionHash: ByteArray): ProgressionRewardsView = transaction(sessionHash) { c,a,now -> view(c,a,now) }
    override suspend fun claim(sessionHash: ByteArray,command: ProgressionRewardClaim): ProgressionRewardResult {
        validateRewardClaim(command)
        return transaction(sessionHash,command.ownerPublicId) { c,a,now ->
            val key=UUID.fromString(command.requestId); val signature=progressionRewardsJson.encodeToString(command)
            val previous=c.economyRows("SELECT signature,claim,accepted_revision,currency_scale,pearl_scale FROM game_reward_claims WHERE user_id=? AND request_id=?",a.id,key) {
                val original=progressionRewardsJson.decodeFromString<ProgressionRewardReceipt>(it.getString(2))
                Receipt(it.getString(1),original.copy(reward=original.reward.copy(coins=EconomyMoney.nominal(original.reward.coins,it.getInt(4)),
                    pearls=EconomyMoney.pearls(original.reward.pearls,it.getInt(5)))),it.getLong(3)) }.firstOrNull()
            if(previous!=null) {
                if(previous.signature!=signature) rewardFailure("REWARD_REQUEST_CONFLICT","Этот запрос уже использован для другой награды")
                return@transaction ProgressionRewardResult(command.requestId,view(c,a,now),economyView(c,a.id,a.publicId,now),previous.revision,true,previous.claim)
            }
            if(c.economyRows("""SELECT 1 FROM economy_commands WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM economy_market_receipts WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM economy_barter_receipts WHERE user_id=? AND request_id=?""",a.id,key,a.id,key,a.id,key) { true }.isNotEmpty())
                economyFailure("ECONOMY_REQUEST_CONFLICT","Этот запрос уже использован для другого действия")
            val current=view(c,a,now)
            val claim=if(command.kind=="daily") {
                if(!current.daily.claimable) rewardFailure("DAILY_REWARD_COOLDOWN","Следующая награда пока недоступна")
                ProgressionRewardReceipt("daily",current.daily.reward,now.toString(),step=current.daily.step)
            } else {
                val row=current.achievementRewards.single { it.achievementId==command.achievementId && it.level==command.level }
                if(row.claimedAt!=null) rewardFailure("ACHIEVEMENT_REWARD_CLAIMED","Награда за эту ступень уже получена")
                if(!row.eligible) rewardFailure("ACHIEVEMENT_REWARD_UNAVAILABLE","Награда за эту ступень пока недоступна")
                ProgressionRewardReceipt("achievement",ProgressionReward(pearls=row.pearls),now.toString(),achievementId=row.achievementId,level=row.level)
            }
            val before=readEconomyProfile(c,a.id).state
            val next=ProgressionRewardRules.credit(before,claim.reward)
            assertEconomyMarketCapacity(c,a.id,before,next)
            saveEconomyProfile(c,a.id,next)
            val economic=economyView(c,a.id,a.publicId,now)
            val date=if(claim.kind=="daily") now.atOffset(ZoneOffset.UTC).toLocalDate() else null
            if(claim.kind=="daily") c.economyUpdate("UPDATE game_daily_rewards SET next_step=?,last_claim_at=?,last_claim_date=? WHERE user_id=?",claim.step!!%7+1,now.atOffset(ZoneOffset.UTC),date,a.id)
            else c.economyUpdate("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,?,?,?,?)",a.id,claim.achievementId,claim.level,claim.reward.pearls,now.atOffset(ZoneOffset.UTC))
            c.economyUpdate("""INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,daily_date,claim,accepted_revision,claimed_at)
                VALUES (?,?,?,?,?,?,?::jsonb,?,?)""",a.id,a.id,key,signature,claim.kind,date,progressionRewardsJson.encodeToString(claim),economic.revision,now.atOffset(ZoneOffset.UTC))
            c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items,created_at) VALUES (?,?,?,?,?,?::jsonb,?)",
                a.id,"reward:$key",if(claim.kind=="daily") "daily_reward" else "achievement_reward",claim.reward.coins,claim.reward.pearls,
                economyJson.encodeToString(claim.reward.items),now.atOffset(ZoneOffset.UTC))
            ProgressionRewardResult(command.requestId,view(c,a,now),economic,economic.revision,false,claim)
        }
    }
}
