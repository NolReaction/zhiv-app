package ru.zhiv.db

import ru.zhiv.admin.*
import ru.zhiv.economy.*
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID

private fun ResultSet.adminTime(column: String): String? = getObject(column, OffsetDateTime::class.java)?.toInstant()?.toString()

/** JSON aggregates stay in PostgreSQL; only the requested page is decoded.
 * The enclosing repeatable-read transaction keeps profile, escrow and journal coherent. */
private fun economyObservationSql(): String {
    val levels = EconomyRules.catalog.buildings.single { it.id == "warehouse" }.levels
        .joinToString(",") { "(${it.level},${checkNotNull(it.warehouseCapacity)})" }
    return """
        WITH moment AS (SELECT ?::timestamptz AS at), warehouse_levels(level,capacity) AS (VALUES $levels),
        escrow AS (SELECT seller_id,sum(quantity) AS reserved FROM (
            SELECT seller_id,quantity FROM economy_market_listings WHERE status='active'
            UNION ALL SELECT seller_id,1::bigint FROM economy_barter_offers WHERE status='active'
        ) held GROUP BY seller_id),
        stocks AS (
            SELECT u.id,u.public_id,u.display_name,e.state,e.revision,e.updated_at,e.user_id IS NOT NULL AS initialized,
                (e.state->'wallet'->>'coins')::bigint AS coins,(e.state->'wallet'->>'pearls')::bigint AS pearls,
                (e.state->'buildings'->>'home')::integer AS home_level,
                coalesce((e.state->>'completedExplorations')::bigint,0) AS completed_explorations,
                CASE WHEN e.user_id IS NOT NULL THEN w.capacity END AS capacity,
                coalesce((SELECT sum(value::bigint) FROM jsonb_each_text(e.state->'inventory')),0) AS used,
                coalesce(escrow.reserved,0) AS reserved
            FROM app_users u LEFT JOIN economy_profiles e ON e.user_id=u.id
            LEFT JOIN escrow ON escrow.seller_id=u.id
            LEFT JOIN warehouse_levels w ON w.level=coalesce((e.state->'buildings'->>'warehouse')::integer,1)
            WHERE u.deleted_at IS NULL
        ), progress AS (
            SELECT s.*,greatest(0,capacity-used-reserved) AS available,greatest(0,used+reserved-capacity) AS overflow,
                jobs.running_jobs,jobs.ready_jobs,jobs.awaiting_collection_jobs,jobs.blocked_ready_jobs
            FROM stocks s CROSS JOIN moment LEFT JOIN LATERAL (
                SELECT count(*) FILTER (WHERE status IN ('running','collecting')) AS running_jobs,
                    count(*) FILTER (WHERE status='ready') AS ready_jobs,
                    count(*) FILTER (WHERE status='awaiting_collection') AS awaiting_collection_jobs,
                    count(*) FILTER (WHERE status='ready' AND reward_count>greatest(0,s.capacity-s.used-s.reserved)) AS blocked_ready_jobs
                FROM (
                    SELECT CASE WHEN (j->>'finishesAt')::timestamptz>moment.at THEN 'running'
                        WHEN jsonb_typeof(j->'collection')='object' AND j->'collection'->>'startedAt' IS NULL THEN 'awaiting_collection'
                        WHEN (j->'collection'->>'finishesAt')::timestamptz>moment.at THEN 'collecting'
                        ELSE 'ready' END AS status,
                        coalesce((SELECT sum(value::bigint) FROM jsonb_each_text(j->'rewards')),0) AS reward_count
                    FROM jsonb_array_elements(coalesce(s.state->'jobs','[]'::jsonb)) j
                ) classified
            ) jobs ON true
        )
    """.trimIndent()
}

internal fun readAdminEconomy(c: Connection, query: String, sort: String, offset: Int, limit: Int, now: OffsetDateTime): AdminEconomy {
    val sql = economyObservationSql()
    val summary = c.economyRows(sql + """
        SELECT count(*) AS players,count(*) FILTER (WHERE initialized) AS initialized_players,
            count(*) FILTER (WHERE NOT initialized) AS uninitialized_players,
            coalesce(sum(coins),0) AS coins,coalesce(sum(pearls),0) AS pearls,
            coalesce(sum(running_jobs),0) AS running_jobs,coalesce(sum(ready_jobs),0) AS ready_jobs,
            count(*) FILTER (WHERE blocked_ready_jobs>0) AS blocked_players,
            count(*) FILTER (WHERE initialized AND overflow>0) AS overflow_players,
            count(*) FILTER (WHERE updated_at>=?::timestamptz-interval '24 hours' AND updated_at<=?::timestamptz) AS updated_players
        FROM progress
    """.trimIndent(), now, now, now) {
        AdminEconomySummary(it.getLong("players"),it.getLong("initialized_players"),it.getLong("uninitialized_players"),
            it.getLong("coins"),it.getLong("pearls"),it.getLong("running_jobs"),it.getLong("ready_jobs"),
            it.getLong("blocked_players"),it.getLong("overflow_players"),it.getLong("updated_players"))
    }.single()
    val where = "(?='' OR position(lower(?) in lower(display_name))>0 OR position(upper(?) in public_id)>0)"
    val total = c.economyRows("SELECT count(*) FROM app_users WHERE deleted_at IS NULL AND $where", query, query, query) { it.getLong(1) }.single()
    val order = when (sort) {
        "coins" -> "coins DESC NULLS LAST,updated_at DESC NULLS LAST,public_id"
        "progress" -> "home_level DESC NULLS LAST,completed_explorations DESC,updated_at DESC NULLS LAST,public_id"
        "ready" -> "blocked_ready_jobs DESC,ready_jobs DESC,awaiting_collection_jobs DESC,updated_at DESC NULLS LAST,public_id"
        else -> "updated_at DESC NULLS LAST,public_id"
    }
    val players = c.economyRows(sql + "SELECT * FROM progress WHERE $where ORDER BY $order LIMIT ? OFFSET ?", now, query, query, query, limit, offset) { r ->
        val initialized = r.getBoolean("initialized")
        AdminEconomyPlayer(r.getString("public_id"),r.getString("display_name"),initialized,r.adminTime("updated_at"),
            if (initialized) r.getLong("revision") else null,if (initialized) r.getLong("coins") else null,
            if (initialized) r.getLong("pearls") else null,if (initialized) r.getInt("home_level") else null,
            if (initialized) r.getLong("completed_explorations") else null,
            if (initialized) EconomyStorage(r.getLong("capacity"),r.getLong("used"),r.getLong("reserved"),r.getLong("available"),r.getLong("overflow")) else null,
            r.getLong("running_jobs"),r.getLong("ready_jobs"),r.getLong("awaiting_collection_jobs"),r.getLong("blocked_ready_jobs"))
    }
    return AdminEconomy(now.toInstant().toString(),total,offset,limit,summary,players)
}

/** No ensureEconomyProfile: observation must never migrate or create gameplay data. */
internal fun readAdminEconomyPlayer(c: Connection, target: String, now: OffsetDateTime): AdminEconomyDetail? {
    data class Profile(val id: UUID, val name: String, val revision: Long, val updatedAt: String?, val state: EconomyState?)
    val profile = c.economyRows("""SELECT u.id,u.display_name,e.revision,e.updated_at,e.state FROM app_users u
        LEFT JOIN economy_profiles e ON e.user_id=u.id WHERE u.public_id=? AND u.deleted_at IS NULL""", target) { r ->
        Profile(r.getObject("id",UUID::class.java),r.getString("display_name"),r.getLong("revision"),r.adminTime("updated_at"),
            r.getString("state")?.let { economyJson.decodeFromString<EconomyState>(it) })
    }.firstOrNull() ?: return null
    val state = profile.state
    val time = now.toInstant()
    val view = state?.let {
        EconomyView(target,profile.revision,time.toString(),it.wallet,it.inventory,it.buildings,it.jobs,it.migration,
            EconomyRules.catalog,EconomyRules.storage(it,reservedEconomyMarketItems(c,profile.id)),it.completedExplorations,it.fishing)
    }
    val ledger = c.economyRows("""SELECT kind,coins,pearls,items,created_at FROM economy_ledger
        WHERE user_id=? ORDER BY created_at DESC,source_key DESC LIMIT 30""", profile.id) { r ->
        AdminEconomyLedger(r.getString("kind"),r.getLong("coins"),r.getLong("pearls"),
            economyJson.decodeFromString<Map<String,Long>>(r.getString("items")),r.adminTime("created_at")!!)
    }
    return AdminEconomyDetail(target,profile.name,time.toString(),profile.updatedAt,view,
        view?.jobs?.map { AdminEconomyObservations.jobStatus(it,view.storage,time) } ?: emptyList(),ledger)
}
