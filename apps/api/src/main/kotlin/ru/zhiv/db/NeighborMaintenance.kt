package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import org.slf4j.LoggerFactory
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Reads never trigger trades. A bounded worker also runs while users are offline. */
internal class NeighborMaintenance(private val repository: JdbcNeighborRepository) : AutoCloseable {
    private val log=LoggerFactory.getLogger(NeighborMaintenance::class.java)
    private val executor=Executors.newSingleThreadScheduledExecutor { task -> Thread(task,"world-neighbor").apply { isDaemon=true } }
    private var failures=0
    init { executor.scheduleWithFixedDelay({
        try { runBlocking { repository.runAutomaticBatch() };failures=0 }
        catch(error: Exception) {
            failures++
            log.warn("World neighbor batch failed; attempt {}: {}",failures,error.javaClass.simpleName)
            if(failures>=3) try { runBlocking { repository.pauseAutomatic("Автоматический выкуп приостановлен после повторных ошибок. Проверьте журнал сервера и сохраните настройки для возобновления.") } }
            catch(_: Exception) { log.warn("World neighbor safety pause could not be persisted") }
        }
    },30,30,TimeUnit.SECONDS) }
    override fun close() { executor.shutdownNow();executor.awaitTermination(6,TimeUnit.SECONDS) }
}
