-- The seven gifts form one account-wide chain. Never claw back an old repeated
-- payout, rewrite an immutable receipt, or credit money during this migration.
ALTER TABLE game_daily_rewards ADD COLUMN completed boolean NOT NULL DEFAULT false;

-- The former wraparound left step 1 immediately after the seventh gift.
-- Keep that completion proof even if its historical receipt is absent.
UPDATE game_daily_rewards SET next_step=7,completed=true
WHERE next_step=1 AND last_claim_at IS NOT NULL;

-- Receipts also identify accounts that have started a second (or later) round,
-- and preserve the furthest paid gift across historical account merges. Restore
-- a missing sequence row from its immutable receipts without paying anything.
WITH paid AS (
    SELECT user_id,
        max(CASE WHEN claim->>'step' IN ('1','2','3','4','5','6','7')
            THEN (claim->>'step')::smallint ELSE 0 END) AS paid_step,
        max(claimed_at) AS last_claim_at
    FROM game_reward_claims WHERE kind='daily' GROUP BY user_id
)
INSERT INTO game_daily_rewards(user_id,next_step,last_claim_at,last_claim_date,completed)
SELECT user_id,LEAST(paid_step+1,7),last_claim_at,
    (last_claim_at AT TIME ZONE 'UTC')::date,paid_step=7
FROM paid WHERE paid_step>0
ON CONFLICT(user_id) DO UPDATE SET
    next_step=CASE WHEN game_daily_rewards.completed OR EXCLUDED.completed THEN 7
        ELSE GREATEST(game_daily_rewards.next_step,EXCLUDED.next_step) END,
    last_claim_at=GREATEST(game_daily_rewards.last_claim_at,EXCLUDED.last_claim_at),
    last_claim_date=GREATEST(game_daily_rewards.last_claim_date,EXCLUDED.last_claim_date),
    completed=game_daily_rewards.completed OR EXCLUDED.completed;

ALTER TABLE game_daily_rewards ADD CONSTRAINT game_daily_rewards_completion_check
    CHECK (NOT completed OR (next_step=7 AND last_claim_at IS NOT NULL));
