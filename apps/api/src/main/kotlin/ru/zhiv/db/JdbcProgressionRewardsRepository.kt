package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import ru.zhiv.game.*
import ru.zhiv.world.WorldRules
import ru.zhiv.world.WorldState
import ru.zhiv.world.worldJson
import java.sql.Connection
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import javax.sql.DataSource

/** Only initialization/reconciliation and claims take the shared mutation lock. */
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
            } catch(error: Exception) { c.rollback(); recordRejectedSecurityObservation(c, error); throw error }
        }
    }
    private fun daily(c: Connection,user: UUID): DailyRewardsState = c.economyRows(
        "SELECT next_step,last_claim_at,completed FROM game_daily_rewards WHERE user_id=?",user) {
        DailyRewardsState(it.getInt(1),it.getObject(2,OffsetDateTime::class.java)?.toInstant(),it.getBoolean(3)) }.single()
    private fun ownership(c: Connection,user: UUID): Map<Pair<String,Int>,Ownership> = c.economyRows("""
            SELECT achievement_id,1 AS level,unlocked_at,reward_eligible FROM game_achievements
            WHERE user_id=? AND achievement_id IN ('seven_day_streak','thousand_taps','five_friends','ten_thousand_series',
                'linked_email','saved_recovery_code','full_collection')
            UNION ALL SELECT achievement_id,level,unlocked_at,reward_eligible FROM game_achievement_tiers WHERE user_id=?
        """.trimIndent(),user,user) { Ownership(it.getString(1),it.getInt(2),it.getObject(3,OffsetDateTime::class.java).toInstant().toString(),it.getBoolean(4)) }
            .associateBy { it.id to it.level }
    private fun view(c: Connection,actor: Actor,now: Instant,
        owned: Map<Pair<String,Int>,Ownership> = ownership(c,actor.id),
        state: EconomyState = readEconomyProfile(c,actor.id).state): ProgressionRewardsView {
        val paid=c.economyRows("SELECT achievement_id,level,claimed_at FROM game_achievement_reward_claims WHERE user_id=?",actor.id) {
            (it.getString(1) to it.getInt(2)) to it.getObject(3,OffsetDateTime::class.java).toInstant().toString() }.toMap()
        val rows=GameRewards.tiers.flatMap { (id,targets) -> targets.mapIndexed { i,target ->
            val level=i+1; val ownership=owned[id to level]; val claimedAt=paid[id to level]
            val pearls=ProgressionRewardRules.achievementPearls.getValue(id)[i]
            val blocked=when { pearls==0L -> "no_reward"; ownership==null -> "not_earned"; !ownership.eligible -> "admin_grant"; else -> null }
            AchievementRewardView(id,level,target,pearls,ownership?.at,claimedAt,ownership!=null && ownership.eligible && pearls>0 && claimedAt==null,blocked)
        } }
        val homeLevel=state.buildings["home"] ?: 1
        val onboarding=c.economyRows("SELECT onboarding_claimed_at FROM game_daily_rewards WHERE user_id=?",actor.id) {
            OnboardingRewardView(it.getObject(1,OffsetDateTime::class.java)?.toInstant()?.toString()) }.single()
        return ProgressionRewardsView(actor.publicId,now.toString(),daily=ProgressionRewardRules.dailyView(daily(c,actor.id),now,homeLevel),achievementRewards=rows,onboarding=onboarding)
    }
    /** Detect missing historical awards without turning every read into INSERT/UPDATE.
     * A detected change is persisted by the existing locked reconciler, so dates,
     * admin eligibility and rolling-upgrade discovery keep their original meaning. */
    private fun needsReconciliation(c: Connection,a: Actor,now: Instant,
        owned: Map<Pair<String,Int>,Ownership>,state: EconomyState): Boolean {
        fun missing(id: String,level: Int=1)=owned[id to level]?.eligible != true
        val items=c.economyRows("SELECT item_id FROM game_items WHERE user_id=?",a.id) { it.getString(1) }.toSet()
        if (missing("seven_day_streak") || GameRewards.items.keys.any { it !in items }) {
            val longest=c.economyRows("SELECT longest_days FROM rolling_check_in_streak(?,?)",a.id,now.atOffset(ZoneOffset.UTC)) { it.getLong(1) }.firstOrNull() ?: 0L
            if (longest>=7 && missing("seven_day_streak") || GameRewards.items.any { (id,target) -> longest>=target && id !in items }) return true
        }
        if (missing("thousand_taps") || missing("ten_thousand_series")) {
            val taps=c.economyRows("SELECT lifetime_taps,best_series FROM game_profiles WHERE user_id=?",a.id) { it.getLong(1) to it.getLong(2) }.firstOrNull()
            if (taps != null && (taps.first>=1000 && missing("thousand_taps") || taps.second>=10000 && missing("ten_thousand_series"))) return true
        }
        if (missing("five_friends") && c.economyRows("SELECT gameplay_friend_count(?)",a.id) { it.getLong(1) }.single()>=5) return true
        if (missing("linked_email") && c.economyRows("SELECT 1 FROM account_login_identities WHERE user_id=? AND provider='email' LIMIT 1",a.id) { true }.isNotEmpty()) return true
        if (missing("saved_recovery_code") && c.economyRows("SELECT 1 FROM account_recovery_codes WHERE user_id IN (SELECT user_id FROM account_history_user_ids(?)) LIMIT 1",a.id) { true }.isNotEmpty()) return true
        if (missing("full_collection")) {
            val collection=c.economyRows("SELECT state FROM world_profiles WHERE user_id=?",a.id) { worldJson.decodeFromString<WorldState>(it.getString(1)).collection }.firstOrNull().orEmpty()
            if (WorldRules.catalog.finds.count { it.id in collection }.toLong()>=GameRewards.achievements.getValue("full_collection")) return true
        }
        return readEconomyAchievementProgress(c,a.id,state).any { (id,progress) ->
            GameRewards.tiers.getValue(id).withIndex().any { (index,target) -> progress>=target && missing(id,index+1) }
        }
    }
    private suspend fun readSnapshot(hash: ByteArray): ProgressionRewardsView? = withContext(Dispatchers.IO) {
        source.connection.use { c ->
            c.autoCommit=false
            c.transactionIsolation=Connection.TRANSACTION_REPEATABLE_READ
            c.isReadOnly=true
            try {
                val a=actor(c,hash)
                val initialized=c.economyRows("""SELECT EXISTS(SELECT 1 FROM economy_profiles WHERE user_id=?)
                    AND EXISTS(SELECT 1 FROM game_daily_rewards WHERE user_id=?)""",a.id,a.id) { it.getBoolean(1) }.single()
                val now=c.economyRows("SELECT clock_timestamp()") { it.getObject(1,OffsetDateTime::class.java).toInstant() }.single()
                val result=if (!initialized) null else {
                    val owned=ownership(c,a.id); val state=readEconomyProfile(c,a.id).state
                    if (needsReconciliation(c,a,now,owned,state)) null else view(c,a,now,owned,state)
                }
                c.commit()
                // A merge/revocation committed while this consistent snapshot was
                // being read must not return private data under its old identity.
                c.transactionIsolation=Connection.TRANSACTION_READ_COMMITTED
                val current=actor(c,hash)
                if (current != a) economyFailure("ECONOMY_OWNER_CHANGED","Аккаунт изменился. Обновите награды")
                c.commit(); result
            } catch(error: Exception) { c.rollback(); throw error }
        }
    }
    override suspend fun snapshot(sessionHash: ByteArray): ProgressionRewardsView =
        readSnapshot(sessionHash) ?: transaction(sessionHash) { c,a,now -> view(c,a,now) }
    override suspend fun claim(sessionHash: ByteArray,command: ProgressionRewardClaim): ProgressionRewardResult {
        validateRewardClaim(command)
        return transaction(sessionHash,command.ownerPublicId) { c,a,now ->
            val key=UUID.fromString(command.requestId); val signature=progressionRewardsJson.encodeToString(command)
            val previous=c.economyRows("SELECT signature,claim,accepted_revision,currency_scale,pearl_scale FROM game_reward_claims WHERE user_id=? AND request_id=?",a.id,key) {
                val original=progressionRewardsJson.decodeFromString<ProgressionRewardReceipt>(it.getString(2))
                Receipt(it.getString(1),original.copy(reward=original.reward.copy(coins=EconomyMoney.nominal(original.reward.coins,it.getInt(4)),
                    pearls=EconomyMoney.pearls(original.reward.pearls,it.getInt(5)))),it.getLong(3)) }.firstOrNull()
            if(previous!=null) {
                if(previous.signature!=signature) {
                    if (semanticRewardTamper(previous.signature, command)) requestTamper(a.id,"reward:${command.kind}",key,
                        "REWARD_REQUEST_CONFLICT","Этот запрос уже использован для другой награды")
                    rewardFailure("REWARD_REQUEST_CONFLICT","Этот запрос уже использован для другой награды")
                }
                return@transaction ProgressionRewardResult(command.requestId,view(c,a,now),economyView(c,a.id,a.publicId,now),previous.revision,true,previous.claim)
            }
            if(c.economyRows("""SELECT 1 FROM economy_commands WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM economy_market_receipts WHERE user_id=? AND request_id=?
                UNION ALL SELECT 1 FROM economy_barter_receipts WHERE user_id=? AND request_id=?""",a.id,key,a.id,key,a.id,key) { true }.isNotEmpty())
                requestTamper(a.id,"reward:${command.kind}",key)
            val current=view(c,a,now)
            val claim=if(command.kind=="daily") {
                if(current.daily.completed) rewardFailure("DAILY_REWARD_COMPLETED","Все семь подарков уже получены")
                if(!current.daily.claimable) rewardFailure("DAILY_REWARD_COOLDOWN","Следующая награда пока недоступна")
                ProgressionRewardReceipt("daily",current.daily.reward,now.toString(),step=current.daily.step)
            } else if(command.kind=="onboarding") {
                if(current.onboarding.claimedAt!=null) rewardFailure("ONBOARDING_REWARD_CLAIMED","Награда за обучение уже получена")
                if(!ProgressionRewardRules.onboardingEligible(readEconomyProfile(c,a.id).state))
                    rewardFailure("ONBOARDING_REWARD_UNAVAILABLE","Сначала выполни учебный заказ. Награда останется доступна после него")
                ProgressionRewardReceipt("onboarding",ProgressionRewardRules.onboarding,now.toString())
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
            if(claim.kind=="daily") c.economyUpdate("UPDATE game_daily_rewards SET next_step=?,last_claim_at=?,last_claim_date=?,completed=? WHERE user_id=?",
                (claim.step!!+1).coerceAtMost(7),now.atOffset(ZoneOffset.UTC),date,claim.step==7,a.id)
            else if(claim.kind=="onboarding") c.economyUpdate("UPDATE game_daily_rewards SET onboarding_claimed_at=? WHERE user_id=?",now.atOffset(ZoneOffset.UTC),a.id)
            else c.economyUpdate("INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at) VALUES (?,?,?,?,?)",a.id,claim.achievementId,claim.level,claim.reward.pearls,now.atOffset(ZoneOffset.UTC))
            c.economyUpdate("""INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,daily_date,claim,accepted_revision,claimed_at)
                VALUES (?,?,?,?,?,?,?::jsonb,?,?)""",a.id,a.id,key,signature,claim.kind,date,progressionRewardsJson.encodeToString(claim),economic.revision,now.atOffset(ZoneOffset.UTC))
            c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items,created_at) VALUES (?,?,?,?,?,?::jsonb,?)",
                a.id,"reward:$key",when(claim.kind) { "daily" -> "daily_reward"; "onboarding" -> "onboarding_reward"; else -> "achievement_reward" },claim.reward.coins,claim.reward.pearls,
                economyJson.encodeToString(claim.reward.items),now.atOffset(ZoneOffset.UTC))
            ProgressionRewardResult(command.requestId,view(c,a,now),economic,economic.revision,false,claim)
        }
    }
}
