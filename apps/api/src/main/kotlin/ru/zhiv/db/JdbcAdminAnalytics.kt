package ru.zhiv.db

import kotlinx.serialization.Serializable
import ru.zhiv.admin.*
import ru.zhiv.economy.economyJson
import ru.zhiv.http.parsePublicId
import java.sql.Connection
import java.sql.ResultSet
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

private const val technicalKinds = "'legacy_conversion','account_merge','merged_receipt','dev_grant_currency','dev_grant_item','dev_set_building_level'"
private const val jobKinds = "'claim_job','speedup_construction','start_collection','cancel_exploration'"
private const val escrowKinds = "'market_create','market_cancel','barter_create','barter_cancel'"
private const val passiveKinds = "'market_sell','barter_exchange'"
private const val maxAnalyticsGroups = 1000

private fun ResultSet.analyticsTime(column: String): String? = getObject(column, OffsetDateTime::class.java)?.toInstant()?.toString()
private fun Instant.sqlTime(): OffsetDateTime = atOffset(ZoneOffset.UTC)

/** Scoped SQL is reused for both history and the current snapshot. An allowlist
 * parameter excludes every administrator, not merely the current session. */
private const val scopedUsers = """
    WITH scoped_users AS (
        SELECT u.id,u.public_id,u.display_name,u.created_at FROM app_users u
        WHERE u.deleted_at IS NULL
          AND CASE WHEN ?::text IS NOT NULL THEN u.public_id=? ELSE
            (?='' OR position(lower(?) in lower(u.display_name))>0 OR position(upper(?) in u.public_id)>0) END
          AND (?='all' OR NOT (u.public_id=ANY(?::text[])))
    )
"""

/** Context comes from committed receipts, never from today's building levels.
 * Indexed text comparisons are safe for both UUID jobs and ordinary catalog IDs.
 * JSON guards also keep a malformed old receipt from hiding the whole dashboard. */
private fun periodEvents(materialize: Boolean = false, cohort: Boolean = false) = """
    ${if (cohort) ", cohort_users AS (SELECT * FROM scoped_users WHERE created_at>=? AND created_at<?)" else ""}
    , period_ledger AS (
        SELECT l.*,u.public_id,u.display_name FROM economy_ledger l JOIN ${if (cohort) "cohort_users" else "scoped_users"} u ON u.id=l.user_id
        WHERE ${if (cohort) "l.created_at>=u.created_at AND l.created_at<?" else "l.created_at>=? AND l.created_at<?"} AND l.kind NOT IN ($technicalKinds)
    ), command_context AS (
        SELECT l.*,CASE WHEN cmd.signature IS JSON OBJECT THEN cmd.signature::jsonb END AS command
        FROM period_ledger l LEFT JOIN economy_commands cmd
          ON cmd.user_id=l.user_id AND cmd.request_id::text=CASE WHEN left(l.source_key,8)='command:' THEN substring(l.source_key FROM 9) END
    ), job_context AS (
        SELECT l.*,CASE WHEN original.signature IS JSON OBJECT THEN original.signature::jsonb END AS original
        FROM command_context l LEFT JOIN economy_commands original
          ON l.kind IN ($jobKinds) AND original.user_id=l.user_id AND original.request_id::text=l.command->>'targetId'
    ), attributed AS (
        SELECT l.*,
          coalesce(nullif(l.context->>'targetId',''),
            CASE WHEN l.kind IN ($jobKinds) THEN CASE WHEN original->>'action' IN ('start_construction','start_production','start_exploration','start_fishing')
              THEN nullif(original->>'targetId','') END ELSE nullif(command->>'targetId','') END) AS raw_target,
          CASE WHEN l.kind IN ($escrowKinds) THEN 'escrow'
               WHEN l.kind IN ('market_buy','market_sell','barter_accept','barter_exchange') THEN 'trade' ELSE 'gameplay' END AS category,
          (l.kind='speedup_construction' OR (l.kind='claim_job' AND coalesce(l.context->>'originAction',original->>'action')='start_construction')) IS TRUE AS construction_claim,
          l.kind NOT IN ($passiveKinds) AS active,
          left(l.source_key,8)='command:' OR l.kind IN ($jobKinds,'start_construction','start_production','start_exploration','start_fishing') AS needs_context
        FROM job_context l
    ), events AS ${if (materialize) "MATERIALIZED " else ""}(
        SELECT user_id,public_id,display_name,source_key,kind,created_at,items,category,construction_claim,active,needs_context,
          coalesce(context->>'originAction',original->>'action') AS origin_action,
          coins*(10/currency_scale) AS coins,pearls*(50/pearl_scale) AS pearls,
          CASE WHEN kind IN ('buy_fishing_item','buy_wardrobe_item') THEN regexp_replace(raw_target,'^.*:','')
               WHEN kind='start_production' THEN split_part(raw_target,'@',1)
               WHEN kind IN ('complete_resident_order','replace_resident_order') AND raw_target ~ '^order[0-9]*_' THEN NULL
               WHEN kind='refresh_fishing_shop' AND raw_target IS NOT NULL THEN 'fishing_shop' ELSE raw_target END AS target_id,
          CASE WHEN (command->>'quantity') ~ '^[0-9]{1,9}$' THEN (command->>'quantity')::bigint END AS quantity
        FROM attributed
    ), legs AS ${if (materialize) "MATERIALIZED " else ""}(
        SELECT e.user_id,e.source_key,e.kind,e.target_id,e.category,l.resource_id,l.amount FROM events e
        CROSS JOIN LATERAL (
            SELECT 'coins'::text AS resource_id,e.coins AS amount WHERE e.coins<>0
            UNION ALL SELECT 'pearls',e.pearls WHERE e.pearls<>0
            UNION ALL SELECT key,value::bigint FROM jsonb_each_text(e.items) WHERE value::bigint<>0
        ) l
    )
""".trimIndent()

internal class AnalyticsReads(private val c: Connection, val window: AdminAnalyticsWindow, admins: Set<String>) : AutoCloseable {
    private val adminIds = c.createArrayOf("text", admins.toTypedArray())
    private val exactPublicId = parsePublicId(window.q)
    private val scopeValues = arrayOf<Any?>(exactPublicId, exactPublicId, window.q, window.q, window.q, window.scope, adminIds)
    private val periodValues = arrayOf<Any?>(*scopeValues, window.startAt.sqlTime(), window.endAt.sqlTime())
    fun <T> scoped(sql: String, vararg values: Any?, read: (ResultSet) -> T): List<T> =
        c.economyRows(scopedUsers + sql, *arrayOf(*scopeValues, *values), read = read)
    fun <T> period(sql: String, vararg values: Any?, materialize: Boolean = false, read: (ResultSet) -> T): List<T> =
        c.economyRows(scopedUsers + periodEvents(materialize) + sql, *arrayOf(*periodValues, *values), read = read)
    fun <T> cohort(sql: String, now: Instant, read: (ResultSet) -> T): List<T> =
        c.economyRows(scopedUsers + periodEvents(materialize = true, cohort = true) + sql,
            *arrayOf(*scopeValues, window.startAt.sqlTime(), window.endAt.sqlTime(), now.sqlTime()), read = read)
    override fun close() { adminIds.free() }
}

@Serializable private data class AnalyticsPeriod(
    val summary: AdminAnalyticsSummary, val daily: List<AdminAnalyticsDaily>, val resources: List<AdminAnalyticsResource>,
    val flows: List<AdminAnalyticsFlow>, val actions: List<AdminAnalyticsAction>, val construction: List<AdminAnalyticsConstruction>,
    val unattributedEvents: Long, val gameplay: AdminAnalyticsGameplay, val meals: List<AdminAnalyticsMeal>,
    val orders: List<AdminAnalyticsOrder>,
)

internal fun readAdminAnalytics(c: Connection, window: AdminAnalyticsWindow, admins: Set<String>, now: Instant): AdminAnalytics =
    AnalyticsReads(c, window, admins).use { reads ->
        // Resolve old receipts and normalize money once per request. PostgreSQL
        // retains the bounded events/legs, then returns aggregates only; Kotlin
        // never decodes the individual histories of the matching population.
        val period = reads.period("""
            , days AS (SELECT ?::date+i AS day FROM generate_series(0,?::integer) i),
            daily_counts AS (
                SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
                  count(DISTINCT user_id) FILTER (WHERE active) AS players,count(*) AS events,
                  count(*) FILTER (WHERE kind='start_construction') AS starts FROM events GROUP BY 1
            ), daily_totals AS (
                SELECT d.day::text AS date,coalesce(c.players,0) AS players,coalesce(c.events,0) AS events,
                  coalesce(c.starts,0) AS "constructionStarts" FROM days d LEFT JOIN daily_counts c USING(day)
            ), resource_totals AS (
                SELECT resource_id AS "resourceId",
                  coalesce(sum(amount) FILTER (WHERE amount>0 AND category<>'escrow'),0) AS received,
                  coalesce(sum(-amount) FILTER (WHERE amount<0 AND category<>'escrow'),0) AS spent,
                  coalesce(sum(-amount) FILTER (WHERE amount<0 AND category='escrow'),0) AS reserved,
                  coalesce(sum(amount) FILTER (WHERE amount>0 AND category='escrow'),0) AS returned,
                  sum(amount) AS net,count(DISTINCT user_id) AS players FROM legs GROUP BY resource_id
            ), flow_totals AS (
                SELECT kind,target_id AS "targetId",resource_id AS "resourceId",category,
                  coalesce(sum(amount) FILTER (WHERE amount>0),0) AS received,
                  coalesce(sum(-amount) FILTER (WHERE amount<0),0) AS spent,
                  count(DISTINCT user_id) AS players,count(*) AS events FROM legs
                GROUP BY kind,target_id,resource_id,category
                ORDER BY count(*) DESC,kind,target_id NULLS LAST,resource_id,category LIMIT ?
            ), action_totals AS (
                SELECT kind,target_id AS "targetId",count(*) AS events,count(DISTINCT user_id) AS players FROM events
                GROUP BY kind,target_id ORDER BY count(*) DESC,kind,target_id NULLS LAST LIMIT ?
            ), meal_totals AS (
                SELECT resource_id AS "itemId",coalesce(sum(-amount) FILTER (WHERE kind='eat_food'),0) AS "heroPortions",
                  coalesce(sum(-amount) FILTER (WHERE kind='feed_builder'),0) AS "builderPortions",count(DISTINCT user_id) AS players
                FROM legs WHERE kind IN ('eat_food','feed_builder') AND amount<0 AND resource_id NOT IN ('coins','pearls') GROUP BY resource_id
            ), order_totals AS (
                SELECT target_id AS "templateId",count(*) FILTER (WHERE kind='complete_resident_order') AS completed,
                  count(*) FILTER (WHERE kind='replace_resident_order') AS replacements,
                  count(*) FILTER (WHERE kind='replace_resident_order' AND pearls<0) AS "paidReplacements",
                  coalesce(sum(coins) FILTER (WHERE kind='complete_resident_order' AND coins>0),0) AS "coinsEarned",
                  coalesce(sum(-pearls) FILTER (WHERE kind='replace_resident_order' AND pearls<0),0) AS "pearlsSpent",
                  count(DISTINCT user_id) AS players FROM events WHERE kind IN ('complete_resident_order','replace_resident_order') GROUP BY target_id
                ORDER BY count(*) FILTER (WHERE kind='complete_resident_order') DESC,target_id NULLS LAST LIMIT 1001
            ), construction_totals AS (
                SELECT target_id AS "buildingId",count(*) FILTER (WHERE kind='start_construction') AS starts,
                  count(*) FILTER (WHERE construction_claim) AS claims,count(DISTINCT user_id) AS players
                FROM events WHERE target_id IS NOT NULL AND (kind='start_construction' OR construction_claim) GROUP BY target_id
            )
            SELECT jsonb_build_object(
                'summary',(SELECT to_jsonb(s) FROM (
                    SELECT count(DISTINCT user_id) FILTER (WHERE active) AS "activePlayers",count(*) AS events,
                      count(DISTINCT user_id) FILTER (WHERE category<>'escrow' AND
                        (coins<0 OR pearls<0 OR EXISTS(SELECT 1 FROM jsonb_each_text(items) WHERE value::bigint<0))) AS "spendingPlayers",
                      count(*) FILTER (WHERE kind='start_construction') AS "constructionStarts",
                      count(*) FILTER (WHERE construction_claim) AS "constructionClaims",
                      count(DISTINCT user_id) FILTER (WHERE kind='start_construction' OR construction_claim) AS "constructionPlayers"
                    FROM events
                ) s),
                'gameplay',(SELECT to_jsonb(g) FROM (
                    SELECT (SELECT coalesce(sum(-amount),0) FROM legs WHERE kind IN ('eat_food','feed_builder') AND amount<0 AND resource_id NOT IN ('coins','pearls')) AS "mealsConsumed",
                      count(DISTINCT user_id) FILTER (WHERE kind IN ('eat_food','feed_builder')) AS "foodPlayers",
                      count(*) FILTER (WHERE kind='complete_resident_order') AS "ordersCompleted",
                      count(DISTINCT user_id) FILTER (WHERE kind='complete_resident_order') AS "orderPlayers",
                      coalesce(sum(coins) FILTER (WHERE kind='complete_resident_order' AND coins>0),0) AS "orderCoinsEarned",
                      count(*) FILTER (WHERE kind='replace_resident_order') AS "orderReplacements",
                      count(*) FILTER (WHERE kind='replace_resident_order' AND pearls<0) AS "paidOrderReplacements",
                      coalesce(sum(-pearls) FILTER (WHERE kind='replace_resident_order' AND pearls<0),0) AS "orderPearlsSpent" FROM events
                ) g),
                'meals',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m."heroPortions"+m."builderPortions" DESC,m."itemId") FROM meal_totals m),'[]'::jsonb),
                'orders',coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.completed DESC,o.replacements DESC,o."templateId" NULLS LAST) FROM order_totals o),'[]'::jsonb),
                'daily',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.date) FROM daily_totals d),'[]'::jsonb),
                'resources',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r."resourceId") FROM resource_totals r),'[]'::jsonb),
                'flows',coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.events DESC,f.kind,f."targetId" NULLS LAST,f."resourceId",f.category) FROM flow_totals f),'[]'::jsonb),
                'actions',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.events DESC,a.kind,a."targetId" NULLS LAST) FROM action_totals a),'[]'::jsonb),
                'construction',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.starts DESC,b.claims DESC,b."buildingId") FROM construction_totals b),'[]'::jsonb),
                'unattributedEvents',(SELECT count(*) FROM events WHERE needs_context AND target_id IS NULL)
            )
        """, window.from,java.time.temporal.ChronoUnit.DAYS.between(window.from,window.to).toInt(),
            maxAnalyticsGroups+1,maxAnalyticsGroups+1,materialize=true) { r -> economyJson.decodeFromString<AnalyticsPeriod>(r.getString(1)) }.single()
        // Find the first surviving start before applying the requested dates.
        // Commands copied by account merge are fences, not new player choices.
        val firstConstructions = reads.scoped("""
            , first_starts AS (
                SELECT DISTINCT ON(l.user_id) l.user_id,l.source_key,l.created_at,l.context FROM economy_ledger l
                JOIN scoped_users u ON u.id=l.user_id WHERE l.kind='start_construction' AND l.created_at<?
                ORDER BY l.user_id,l.created_at,l.source_key
            ), first_choices AS (
                SELECT coalesce(nullif(f.context->>'targetId',''),
                  CASE WHEN cmd.signature IS JSON OBJECT THEN nullif(cmd.signature::jsonb->>'targetId','') END) AS building_id
                FROM first_starts f LEFT JOIN economy_commands cmd ON cmd.user_id=f.user_id
                  AND cmd.request_id::text=CASE WHEN left(f.source_key,8)='command:' THEN substring(f.source_key FROM 9) END
                WHERE f.created_at>=? AND f.created_at<?
            ) SELECT building_id,count(*) AS players FROM first_choices GROUP BY building_id ORDER BY players DESC,building_id NULLS LAST
        """, now.sqlTime(),window.startAt.sqlTime(),window.endAt.sqlTime()) { r ->
            AdminAnalyticsFirstConstruction(r.getString("building_id"),r.getLong("players")) }
        val buildingLevels = reads.scoped("""
            SELECT levels.key AS building_id,parsed.level,count(*) AS players
            FROM scoped_users u JOIN economy_profiles p ON p.user_id=u.id
            CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(p.state->'buildings')='object' THEN p.state->'buildings' ELSE '{}'::jsonb END) levels
            CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(levels.value,'integer') THEN levels.value::integer END AS level) parsed
            WHERE parsed.level>=0 GROUP BY levels.key,parsed.level ORDER BY levels.key,parsed.level
        """) { r -> AdminAnalyticsBuildingLevel(r.getString("building_id"),r.getInt("level"),r.getLong("players")) }
        data class Counts(val first: String?, val matching: Long, val initialized: Long)
        val counts = reads.scoped("""
            SELECT (SELECT min(l.created_at) FROM economy_ledger l JOIN scoped_users u ON u.id=l.user_id
                      WHERE l.kind NOT IN ($technicalKinds) AND l.created_at<?) AS first_recorded_at,
              (SELECT count(*) FROM scoped_users) AS matching_players,
              (SELECT count(*) FROM scoped_users u JOIN economy_profiles p ON p.user_id=u.id) AS initialized_players
        """, now.sqlTime()) { r -> Counts(r.analyticsTime("first_recorded_at"),r.getLong("matching_players"),r.getLong("initialized_players")) }.single()
        AdminAnalytics(now.toString(),window.from.toString(),window.to.toString(),window.startAt.toString(),window.endAt.toString(),window.q,window.scope,
            period.summary,period.daily,period.resources,period.flows.take(maxAnalyticsGroups),period.actions.take(maxAnalyticsGroups),period.construction,firstConstructions,buildingLevels,
            AdminAnalyticsCoverage(counts.first,period.unattributedEvents,counts.matching,counts.initialized,
                period.flows.size>maxAnalyticsGroups,period.actions.size>maxAnalyticsGroups,period.orders.size>maxAnalyticsGroups), period.gameplay,period.meals,period.orders.take(maxAnalyticsGroups),readPresence(reads,window),readAdminProgression(reads,now))
    }

internal fun readAdminAnalyticsEvents(c: Connection, window: AdminAnalyticsWindow, query: AdminAnalyticsEventsQuery,
    admins: Set<String>, now: Instant): AdminAnalyticsEvents = AnalyticsReads(c, window, admins).use { reads ->
    // Compare the selected resource directly on each row. Re-scanning a shared
    // legs CTE for every journal event would turn a long period into quadratic work.
    val comparison = when (query.direction) { "in" -> ">0"; "out" -> "<0"; else -> "<>0" }
    val movement = if (query.resource.isNotEmpty())
        "(CASE ? WHEN 'coins' THEN e.coins WHEN 'pearls' THEN e.pearls ELSE coalesce((e.items->>?)::bigint,0) END)$comparison"
    else if (query.direction == "all") "true"
    else "(e.coins$comparison OR e.pearls$comparison OR EXISTS(SELECT 1 FROM jsonb_each_text(e.items) WHERE value::bigint$comparison))"
    val filtered = """
        , filtered_events AS (
            SELECT * FROM events e WHERE (?='' OR kind=?) AND $movement
        )
    """.trimIndent()
    val values = if (query.resource.isEmpty()) arrayOf<Any?>(query.kind,query.kind)
        else arrayOf<Any?>(query.kind,query.kind,query.resource,query.resource)
    val total = reads.period(filtered + " SELECT count(*) FROM filtered_events", *values) { it.getLong(1) }.single()
    val events = reads.period(filtered + " SELECT * FROM filtered_events ORDER BY created_at DESC,user_id,source_key LIMIT ? OFFSET ?",
        *arrayOf(*values,query.limit,query.offset)) { r ->
        AdminAnalyticsEvent(r.getString("public_id") + ":" + r.getString("source_key"),r.getString("public_id"),r.getString("display_name"),
            r.analyticsTime("created_at")!!,r.getString("kind"),r.getString("target_id"),r.getObject("quantity",java.lang.Long::class.java)?.toLong(),
            !r.getBoolean("needs_context") || r.getString("target_id") != null,r.getString("category"),r.getLong("coins"),r.getLong("pearls"),
            economyJson.decodeFromString<Map<String,Long>>(r.getString("items")))
    }
    AdminAnalyticsEvents(now.toString(),window.from.toString(),window.to.toString(),window.startAt.toString(),window.endAt.toString(),window.q,window.scope,
        query.kind,query.resource,query.direction,query.at,query.offset,query.limit,total,events)
}

@Serializable private data class PresenceSummary(val players: Long, val onlineSeconds: Long, val flaggedPlayers: Long,
    val daily: List<AdminAnalyticsPresenceDay>, val reviewDays: List<AdminAnalyticsPresenceReview>)

private fun readPresence(reads: AnalyticsReads, window: AdminAnalyticsWindow): AdminAnalyticsPresence {
    val summary = reads.scoped("""
        , period AS MATERIALIZED (
            SELECT d.*,u.public_id,u.display_name,a.tap_watchlisted FROM game_presence_daily d
            JOIN scoped_users u ON u.id=d.user_id JOIN app_users a ON a.id=u.id WHERE d.day>=? AND d.day<=?
        ), days AS (SELECT ?::date+i AS day FROM generate_series(0,?::integer) i),
        totals AS (
            SELECT day,count(*) FILTER (WHERE online_millis>0) AS players,floor(coalesce(sum(online_millis),0)/1000)::bigint AS seconds,
              count(*) FILTER (WHERE flagged_at IS NOT NULL) AS flagged FROM period GROUP BY day
        ), daily AS (
            SELECT d.day::text AS date,coalesce(t.players,0) AS players,coalesce(t.seconds,0) AS "onlineSeconds",
              coalesce(t.flagged,0) AS "flaggedPlayers" FROM days d LEFT JOIN totals t USING(day)
        ), reviews AS (
            SELECT public_id AS "publicId",display_name AS "displayName",day::text AS date,online_millis/1000 AS "onlineSeconds",
              to_char(flagged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "flaggedAt",tap_watchlisted AS watchlisted
            FROM period WHERE flagged_at IS NOT NULL ORDER BY day DESC,online_millis DESC,public_id LIMIT 101
        ) SELECT jsonb_build_object(
            'players',(SELECT count(DISTINCT user_id) FROM period WHERE online_millis>0),
            'onlineSeconds',(SELECT floor(coalesce(sum(online_millis),0)/1000)::bigint FROM period),
            'flaggedPlayers',(SELECT count(DISTINCT user_id) FROM period WHERE flagged_at IS NOT NULL),
            'daily',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.date) FROM daily d),'[]'::jsonb),
            'reviewDays',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.date DESC,r."onlineSeconds" DESC,r."publicId") FROM reviews r),'[]'::jsonb)
        )
    """,window.from,window.to,window.from,java.time.temporal.ChronoUnit.DAYS.between(window.from,window.to).toInt()) {
        economyJson.decodeFromString<PresenceSummary>(it.getString(1))
    }.single()
    // Runtime cannot read Flyway history. Report the first surviving measured day of this audience.
    val coverage = reads.scoped("""
        SELECT to_char(min(d.day)::timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        FROM game_presence_daily d JOIN scoped_users u ON u.id=d.user_id
    """) { it.getString(1) }.firstOrNull()
    return AdminAnalyticsPresence(coverage,summary.players,summary.onlineSeconds,summary.flaggedPlayers,
        summary.daily,summary.reviewDays.take(100),summary.reviewDays.size>100)
}
