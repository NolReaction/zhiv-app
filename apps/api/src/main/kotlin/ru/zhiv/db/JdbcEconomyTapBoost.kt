package ru.zhiv.db

import kotlinx.serialization.encodeToString
import ru.zhiv.economy.EconomyTapBoost
import ru.zhiv.economy.economyJson
import java.sql.Connection
import java.time.Instant
import java.util.UUID

/** Called inside submitBatch's user lock, after its exact replay check. It never
 * creates a second receipt or credits any unaccepted/client-estimated taps. */
internal fun creditEconomyTapBoost(c: Connection, user: UUID, acceptedTaps: Int, now: Instant) {
    if (acceptedTaps <= 0 || c.economyRows("SELECT 1 FROM economy_profiles WHERE user_id=?", user) { true }.isEmpty()) return
    val state = readEconomyProfile(c, user).state
    val next = EconomyTapBoost.credit(state, acceptedTaps, now)
    // A tap only advances a clock; it neither spends stock nor changes a command's
    // offer. Keep the material revision so a simultaneous production click remains
    // valid. The shared app_users lock serializes this patch with ordinary writes.
    if (next != state) c.economyUpdate("""UPDATE economy_profiles
        SET state=jsonb_set(jsonb_set(state,'{jobs}',?::jsonb),'{tapBoost}',?::jsonb),updated_at=clock_timestamp()
        WHERE user_id=?""", economyJson.encodeToString(next.jobs), economyJson.encodeToString(next.tapBoost), user)
}
