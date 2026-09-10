package ru.zhiv.db

import java.sql.Connection
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import ru.zhiv.admin.TapActivityAnalyzer
import ru.zhiv.admin.TapActivitySample
private data class TapBucket(var received: Int=0,var rejected: Int=0,var events: Int=0,var delayed: Int=0,var legacy: Int=0,
    var intervals: Int=0,var sum: Double=0.0,var squares: Double=0.0)

/** Runs under the same user lock and receipt transaction as submitBatch.
 * Replays exit before this function; no independent client analytics endpoint. */
internal fun recordTapActivity(c: Connection,user: UUID,now: OffsetDateTime,accepted: Int,rejected: Int,times: List<Long>?,previous: Long?) {
    val nowMs=now.toInstant().toEpochMilli()
    val buckets=mutableMapOf<Long,TapBucket>()
    val delivery=buckets.getOrPut(nowMs/1000) { TapBucket() }
    delivery.received=accepted; delivery.rejected=rejected
    if(times==null) delivery.legacy=accepted
    else {
        var prior=previous
        for(at in times) {
            if(nowMs-at>10_000) delivery.delayed++
            if(at>=nowMs-7_200_000) {
                val row=buckets.getOrPut(at/1000) { TapBucket() }; row.events++
                val interval=prior?.let { at-it }
                // Zero intervals may come from initial clock normalization. Long
                // pauses and device/series boundaries are not precision samples.
                if(interval!=null && interval in 1..12_000) {
                    row.intervals++; row.sum+=interval; row.squares+=interval.toDouble()*interval
                }
            }
            prior=at
        }
    }
    c.prepareStatement("""INSERT INTO game_tap_activity_seconds(user_id,bucket_at,received_taps,rejected_taps,event_taps,delayed_taps,legacy_taps,interval_count,interval_sum_ms,interval_squared_sum_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,bucket_at) DO UPDATE SET
        received_taps=game_tap_activity_seconds.received_taps+EXCLUDED.received_taps,
        rejected_taps=game_tap_activity_seconds.rejected_taps+EXCLUDED.rejected_taps,
        event_taps=game_tap_activity_seconds.event_taps+EXCLUDED.event_taps,
        delayed_taps=game_tap_activity_seconds.delayed_taps+EXCLUDED.delayed_taps,
        legacy_taps=game_tap_activity_seconds.legacy_taps+EXCLUDED.legacy_taps,
        interval_count=game_tap_activity_seconds.interval_count+EXCLUDED.interval_count,
        interval_sum_ms=game_tap_activity_seconds.interval_sum_ms+EXCLUDED.interval_sum_ms,
        interval_squared_sum_ms=game_tap_activity_seconds.interval_squared_sum_ms+EXCLUDED.interval_squared_sum_ms""").use { s ->
        for((second,row) in buckets) {
            listOf(user,Instant.ofEpochSecond(second).atOffset(ZoneOffset.UTC),row.received,row.rejected,row.events,row.delayed,row.legacy,row.intervals,row.sum,row.squares)
                .forEachIndexed { i,value -> s.setObject(i+1,value) }
            s.addBatch()
        }
        s.executeBatch()
    }
    // Once per minute per active account, after recording the committed input.
    // A remembered signal only adds a review marker; it never calls ban logic.
    val evaluate=c.prepareStatement("""UPDATE app_users SET tap_analyzed_at=? WHERE id=?
        AND (tap_analyzed_at IS NULL OR tap_analyzed_at<?::timestamptz-interval '1 minute')""").use { s ->
        s.setObject(1,now); s.setObject(2,user); s.setObject(3,now); s.executeUpdate()>0
    }
    if(evaluate) {
        val samples=c.prepareStatement("SELECT * FROM game_tap_activity_seconds WHERE user_id=? AND bucket_at>=? ORDER BY bucket_at").use { s ->
            s.setObject(1,user); s.setObject(2,now.minusMinutes(31)); s.executeQuery().use { r -> buildList {
                while(r.next()) add(TapActivitySample(r.getObject("bucket_at",OffsetDateTime::class.java).toEpochSecond(),
                    r.getLong("received_taps"),r.getLong("rejected_taps"),r.getLong("event_taps"),r.getLong("delayed_taps"),r.getLong("legacy_taps"),
                    r.getLong("interval_count"),r.getDouble("interval_sum_ms"),r.getDouble("interval_squared_sum_ms")))
            } }
        }
        if(TapActivityAnalyzer.analyze("","",false,now.toInstant(),samples).analysis.status=="review")
            c.prepareStatement("UPDATE app_users SET tap_signal_at=? WHERE id=?").use { s -> s.setObject(1,now);s.setObject(2,user);s.executeUpdate() }
    }
}
