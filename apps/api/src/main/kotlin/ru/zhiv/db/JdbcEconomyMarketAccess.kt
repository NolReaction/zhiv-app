package ru.zhiv.db

import ru.zhiv.economy.EconomyRules

/** The fixed ep alias is shared by peer-market reads; all catalog values stay parameters. */
internal fun economyMarketAccessPredicate(): Pair<String, List<Any>> {
    val config = EconomyRules.catalog.market
    val buildings = config.requiredBuildings.entries
    val sql = """AND COALESCE((ep.state->'buildings'->>'home')::int,1)>=?
        AND COALESCE((ep.state->>'completedExplorations')::bigint,0)>=? """ +
        buildings.joinToString(" ") { "AND COALESCE((ep.state->'buildings'->>?)::int,0)>=?" }
    return sql to (listOf<Any>(config.requiredHomeLevel, config.requiredExplorations) +
        buildings.flatMap { listOf<Any>(it.key, it.value) })
}
