package ru.zhiv.db

import ru.zhiv.economy.*
import java.sql.Connection
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID

internal data class EconomyTradeUsage(val buys: Long = 0, val sales: Long = 0, val barter: Long = 0)
internal fun economyTradeDay(at: Instant) = at.atOffset(ZoneOffset.UTC).toLocalDate()
internal fun economyTradeResetsAt(at: Instant): String = economyTradeDay(at).plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC).toString()

/** Callers hold the common account lock; counters survive an economy-profile reset. */
internal fun readEconomyTradeUsage(c: Connection, user: UUID, at: Instant): EconomyTradeUsage = c.economyRows(
    "SELECT buys_value,sales_value,barter_used FROM economy_market_daily_turnover WHERE user_id=? AND trade_day=?", user, economyTradeDay(at)) {
    EconomyTradeUsage(it.getLong(1), it.getLong(2), it.getLong(3))
}.firstOrNull() ?: EconomyTradeUsage()

internal fun addEconomyTradeUsage(c: Connection, user: UUID, at: Instant, buys: Long = 0, sales: Long = 0, barter: Long = 0) {
    c.economyUpdate("""INSERT INTO economy_market_daily_turnover(user_id,trade_day,buys_value,sales_value,barter_used) VALUES (?,?,?,?,?)
        ON CONFLICT(user_id,trade_day) DO UPDATE SET
            buys_value=economy_market_daily_turnover.buys_value+EXCLUDED.buys_value,
            sales_value=economy_market_daily_turnover.sales_value+EXCLUDED.sales_value,
            barter_used=economy_market_daily_turnover.barter_used+EXCLUDED.barter_used""", user, economyTradeDay(at), buys, sales, barter)
}

/** Both account rows are locked; merging spent allowances must never replenish them. */
internal fun mergeEconomyTradeUsage(c: Connection, target: UUID, source: UUID) {
    c.economyUpdate("""INSERT INTO economy_market_daily_turnover(user_id,trade_day,buys_value,sales_value,barter_used)
        SELECT ?,trade_day,buys_value,sales_value,barter_used FROM economy_market_daily_turnover WHERE user_id=?
        ON CONFLICT(user_id,trade_day) DO UPDATE SET
            buys_value=LEAST(10000000000,economy_market_daily_turnover.buys_value+EXCLUDED.buys_value),
            sales_value=LEAST(10000000000,economy_market_daily_turnover.sales_value+EXCLUDED.sales_value),
            barter_used=LEAST(10000000000,economy_market_daily_turnover.barter_used+EXCLUDED.barter_used)""", target, source)
}
