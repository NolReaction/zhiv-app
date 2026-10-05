package ru.zhiv.game

import kotlinx.serialization.Serializable
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID

internal val progressionRewardsJson = Json { encodeDefaults = true; ignoreUnknownKeys = false }
@Serializable data class ProgressionReward(val coins: Long = 0, val pearls: Long = 0, val items: Map<String,Long> = emptyMap())
@Serializable private data class ProgressionRewardsCatalog(val version: Int, val currencyScale: Int, val pearlScale: Int, val dailyMinimumHours: Long,
    val daily: List<ProgressionReward>, val achievementPearls: Map<String,List<Long>>)
@Serializable data class DailyRewardCycle(val step: Int, val reward: ProgressionReward)
data class DailyRewardsState(val step: Int = 1, val lastClaimAt: Instant? = null)
@Serializable data class DailyRewardsView(val step: Int, val claimable: Boolean, val nextClaimAt: String,
    val lastClaimAt: String?, val lastClaimDate: String?, val reward: ProgressionReward, val cycle: List<DailyRewardCycle>)
@Serializable data class AchievementRewardView(val achievementId: String, val level: Int, val target: Long, val pearls: Long,
    val earnedAt: String?, val claimedAt: String?, val eligible: Boolean, val blockedReason: String?)
@Serializable data class ProgressionRewardsView(val ownerPublicId: String, val serverTime: String, val catalogVersion: Int = 1,
    val daily: DailyRewardsView, val achievementRewards: List<AchievementRewardView>)
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class ProgressionRewardClaim(val requestId: String, val ownerPublicId: String, val kind: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val achievementId: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val level: Int? = null)
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class ProgressionRewardReceipt(val kind: String, val reward: ProgressionReward, val claimedAt: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val step: Int? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val achievementId: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val level: Int? = null)
@Serializable data class ProgressionRewardResult(val requestId: String, val rewards: ProgressionRewardsView, val economy: EconomyView,
    val acceptedRevision: Long, val replayed: Boolean, val claim: ProgressionRewardReceipt, val message: String = "Награда получена")
interface ProgressionRewardsRepository {
    suspend fun snapshot(sessionHash: ByteArray): ProgressionRewardsView
    suspend fun claim(sessionHash: ByteArray, command: ProgressionRewardClaim): ProgressionRewardResult
}
fun rewardFailure(code: String, message: String, status: Int = 409): Nothing = throw AuthFailure(code,message,status)
fun invalidRewardClaim(): Nothing = rewardFailure("INVALID_REWARD_CLAIM","Некорректный запрос награды",400)
fun validateRewardClaim(value: ProgressionRewardClaim) {
    val id = runCatching { UUID.fromString(value.requestId) }.getOrNull() ?: invalidRewardClaim()
    if (id.version()!=4 || id.variant()!=2 || value.requestId!=id.toString()
        || !Regex("^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$").matches(value.ownerPublicId)) invalidRewardClaim()
    when(value.kind) {
        "daily" -> if(value.achievementId!=null || value.level!=null) invalidRewardClaim()
        "achievement" -> if(value.achievementId !in GameRewards.tiers || value.level == null
            || value.level !in 1..GameRewards.tiers.getValue(value.achievementId!!).size) invalidRewardClaim()
        else -> invalidRewardClaim()
    }
}
fun decodeRewardClaim(input: JsonElement): ProgressionRewardClaim {
    val obj = input as? JsonObject ?: invalidRewardClaim()
    val kind = (obj["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalidRewardClaim()
    val keys = if (kind=="daily") setOf("requestId","ownerPublicId","kind") else if(kind=="achievement")
        setOf("requestId","ownerPublicId","kind","achievementId","level") else invalidRewardClaim()
    if(obj.keys != keys) invalidRewardClaim()
    for(key in keys-"level") if((obj[key] as? JsonPrimitive)?.isString!=true) invalidRewardClaim()
    if(kind=="achievement") {
        val level=obj["level"] as? JsonPrimitive ?: invalidRewardClaim()
        if(level.isString || level.intOrNull==null) invalidRewardClaim()
    }
    return runCatching { progressionRewardsJson.decodeFromJsonElement<ProgressionRewardClaim>(input) }.getOrElse { invalidRewardClaim() }
        .also(::validateRewardClaim)
}
object ProgressionRewardRules {
    private val catalog = progressionRewardsJson.decodeFromString<ProgressionRewardsCatalog>(checkNotNull(ProgressionRewardRules::class.java
        .getResourceAsStream("/world/progression-rewards-catalog.json")).bufferedReader().use { it.readText() })
    val daily = catalog.daily
    val achievementPearls = catalog.achievementPearls
    init {
        require(catalog.version==1 && catalog.currencyScale==10 && catalog.pearlScale==50 && daily.size==7 && catalog.dailyMinimumHours==20L)
        require(achievementPearls.keys==GameRewards.tiers.keys && achievementPearls.all { (id,values) ->
            values.size==GameRewards.tiers.getValue(id).size && values.all { it in 0L..ECONOMY_MAX_PEARLS } })
        require(daily.all { reward -> reward.coins in 0L..ECONOMY_MAX_BALANCE && reward.pearls in 0L..ECONOMY_MAX_PEARLS
            && reward.items.all { (id,quantity) -> id in setOf("wood","stone","fiber","ancient_core") && quantity in 1L..ECONOMY_MAX_ITEMS } })
    }
    fun dailyView(state: DailyRewardsState, now: Instant): DailyRewardsView {
        require(state.step in 1..7)
        val last = state.lastClaimAt
        val next = if(last==null) now else maxOf(last.atOffset(ZoneOffset.UTC).toLocalDate().plusDays(1)
            .atStartOfDay().toInstant(ZoneOffset.UTC), last.plusSeconds(catalog.dailyMinimumHours*3600))
        return DailyRewardsView(state.step,!now.isBefore(next),next.toString(),last?.toString(),
            last?.atOffset(ZoneOffset.UTC)?.toLocalDate()?.toString(),daily[state.step-1],daily.mapIndexed { i,r -> DailyRewardCycle(i+1,r) })
    }
    fun afterClaim(state: DailyRewardsState, now: Instant) = DailyRewardsState(state.step%7+1,now)
    fun mergeDaily(left: DailyRewardsState, right: DailyRewardsState): DailyRewardsState =
        if(left.lastClaimAt==null || right.lastClaimAt?.isAfter(left.lastClaimAt)==true) right else left
    fun credit(state: EconomyState, reward: ProgressionReward): EconomyState {
        if(reward.coins !in 0L..(ECONOMY_MAX_BALANCE-state.wallet.coins)
            || reward.pearls !in 0L..(ECONOMY_MAX_PEARLS-state.wallet.pearls)) economyFailure("ECONOMY_CAPACITY","Кошелёк заполнен")
        return state.copy(wallet=state.wallet.copy(coins=state.wallet.coins+reward.coins,pearls=state.wallet.pearls+reward.pearls),
            inventory=EconomyRules.addItems(state.inventory,reward.items))
    }
}
