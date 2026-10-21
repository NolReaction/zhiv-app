package ru.zhiv.db

import kotlinx.serialization.encodeToString
import ru.zhiv.admin.AdminEconomyGrantRequest
import ru.zhiv.admin.AdminEconomyGrants
import ru.zhiv.admin.AdminEconomyAdjustmentRequest
import ru.zhiv.admin.AdminEconomyAdjustments
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.EconomyRules
import ru.zhiv.economy.economyJson
import ru.zhiv.mail.MailAttachments
import java.sql.Connection
import java.time.Instant
import java.time.ZoneOffset
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
    val additions = MailAttachments(coins = next.wallet.coins - before.state.wallet.coins,
            pearls = (next.wallet.pearls - before.state.wallet.pearls) / 2L, items = request.items,
            buildings = next.buildings.filter { (id, level) -> level > (before.state.buildings[id] ?: 0) },
            productionSlots = next.productionSlots.filter { (id, count) -> count > EconomyRules.productionSlotCount(before.state, id) },
            rods = next.fishing.ownedRods.filterNot { it in before.state.fishing.ownedRods },
            hooks = next.fishing.ownedHooks.filterNot { it in before.state.fishing.ownedHooks })
    if (request.delivery == "notify" && additions != MailAttachments()) insertAdminMail(c, target, "admin:$requestId", "admin_grant",
        request.playerMessage?.title ?: "Подарок от автора",
        request.playerMessage?.body ?: "Начисление уже применено. Состав указан ниже.", true, now.atOffset(ZoneOffset.UTC), additions)
    return true to (before.revision + 1)
}

/** No initialization or blind balance replacement: only the observed revision
 * can receive a signed delta. Its mail, ledger and admin receipt share one tx. */
internal fun adjustAdminEconomy(c: Connection, target: UUID, requestId: UUID, request: AdminEconomyAdjustmentRequest, now: Instant): Long {
    if (c.economyRows("SELECT revision FROM economy_profiles WHERE user_id=?", target) { it.getLong(1) }.isEmpty())
        throw AuthFailure("ADMIN_ECONOMY_NOT_INITIALIZED", "Хозяйство ещё не создано. Используйте обычную выдачу вместо коррекции.", 409)
    val before = readEconomyProfile(c, target)
    if (before.revision != request.expectedRevision)
        throw AuthFailure("ECONOMY_REVISION_CONFLICT", "Баланс изменился. Обновите карточку игрока и подтвердите новую поправку.", 409)
    val next = AdminEconomyAdjustments.apply(before.state, request)
    saveEconomyProfile(c, target, next, recordAwards = false)
    c.economyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items)
        VALUES (?,?,'admin_adjustment',?,?,'{}'::jsonb)""", target, "admin:$requestId",
        next.wallet.coins - before.state.wallet.coins, next.wallet.pearls - before.state.wallet.pearls)
    if (request.delivery == "notify") insertAdminMail(c, target, "admin:$requestId", "balance_correction",
        request.playerMessage?.title ?: "Поправка кошелька",
        request.playerMessage?.body ?: "Я обновил баланс. Изменения указаны ниже.", true, now.atOffset(ZoneOffset.UTC),
        MailAttachments(coins = next.wallet.coins - before.state.wallet.coins,
            pearls = (next.wallet.pearls - before.state.wallet.pearls) / 2L))
    return before.revision + 1
}
