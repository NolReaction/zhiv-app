package ru.zhiv.db

import kotlinx.serialization.encodeToString
import ru.zhiv.admin.AdminEconomyGrantRequest
import ru.zhiv.admin.AdminEconomyGrants
import ru.zhiv.economy.economyJson
import java.sql.Connection
import java.time.Instant
import java.util.UUID

/** The caller holds both account locks and commits the immutable admin receipt
 * in this same transaction. Initialization retains the one-time conversion fence. */
internal fun grantAdminEconomy(c: Connection, target: UUID, requestId: UUID, request: AdminEconomyGrantRequest, now: Instant): Pair<Boolean, Long> {
    ensureEconomyProfile(c, target)
    val before = readEconomyProfile(c, target)
    val next = AdminEconomyGrants.apply(before.state, request, now, reservedEconomyMarketItems(c, target))
    if (next == before.state) return false to before.revision
    assertEconomyMarketCapacity(c, target, before.state, next)
    saveEconomyProfile(c, target, next)
    if (next.buildings != before.state.buildings) {
        c.economyUpdate("""UPDATE world_profiles SET state=jsonb_set(jsonb_set(jsonb_set(state,'{houseLevel}',to_jsonb(?::integer)),
            '{workshop}',to_jsonb(?::boolean)),'{workshopLevel}',to_jsonb(?::integer)),
            revision=least(9007199254740991,revision+1),updated_at=clock_timestamp() WHERE user_id=?""",
            next.buildings["home"] ?: 1, (next.buildings["workshop"] ?: 0) > 0, next.buildings["workshop"] ?: 0, target)
    }
    c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items)
        VALUES (?,?,'grant_economy',?,?,?::jsonb)""", target, "admin:$requestId",
        next.wallet.coins - before.state.wallet.coins, next.wallet.pearls - before.state.wallet.pearls,
        economyJson.encodeToString(request.items))
    return true to (before.revision + 1)
}
