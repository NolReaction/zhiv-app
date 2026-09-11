package ru.zhiv.db

import org.slf4j.LoggerFactory
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.sql.DataSource

/** Retention also runs when nobody taps. Small committed chunks release locks
 * promptly, and the loop catches up instead of imposing a fixed deletion quota. */
internal class TapActivityMaintenance(private val source: DataSource): AutoCloseable {
    private val log=LoggerFactory.getLogger(TapActivityMaintenance::class.java)
    private val executor=Executors.newSingleThreadScheduledExecutor { task -> Thread(task,"tap-activity-retention").apply { isDaemon=true } }
    init { executor.scheduleWithFixedDelay({
        try {
            while(!Thread.currentThread().isInterrupted && purgeTapActivity(source)==5000) { /* drain stale chunks */ }
        } catch(error: Exception) { log.warn("Tap activity retention will retry: {}",error.javaClass.simpleName) }
    },0,60,TimeUnit.SECONDS) }
    override fun close() { executor.shutdownNow(); executor.awaitTermination(6,TimeUnit.SECONDS) }
}

internal fun purgeTapActivity(source: DataSource): Int = source.connection.use { c ->
    c.autoCommit=false
    try {
        c.createStatement().use { it.execute("SET LOCAL statement_timeout='5s'") }
        val count=c.prepareStatement("""DELETE FROM game_tap_activity_seconds WHERE ctid IN
            (SELECT ctid FROM game_tap_activity_seconds WHERE bucket_at<clock_timestamp()-interval '2 hours'
             ORDER BY bucket_at LIMIT 5000 FOR UPDATE SKIP LOCKED)""").use { it.executeUpdate() }
        val minutes=c.prepareStatement("""DELETE FROM game_tap_activity_minutes WHERE ctid IN
            (SELECT ctid FROM game_tap_activity_minutes WHERE bucket_at<date_trunc('minute',clock_timestamp())-interval '30 days'
             ORDER BY bucket_at LIMIT 5000 FOR UPDATE SKIP LOCKED)""").use { it.executeUpdate() }
        c.commit(); maxOf(count,minutes)
    } catch(error: Exception) { c.rollback(); throw error }
}
