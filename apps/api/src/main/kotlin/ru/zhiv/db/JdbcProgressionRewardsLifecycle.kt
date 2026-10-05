package ru.zhiv.db

import java.sql.Connection
import java.util.UUID

/** Paid wallets were combined separately. Union payout fences without re-crediting or clawing back. */
internal fun mergeProgressionRewards(c: Connection,target: UUID,source: UUID) {
    c.economyUpdate("""
        INSERT INTO game_daily_rewards(user_id,next_step,last_claim_at,last_claim_date)
        SELECT ?,next_step,last_claim_at,last_claim_date FROM game_daily_rewards WHERE user_id=?
        ON CONFLICT(user_id) DO UPDATE SET next_step=EXCLUDED.next_step,last_claim_at=EXCLUDED.last_claim_at,last_claim_date=EXCLUDED.last_claim_date
        WHERE game_daily_rewards.last_claim_at IS NULL OR EXCLUDED.last_claim_at>game_daily_rewards.last_claim_at
    """.trimIndent(),target,source)
    c.economyUpdate("""
        INSERT INTO game_achievement_reward_claims(user_id,achievement_id,level,pearls,claimed_at)
        SELECT ?,achievement_id,level,pearls,claimed_at FROM game_achievement_reward_claims WHERE user_id=?
        ON CONFLICT(user_id,achievement_id,level) DO UPDATE
            SET claimed_at=LEAST(game_achievement_reward_claims.claimed_at,EXCLUDED.claimed_at)
    """.trimIndent(),target,source)
    // origin_user_id keeps each pre-merge daily date fence and both immutable receipts.
    // A colliding request UUID stays consumed by the target's existing receipt.
    c.economyUpdate("""
        INSERT INTO game_reward_claims(user_id,origin_user_id,request_id,signature,kind,daily_date,claim,accepted_revision,claimed_at)
        SELECT ?,origin_user_id,request_id,signature,kind,daily_date,claim,accepted_revision,claimed_at FROM game_reward_claims WHERE user_id=?
        ON CONFLICT DO NOTHING
    """.trimIndent(),target,source)
}
