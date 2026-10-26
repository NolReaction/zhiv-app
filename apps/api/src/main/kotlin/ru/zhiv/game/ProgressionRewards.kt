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
    val daily: List<ProgressionReward>, val dailyByHomeLevel: Map<String,List<ProgressionReward>>, val achievementPearls: Map<String,List<Long>>,
    val onboarding: ProgressionReward, val legacyOnboarding: ProgressionReward, val legacyDailyPearls: List<Long>,
    val v6Onboarding: ProgressionReward, val v6DailyPearls: List<Long>)
@Serializable data class DailyRewardCycle(val step: Int, val reward: ProgressionReward)
data class DailyRewardsState(val step: Int = 1, val lastClaimAt: Instant? = null, val completed: Boolean = false,
    val rewardVersion: Int = 5) { init { require(rewardVersion in 5..7) } }
@Serializable data class DailyRewardsView(val step: Int, val claimable: Boolean, val nextClaimAt: String?,
    val lastClaimAt: String?, val lastClaimDate: String?, val reward: ProgressionReward, val cycle: List<DailyRewardCycle>, val homeLevel: Int = 1,
    val completed: Boolean = false)
@Serializable data class AchievementRewardView(val achievementId: String, val level: Int, val target: Long, val pearls: Long,
    val earnedAt: String?, val claimedAt: String?, val eligible: Boolean, val blockedReason: String?)
@Serializable data class OnboardingRewardView(val claimedAt: String? = null)
@Serializable data class ProgressionRewardsView(val ownerPublicId: String, val serverTime: String, val catalogVersion: Int = 7,
    val daily: DailyRewardsView, val achievementRewards: List<AchievementRewardView>, val onboarding: OnboardingRewardView = OnboardingRewardView())
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
        "daily", "onboarding" -> if(value.achievementId!=null || value.level!=null) invalidRewardClaim()
        "achievement" -> if(value.achievementId !in GameRewards.tiers || value.level == null
            || value.level !in 1..GameRewards.tiers.getValue(value.achievementId!!).size) invalidRewardClaim()
        else -> invalidRewardClaim()
    }
}
fun decodeRewardClaim(input: JsonElement): ProgressionRewardClaim {
    val obj = input as? JsonObject ?: invalidRewardClaim()
    val kind = (obj["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalidRewardClaim()
    val keys = if (kind=="daily" || kind=="onboarding") setOf("requestId","ownerPublicId","kind") else if(kind=="achievement")
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
    val onboarding = catalog.onboarding
    fun onboardingRewardForState(state: EconomyState): ProgressionReward =
        when (state.tutorialOrder.rewardVersion) { 7 -> onboarding; 6 -> catalog.v6Onboarding; else -> catalog.legacyOnboarding }
    val achievementPearls = catalog.achievementPearls
    /** The course already requires this server-confirmed lesson. Merely opening
     * screens, a local completion flag or an administrative building grant is not proof.
     * Preserve the legacy multi-order first step and its merge/read projection. */
    fun onboardingEligible(state: EconomyState): Boolean {
        val progress=EconomyTutorialOrders.normalize(state).tutorialOrder
        return progress.completed || progress.step>0
    }
    init {
        require(catalog.version==7 && catalog.currencyScale==10 && catalog.pearlScale==50 && daily.size==7 && catalog.dailyMinimumHours==20L)
        require(onboarding == ProgressionReward(coins=100,pearls=20))
        require(catalog.legacyOnboarding == ProgressionReward(coins=1_000,pearls=200))
        require(catalog.legacyDailyPearls == listOf(80L,100L,120L,140L,160L,180L,220L))
        require(catalog.v6Onboarding == ProgressionReward(coins=100,pearls=40))
        require(catalog.v6DailyPearls == listOf(20L,30L,40L,40L,50L,50L,70L))
        require(catalog.dailyByHomeLevel.keys==setOf("2","3","4","5"))
        require(achievementPearls.keys==GameRewards.tiers.keys && achievementPearls.all { (id,values) ->
            values.size==GameRewards.tiers.getValue(id).size && values.all { it in 0L..ECONOMY_MAX_PEARLS } })
        require(achievementPearls.values.flatten().sum()==4_120L && achievementPearls.all { (id,values) ->
            values.all { it%2L==0L && (if(id=="full_collection") it==0L else it>0L) }
                && values.zipWithNext().all { (before,after) -> after>=before } })
        val itemIds=setOf("wood","stone","fiber","berries","fish","hardwood","resin","planks","rope","bricks","iron_ingot",
            "cloth","metal_parts","glass","beams","cut_stone","tools","reinforced_parts","ancient_core")
        for(cycle in listOf(daily)+catalog.dailyByHomeLevel.values) {
            require(cycle.size==7 && cycle.sumOf { it.pearls }==140L && cycle.sumOf { it.items["ancient_core"] ?: 0L }==1L)
            require(cycle.withIndex().all { (index,reward) -> reward.coins in 0L..ECONOMY_MAX_BALANCE
                && reward.pearls==daily[index].pearls && reward.pearls in 0L..ECONOMY_MAX_PEARLS && reward.pearls%2L==0L
                && reward.items.all { (id,quantity) -> id in itemIds && quantity in 1L..ECONOMY_MAX_ITEMS } })
        }
    }
    /** Only the saved completed home level selects a fixed bundle, never paid slots or active construction. */
    fun dailyCycle(homeLevel: Int = 1): List<ProgressionReward> =
        if(homeLevel.coerceIn(1,5)==1) daily else catalog.dailyByHomeLevel.getValue(homeLevel.coerceIn(1,5).toString())
    fun dailyView(state: DailyRewardsState, now: Instant, homeLevel: Int = 1): DailyRewardsView {
        require(state.step in 1..7)
        val level=homeLevel.coerceIn(1,5)
        val cycle=dailyCycle(level).mapIndexed { index, reward ->
            when (state.rewardVersion) { 5 -> reward.copy(pearls = catalog.legacyDailyPearls[index])
                6 -> reward.copy(pearls = catalog.v6DailyPearls[index]); else -> reward } }
        val last = state.lastClaimAt
        val step=if(state.completed) 7 else state.step
        val next = if(state.completed) null else if(last==null) now else maxOf(last.atOffset(ZoneOffset.UTC).toLocalDate().plusDays(1)
            .atStartOfDay().toInstant(ZoneOffset.UTC), last.plusSeconds(catalog.dailyMinimumHours*3600))
        return DailyRewardsView(step,next!=null && !now.isBefore(next),next?.toString(),last?.toString(),
            last?.atOffset(ZoneOffset.UTC)?.toLocalDate()?.toString(),cycle[step-1],cycle.mapIndexed { i,r -> DailyRewardCycle(i+1,r) },level,state.completed)
    }
    fun afterClaim(state: DailyRewardsState, now: Instant): DailyRewardsState {
        if(state.completed) rewardFailure("DAILY_REWARD_COMPLETED","Все семь подарков уже получены")
        return DailyRewardsState((state.step+1).coerceAtMost(7),now,state.step==7,state.rewardVersion)
    }
    /** Progress and completion never go backwards; the latest claim still controls cooldown. */
    fun mergeDaily(left: DailyRewardsState, right: DailyRewardsState): DailyRewardsState {
        val completed=left.completed || right.completed
        return DailyRewardsState(if(completed) 7 else maxOf(left.step,right.step),
            listOfNotNull(left.lastClaimAt,right.lastClaimAt).maxOrNull(),completed,minOf(left.rewardVersion,right.rewardVersion))
    }
    fun credit(state: EconomyState, reward: ProgressionReward): EconomyState {
        if(reward.coins !in 0L..(ECONOMY_MAX_BALANCE-state.wallet.coins)
            || reward.pearls !in 0L..(ECONOMY_MAX_PEARLS-state.wallet.pearls)) economyFailure("ECONOMY_CAPACITY","Кошелёк заполнен")
        return state.copy(wallet=state.wallet.copy(coins=state.wallet.coins+reward.coins,pearls=state.wallet.pearls+reward.pearls),
            inventory=EconomyRules.addItems(state.inventory,reward.items))
    }
}
