package ru.zhiv.db

import ru.zhiv.admin.AdminAnalyticsProgression
import ru.zhiv.admin.AdminAnalyticsProgressionCohort
import ru.zhiv.admin.AdminAnalyticsProgressionSnapshot
import ru.zhiv.economy.economyJson
import java.time.Instant
import java.time.ZoneOffset

/** Registration chooses the cohort; surviving receipts are observed through now.
 * These milestones are independent branches, not a claimed linear funnel. A
 * current building level never supplies a missing historical timestamp. */
internal fun readAdminProgression(reads: AnalyticsReads, now: Instant): AdminAnalyticsProgression {
    val cohort = reads.cohort("""
        , first_events AS (
            SELECT u.id,u.created_at,
              min(e.created_at) FILTER (WHERE e.active) AS first_action,
              min(e.created_at) FILTER (WHERE e.kind IN ('start_production','start_exploration','start_fishing')) AS first_work_started,
              min(e.created_at) FILTER (WHERE e.kind='claim_job' AND e.origin_action IN ('start_production','start_exploration','start_fishing')) AS first_work_claimed,
              min(e.created_at) FILTER (WHERE e.kind='start_construction') AS first_construction_started,
              min(e.created_at) FILTER (WHERE e.construction_claim) AS first_construction_claimed
            FROM cohort_users u LEFT JOIN events e ON e.user_id=u.id GROUP BY u.id,u.created_at
        ), milestones AS (
            SELECT f.created_at,m.id,m.at FROM first_events f CROSS JOIN LATERAL (VALUES
                ('first_action',f.first_action),('first_work_started',f.first_work_started),
                ('first_work_claimed',f.first_work_claimed),('first_construction_started',f.first_construction_started),
                ('first_construction_claimed',f.first_construction_claimed)
            ) m(id,at)
        ), stage_ids(id,position) AS (VALUES ('first_action',1),('first_work_started',2),('first_work_claimed',3),
            ('first_construction_started',4),('first_construction_claimed',5)),
        stages AS (
            SELECT s.id,s.position,count(m.at) AS players,
              floor(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM m.at-m.created_at)))::bigint AS "medianSeconds"
            FROM stage_ids s LEFT JOIN milestones m ON m.id=s.id GROUP BY s.id,s.position
        ) SELECT jsonb_build_object(
            'players',(SELECT count(*) FROM cohort_users),
            'initializedPlayers',(SELECT count(*) FROM cohort_users u JOIN economy_profiles p ON p.user_id=u.id),
            'home2Players',(SELECT count(*) FROM cohort_users u JOIN economy_profiles p ON p.user_id=u.id
              WHERE CASE WHEN pg_input_is_valid(p.state->'buildings'->>'home','integer')
                THEN (p.state->'buildings'->>'home')::integer BETWEEN 2 AND 5 ELSE false END),
            'playersWithEvents',(SELECT count(*) FROM first_events WHERE first_action IS NOT NULL),
            'firstRecordedAt',(SELECT to_char(min(first_action) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM first_events),
            'stages',coalesce((SELECT jsonb_agg(to_jsonb(s)-'position' ORDER BY s.position) FROM stages s),'[]'::jsonb)
        )
    """, now) { economyJson.decodeFromString<AdminAnalyticsProgressionCohort>(it.getString(1)) }.single()

    // The selected dates describe registrations above, not this present-day
    // snapshot. An absent operation history is unknown and cannot mean offline.
    val snapshot = reads.scoped("""
        , moment AS (SELECT ?::timestamptz AS at),
        observed AS (
            SELECT u.id,u.public_id,u.display_name,p.user_id IS NOT NULL AS initialized,
              CASE WHEN pg_input_is_valid(p.state->'buildings'->>'home','integer')
                THEN CASE WHEN (p.state->'buildings'->>'home')::integer BETWEEN 1 AND 5 THEN (p.state->'buildings'->>'home')::integer END END AS home_level,history.last_action_at,
              jobs.ready_since,jobs.awaiting_collection_since
            FROM scoped_users u CROSS JOIN moment LEFT JOIN economy_profiles p ON p.user_id=u.id
            LEFT JOIN LATERAL (
                SELECT max(l.created_at) AS last_action_at FROM economy_ledger l
                WHERE l.user_id=u.id AND l.created_at>=u.created_at AND l.created_at<moment.at
                  AND l.kind NOT IN ('legacy_conversion','account_merge','merged_receipt','dev_grant_currency',
                    'dev_grant_item','dev_set_building_level','market_sell','barter_exchange')
            ) history ON true
            LEFT JOIN LATERAL (
                SELECT min(ready_at) FILTER (WHERE ready_at<moment.at-interval '24 hours') AS ready_since,
                  min(awaiting_at) FILTER (WHERE awaiting_at<moment.at-interval '24 hours') AS awaiting_collection_since
                FROM (
                    SELECT CASE WHEN isfinite(finish_at) AND finish_at<=moment.at
                        AND (NOT has_collection OR collection_started AND isfinite(collection_start_at)
                          AND isfinite(collection_finish_at) AND collection_finish_at<=moment.at)
                        THEN CASE WHEN has_collection THEN collection_finish_at ELSE finish_at END END AS ready_at,
                      CASE WHEN isfinite(finish_at) AND finish_at<=moment.at AND has_collection AND NOT collection_started THEN finish_at END AS awaiting_at
                    FROM (
                        SELECT CASE WHEN pg_input_is_valid(j->>'finishesAt','timestamp with time zone')
                            THEN (j->>'finishesAt')::timestamptz END AS finish_at,
                          CASE WHEN pg_input_is_valid(j->'collection'->>'finishesAt','timestamp with time zone')
                            THEN (j->'collection'->>'finishesAt')::timestamptz END AS collection_finish_at,
                          CASE WHEN pg_input_is_valid(j->'collection'->>'startedAt','timestamp with time zone')
                            THEN (j->'collection'->>'startedAt')::timestamptz END AS collection_start_at,
                          coalesce(jsonb_typeof(j->'collection')='object',false) AS has_collection,
                          j->'collection'->>'startedAt' IS NOT NULL AS collection_started
                        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.state->'jobs')='array'
                            THEN p.state->'jobs' ELSE '[]'::jsonb END) j
                    ) parsed
                ) classified
            ) jobs ON true
        ), signals AS (
            SELECT o.*,last_action_at<=moment.at-interval '72 hours' AS no_action,
              array_remove(ARRAY[
                CASE WHEN ready_since IS NOT NULL THEN 'ready_24h' END,
                CASE WHEN awaiting_collection_since IS NOT NULL THEN 'awaiting_collection_24h' END,
                CASE WHEN last_action_at<=moment.at-interval '72 hours' THEN 'no_action_72h' END
              ],NULL) AS reasons FROM observed o CROSS JOIN moment
        ), reviews AS (
            SELECT public_id AS "publicId",display_name AS "displayName",home_level AS "homeLevel",
              to_char(last_action_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastActionAt",
              to_char(ready_since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "readySince",
              to_char(awaiting_collection_since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "awaitingCollectionSince",reasons AS signals
            FROM signals WHERE cardinality(reasons)>0
            ORDER BY ready_since ASC NULLS LAST,awaiting_collection_since ASC NULLS LAST,last_action_at ASC NULLS LAST,public_id LIMIT 100
        ) SELECT jsonb_build_object(
            'matchingPlayers',(SELECT count(*) FROM observed),
            'initializedPlayers',(SELECT count(*) FROM observed WHERE initialized),
            'unknownHistoryPlayers',(SELECT count(*) FROM observed WHERE initialized AND last_action_at IS NULL),
            'noAction72hPlayers',(SELECT count(*) FROM signals WHERE no_action),
            'ready24hPlayers',(SELECT count(*) FROM observed WHERE ready_since IS NOT NULL),
            'awaitingCollection24hPlayers',(SELECT count(*) FROM observed WHERE awaiting_collection_since IS NOT NULL),
            'review',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r."readySince" ASC NULLS LAST,
              r."awaitingCollectionSince" ASC NULLS LAST,r."lastActionAt" ASC NULLS LAST,r."publicId") FROM reviews r),'[]'::jsonb),
            'reviewTruncated',(SELECT count(*)>100 FROM signals WHERE cardinality(reasons)>0)
        )
    """, now.atOffset(ZoneOffset.UTC)) { economyJson.decodeFromString<AdminAnalyticsProgressionSnapshot>(it.getString(1)) }.single()
    return AdminAnalyticsProgression(now.toString(),cohort,snapshot)
}
