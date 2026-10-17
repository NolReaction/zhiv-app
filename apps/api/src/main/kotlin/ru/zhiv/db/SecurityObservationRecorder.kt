package ru.zhiv.db

import org.slf4j.LoggerFactory
import ru.zhiv.admin.SecurityObservationKind
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.EconomyBarterCommand
import ru.zhiv.economy.EconomyCommand
import ru.zhiv.economy.economyJson
import ru.zhiv.game.ProgressionRewardClaim
import ru.zhiv.game.progressionRewardsJson
import java.sql.Connection
import java.time.OffsetDateTime
import java.util.UUID

/** Construct only after authenticated ownership was rechecked under the account lock. */
internal class ObservedSecurityFailure(
    val userId: UUID, val kind: SecurityObservationKind, val action: String, val requestId: UUID,
    code: String, message: String, status: Int = 409,
) : AuthFailure(code, message, status)

private val observedActions = setOf(
    "claim_tutorial_order", "claim_workshop_starter", "eat_food", "feed_builder", "complete_resident_order", "replace_resident_order",
    "start_production", "buy_production_slot", "start_collection", "start_garden_collection", "start_exploration", "start_fishing",
    "cancel_production", "cancel_exploration", "start_tutorial_workshop", "start_construction", "speedup_construction",
    "claim_garden_collection", "claim_job", "buy_market_slot", "buy_leaftail_item", "refresh_fishing_shop", "buy_wardrobe_item",
    "buy_fishing_item", "equip_fishing_rod", "equip_fishing_hook", "equip_fishing_bait", "sell", "sell_fish",
    "create_listing", "buy_listing", "cancel_listing", "create_offer", "accept_offer", "cancel_offer", "daily", "achievement", "onboarding",
)

internal fun requestTamper(user: UUID, action: String, requestId: UUID,
    code: String = "ECONOMY_REQUEST_CONFLICT", message: String = "Этот запрос уже использован для другого действия",
): Nothing {
    val scope = action.substringBefore(':').takeIf { it in setOf("economy","market","barter","reward") } ?: "economy"
    val name = action.substringAfter(':').takeIf { it in observedActions } ?: "unknown"
    throw ObservedSecurityFailure(user, SecurityObservationKind.ECONOMY_REQUEST_TAMPER, "$scope:$name", requestId, code, message)
}

/** Revision rebases, merged owner IDs and old undecodable formats are not evidence of abuse. */
internal fun semanticEconomyTamper(previous: String, command: EconomyCommand): Boolean = runCatching {
    economyJson.decodeFromString<EconomyCommand>(previous).copy(ownerPublicId=command.ownerPublicId, expectedRevision=command.expectedRevision) != command
}.getOrDefault(false)
internal fun semanticBarterTamper(previous: String, command: EconomyBarterCommand): Boolean = runCatching {
    economyJson.decodeFromString<EconomyBarterCommand>(previous).copy(ownerPublicId=command.ownerPublicId, expectedRevision=command.expectedRevision) != command
}.getOrDefault(false)
internal fun semanticRewardTamper(previous: String, command: ProgressionRewardClaim): Boolean = runCatching {
    progressionRewardsJson.decodeFromString<ProgressionRewardClaim>(previous).copy(ownerPublicId=command.ownerPublicId) != command
}.getOrDefault(false)

/** Called AFTER the rejected gameplay transaction rolled back. Record using the
 * same connection in a fresh short transaction; never keep gameplay mutations.
 * The observation is best effort: its storage failure cannot accept the action
 * or replace the original public denial with a 500. No payload/session is logged. */
internal fun recordRejectedSecurityObservation(c: Connection, error: Exception) {
    if (error !is ObservedSecurityFailure) return
    try {
        c.economyUpdate("SET LOCAL lock_timeout = '500ms'")
        c.economyUpdate("SET LOCAL statement_timeout = '1s'")
        if (c.economyRows("SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL FOR NO KEY UPDATE", error.userId) { true }.isNotEmpty()) {
            recordSecurityObservation(c, error)
        }
        c.commit()
    } catch (_: Exception) {
        runCatching { c.rollback() }
        LoggerFactory.getLogger("ru.zhiv.security.observations").warn("Could not persist rejected security observation: {}", error.kind.name)
    }
}

internal fun recordSecurityObservation(c: Connection, event: ObservedSecurityFailure) {
    require(Regex("^[a-z_]+:[a-z_]+$").matches(event.action) && event.action.length <= 80)
    val now = c.economyRows("SELECT clock_timestamp()") { it.getObject(1, OffsetDateTime::class.java) }.single()
    data class Existing(val total: Long, val pending: Long, val window: OffsetDateTime, val recent: List<UUID>)
    val previous = c.economyRows("SELECT total_count,pending_count,window_started_at,recent_request_ids FROM player_security_observations WHERE user_id=? AND code=?",
        event.userId, event.kind.name) { r -> Existing(r.getLong(1), r.getLong(2), r.getObject(3, OffsetDateTime::class.java),
        (r.getArray(4).array as Array<*>).map { UUID.fromString(it.toString()) }) }.firstOrNull()
    if (event.requestId in (previous?.recent ?: emptyList())) return
    val expired = previous != null && event.kind.windowMinutes?.let { now.isAfter(previous.window.plusMinutes(it.toLong())) } == true
    val pending = if (previous == null || expired) 1L else minOf(9_007_199_254_740_991L, previous.pending + 1)
    val total = minOf(9_007_199_254_740_991L, (previous?.total ?: 0L) + 1)
    val window = if (previous == null || expired) now else previous.window
    val recent = ((previous?.recent ?: emptyList()) + event.requestId).takeLast(16)
    val array = c.createArrayOf("uuid", recent.toTypedArray())
    try {
        c.economyUpdate("""INSERT INTO player_security_observations(user_id,code,total_count,pending_count,first_at,last_at,window_started_at,
            activated_at,last_action,last_request_id,recent_request_ids) VALUES (?,?,?,?,?,?,?,CASE WHEN ? THEN ?::timestamptz ELSE NULL END,?,?,?)
            ON CONFLICT(user_id,code) DO UPDATE SET total_count=EXCLUDED.total_count,pending_count=EXCLUDED.pending_count,
                last_at=EXCLUDED.last_at,window_started_at=EXCLUDED.window_started_at,
                activated_at=coalesce(EXCLUDED.activated_at,player_security_observations.activated_at),last_action=EXCLUDED.last_action,
                last_request_id=EXCLUDED.last_request_id,recent_request_ids=EXCLUDED.recent_request_ids""",
            event.userId,event.kind.name,total,pending,now,now,window,pending >= event.kind.threshold,now,event.action,event.requestId,array)
    } finally { array.free() }
    if (pending >= event.kind.threshold) c.economyUpdate("UPDATE app_users SET security_signal_at=? WHERE id=?", now,event.userId)
}

/** Lifecycle operations hold both user locks. Only three summaries survive;
 * windows are not combined into a synthetic new threshold after account merge. */
internal fun mergeSecurityObservations(c: Connection, target: UUID, source: UUID) {
    c.economyUpdate("""INSERT INTO player_security_observations SELECT ?,code,total_count,pending_count,first_at,last_at,
        window_started_at,activated_at,reviewed_at,last_action,last_request_id,recent_request_ids
        FROM player_security_observations WHERE user_id=?
        ON CONFLICT(user_id,code) DO UPDATE SET
            total_count=least(9007199254740991,player_security_observations.total_count+EXCLUDED.total_count),
            first_at=least(player_security_observations.first_at,EXCLUDED.first_at),
            last_at=greatest(player_security_observations.last_at,EXCLUDED.last_at),
            pending_count=CASE WHEN
                (EXCLUDED.activated_at IS NOT NULL AND (player_security_observations.activated_at IS NULL OR EXCLUDED.activated_at>player_security_observations.activated_at))
                OR (EXCLUDED.activated_at IS NULL AND player_security_observations.activated_at IS NULL AND EXCLUDED.last_at>player_security_observations.last_at)
                THEN EXCLUDED.pending_count ELSE player_security_observations.pending_count END,
            window_started_at=CASE WHEN
                (EXCLUDED.activated_at IS NOT NULL AND (player_security_observations.activated_at IS NULL OR EXCLUDED.activated_at>player_security_observations.activated_at))
                OR (EXCLUDED.activated_at IS NULL AND player_security_observations.activated_at IS NULL AND EXCLUDED.last_at>player_security_observations.last_at)
                THEN EXCLUDED.window_started_at ELSE player_security_observations.window_started_at END,
            activated_at=greatest(player_security_observations.activated_at,EXCLUDED.activated_at),
            reviewed_at=greatest(player_security_observations.reviewed_at,EXCLUDED.reviewed_at),
            last_action=CASE WHEN EXCLUDED.last_at>player_security_observations.last_at THEN EXCLUDED.last_action ELSE player_security_observations.last_action END,
            last_request_id=CASE WHEN EXCLUDED.last_at>player_security_observations.last_at THEN EXCLUDED.last_request_id ELSE player_security_observations.last_request_id END,
            recent_request_ids=(SELECT array_agg(request_id ORDER BY position) FROM (
                SELECT request_id,max(position) AS position FROM unnest(
                    CASE WHEN EXCLUDED.last_at>player_security_observations.last_at
                        THEN player_security_observations.recent_request_ids || EXCLUDED.recent_request_ids
                        ELSE EXCLUDED.recent_request_ids || player_security_observations.recent_request_ids END
                ) WITH ORDINALITY AS recent(request_id,position) GROUP BY request_id ORDER BY max(position) DESC LIMIT 16
            ) bounded)""",target,source)
    c.economyUpdate("UPDATE app_users SET security_signal_at=(SELECT max(activated_at) FROM player_security_observations WHERE user_id=?) WHERE id=?", target,target)
    c.economyUpdate("DELETE FROM player_security_observations WHERE user_id=?", source)
}
