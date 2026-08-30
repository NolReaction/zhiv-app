package ru.zhiv.observability

import org.slf4j.LoggerFactory
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue

data class ClickerSeriesFinishedEvent(
    val eventId: UUID,
    val tapCount: Long,
    val bestSeries: Long,
    val lifetimeTaps: Long?,
    val level: Int,
    val storyId: String,
    val durationMs: Long,
    val reason: String,
)

fun interface GameEventSink {
    fun record(event: ClickerSeriesFinishedEvent)
}

class Slf4jGameEventSink : GameEventSink {
    private val logger = LoggerFactory.getLogger("ru.zhiv.events")
    private val recentEventIds = ConcurrentHashMap.newKeySet<UUID>()
    private val recentEventOrder = ConcurrentLinkedQueue<UUID>()

    override fun record(event: ClickerSeriesFinishedEvent) {
        if (!recentEventIds.add(event.eventId)) return
        recentEventOrder.add(event.eventId)
        while (recentEventIds.size > 4_096) {
            recentEventOrder.poll()?.let(recentEventIds::remove) ?: break
        }
        logger.atInfo()
            .addKeyValue("schema_version", if (event.lifetimeTaps == null) 1 else 2)
            .addKeyValue("event", "clicker_series_finished")
            .addKeyValue("source", "ktor")
            .addKeyValue("client_reported", true)
            .addKeyValue("tap_count", event.tapCount)
            .addKeyValue("best_series", event.bestSeries)
            .addKeyValue("lifetime_taps", event.lifetimeTaps)
            .addKeyValue("level", event.level)
            .addKeyValue("story_id", event.storyId)
            .addKeyValue("duration_ms", event.durationMs)
            .addKeyValue("reason", event.reason)
            .log("domain_event")
    }
}
