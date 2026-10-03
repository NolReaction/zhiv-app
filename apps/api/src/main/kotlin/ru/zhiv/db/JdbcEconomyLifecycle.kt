package ru.zhiv.db

import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.ECONOMY_MAX_BALANCE
import ru.zhiv.economy.EconomyState
import ru.zhiv.economy.EconomyRules
import ru.zhiv.world.WorldState
import ru.zhiv.world.worldJson
import ru.zhiv.economy.economyJson
import java.sql.Connection
import java.util.UUID

private fun Connection.lifecycleEconomyUpdate(sql: String, vararg values: Any?): Int = prepareStatement(sql).use { statement ->
    values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
    statement.executeUpdate()
}

private fun economyStateForReview(c: Connection, user: UUID): EconomyState {
    val current = c.prepareStatement("SELECT state FROM economy_profiles WHERE user_id=?").use { statement ->
        statement.setObject(1, user)
        statement.executeQuery().use { if (it.next()) economyJson.decodeFromString<EconomyState>(it.getString(1)) else null }
    }
    if (current != null) return current
    val old = c.prepareStatement("SELECT state FROM world_profiles WHERE user_id=?").use { statement ->
        statement.setObject(1, user)
        statement.executeQuery().use { if (it.next()) worldJson.decodeFromString<WorldState>(it.getString(1)) else WorldState() }
    }
    val converted = c.prepareStatement("SELECT 1 FROM economy_conversion_audit WHERE user_id=?").use { statement ->
        statement.setObject(1, user)
        statement.executeQuery().use { it.next() }
    }
    return EconomyRules.initial(if (converted) 0 else old.resources.sparks, if (converted) 0 else old.resources.wood,
        if (converted) 0 else old.resources.stone, old.houseLevel, if (old.workshop) maxOf(1,old.workshopLevel) else 0)
}

/** Review is read-only: in particular, it cannot mint a migration grant. */
internal fun economyMergeConflicts(c: Connection, target: UUID, source: UUID): List<String> {
    val states = listOf(economyStateForReview(c, target), economyStateForReview(c, source))
    val escrow = c.prepareStatement("""SELECT item_id,sum(quantity) FROM economy_market_listings
        WHERE seller_id IN (?,?) AND status='active' GROUP BY item_id""").use { statement ->
        statement.setObject(1,target); statement.setObject(2,source)
        statement.executeQuery().use { rows -> buildMap<String, Long> { while (rows.next()) put(rows.getString(1),rows.getLong(2)) } }
    }
    val combinedInventory = (states.flatMap { it.inventory.keys } + escrow.keys).distinct().associateWith { item ->
        states.sumOf { it.inventory[item] ?: 0L } + (escrow[item] ?: 0L)
    }
    val combinedBuildings = states.flatMap { it.buildings.keys }.distinct().associateWith { building ->
        states.maxOf { it.buildings[building] ?: 0 }
    }
    val mergedStorage = EconomyRules.storage(states.first().copy(inventory=combinedInventory, buildings=combinedBuildings))
    return buildList {
        if (states.any { it.jobs.isNotEmpty() }) add("Сначала получите результаты производства, строительства и исследований в обоих профилях. Затем повторите объединение.")
        if (states.sumOf { it.wallet.coins } > ECONOMY_MAX_BALANCE || states.sumOf { it.wallet.pearls } > ECONOMY_MAX_BALANCE ||
            combinedInventory.values.any { it > ECONOMY_MAX_BALANCE } || mergedStorage.overflow > 0)
            add("Общий запас превышает вместимость склада. Расширьте склад или уменьшите запасы перед объединением; предметы не будут потеряны.")
    }
}

/** Both user rows must already be locked in UUID order; market escrow is returned first. */
internal fun mergeEconomyProfiles(c: Connection, target: UUID, source: UUID) {
    ensureEconomyProfile(c, target)
    ensureEconomyProfile(c, source)
    val a = readEconomyProfile(c, target).state
    val b = readEconomyProfile(c, source).state
    val conflicts = economyMergeConflicts(c, target, source)
    if (conflicts.isNotEmpty()) throw AuthFailure("ACCOUNT_MERGE_CONFLICT", conflicts.joinToString(" "), 409)
    fun add(first: Long, second: Long): Long {
        if (first > ECONOMY_MAX_BALANCE - second) throw AuthFailure("ECONOMY_CAPACITY", "Общий запас превышает вместимость экономики", 409)
        return first + second
    }
    val inventory = (a.inventory.keys + b.inventory.keys).associateWith { add(a.inventory[it] ?: 0, b.inventory[it] ?: 0) }
    val buildings = (a.buildings.keys + b.buildings.keys).associateWith { maxOf(a.buildings[it] ?: 0, b.buildings[it] ?: 0) }
    saveEconomyProfile(c, target, a.copy(wallet=a.wallet.copy(coins=add(a.wallet.coins,b.wallet.coins), pearls=add(a.wallet.pearls,b.wallet.pearls)),
        inventory=inventory, buildings=buildings, completedExplorations=add(a.completedExplorations,b.completedExplorations)))
    // Preserve original signatures: an old source browser cannot reuse a consumed request ID.
    c.lifecycleEconomyUpdate("""INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision)
        SELECT ?,request_id,signature,message,accepted_revision FROM economy_commands WHERE user_id=? ON CONFLICT DO NOTHING""", target, source)
    // These rows are idempotency fences, not another transfer of the source's historic earnings.
    c.lifecycleEconomyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,items)
        SELECT ?,source_key,'merged_receipt',0,'{}'::jsonb FROM economy_ledger WHERE user_id=? ON CONFLICT DO NOTHING""", target, source)
    c.lifecycleEconomyUpdate("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items)
        VALUES (?,?,'account_merge',?,?,?::jsonb) ON CONFLICT DO NOTHING""", target,"merge:$source",b.wallet.coins,b.wallet.pearls,economyJson.encodeToString(b.inventory))
}

/** Keep the one-time conversion audit attached to the retired UUID. No new grant on reset. */
internal fun removeEconomyProfile(c: Connection, user: UUID) {
    c.lifecycleEconomyUpdate("DELETE FROM economy_commands WHERE user_id=?", user)
    c.lifecycleEconomyUpdate("DELETE FROM economy_ledger WHERE user_id=?", user)
    c.lifecycleEconomyUpdate("DELETE FROM economy_profiles WHERE user_id=?", user)
}
