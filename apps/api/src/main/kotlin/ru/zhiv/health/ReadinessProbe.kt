package ru.zhiv.health

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit
import javax.sql.DataSource

fun interface ReadinessProbe {
    suspend fun isReady(): Boolean
}

class JdbcReadinessProbe(
    private val dataSource: DataSource,
    private val cacheMillis: Long = 2_000,
) : ReadinessProbe {
    @Volatile
    private var checkedAtNanos = Long.MIN_VALUE

    @Volatile
    private var cachedResult = false

    override suspend fun isReady(): Boolean = withContext(Dispatchers.IO) {
        val now = System.nanoTime()
        if (isFresh(now)) return@withContext cachedResult

        synchronized(this@JdbcReadinessProbe) {
            val lockedNow = System.nanoTime()
            if (isFresh(lockedNow)) return@synchronized cachedResult

            cachedResult = runCatching {
                dataSource.connection.use { connection ->
                    connection.prepareStatement("SELECT 1").use { statement ->
                        statement.queryTimeout = 2
                        statement.executeQuery().use { result -> result.next() && result.getInt(1) == 1 }
                    }
                }
            }.getOrDefault(false)
            checkedAtNanos = lockedNow
            cachedResult
        }
    }

    private fun isFresh(nowNanos: Long): Boolean =
        checkedAtNanos != Long.MIN_VALUE &&
            nowNanos - checkedAtNanos < TimeUnit.MILLISECONDS.toNanos(cacheMillis.coerceAtLeast(0))
}
