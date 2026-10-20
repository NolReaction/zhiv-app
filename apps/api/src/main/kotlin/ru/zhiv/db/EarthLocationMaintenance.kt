package ru.zhiv.db

import org.slf4j.LoggerFactory
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.sql.DataSource

/** Expired fixes are physically deleted even when their owners never return. */
internal class EarthLocationMaintenance(private val source: DataSource): AutoCloseable {
    private val log=LoggerFactory.getLogger(EarthLocationMaintenance::class.java)
    private val executor=Executors.newSingleThreadScheduledExecutor { task -> Thread(task,"earth-location-expiry").apply { isDaemon=true } }
    init { executor.scheduleWithFixedDelay({
        try { while(!Thread.currentThread().isInterrupted && purgeEarthLocations(source)==1000) { /* bounded committed batches */ } }
        catch(error: Exception) { log.warn("Earth location expiry will retry: {}",error.javaClass.simpleName) }
    },0,60,TimeUnit.SECONDS) }
    override fun close() { executor.shutdownNow();executor.awaitTermination(6,TimeUnit.SECONDS) }
}
internal fun purgeEarthLocations(source: DataSource): Int=source.connection.use { c ->
    c.autoCommit=false
    try {
        c.createStatement().use { it.execute("SET LOCAL statement_timeout='5s'") }
        val consent=c.economyUpdate("""UPDATE earth_sharing_settings SET mode='OFF',revision=least(revision+1,9007199254740990),
            sharing_until=NULL,publication_epoch=NULL,publisher_session_id=NULL,last_sequence=0,last_captured_at=NULL,last_accepted_at=NULL
            WHERE user_id IN(SELECT user_id FROM earth_sharing_settings WHERE mode IN ('SHARING','GHOST') AND sharing_until<=clock_timestamp()
                ORDER BY sharing_until LIMIT 1000 FOR UPDATE SKIP LOCKED)""")
        val points=c.economyUpdate("""DELETE FROM earth_latest_locations WHERE user_id IN
            (SELECT user_id FROM earth_latest_locations WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)""")
        val frozen=c.economyUpdate("""DELETE FROM earth_frozen_locations WHERE (owner_user_id,circle_id) IN
            (SELECT owner_user_id,circle_id FROM earth_frozen_locations WHERE expires_at<=clock_timestamp()
                ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)""")
        c.commit();maxOf(consent,points,frozen)
    } catch(error: Exception) { c.rollback();throw error }
}
