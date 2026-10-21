package ru.zhiv.db

import ru.zhiv.earth.EarthRateLimited
import java.util.UUID

/** Bounds lock-heavy commands before participant locks; holds no location data.
 * Publication and enable requests never consume the independent privacy budget.
 * Durable publication and enable pacing additionally run in PostgreSQL across replicas.
 */
internal class EarthCommandBudgets(private val clock: ()->Long=System::nanoTime) {
    private data class Bucket(val start: Long,var count: Int)
    private val buckets=LinkedHashMap<Pair<UUID,String>,Bucket>(16,0.75f,true)
    @Synchronized fun take(user: UUID,kind: String) {
        val time=clock();val key=user to kind;val old=buckets[key]
        val value=if(old==null || time-old.start>=60_000_000_000L) Bucket(time,0).also { buckets[key]=it } else old
        if(value.count >= (if(kind=="privacy") 600 else 120)) {
            val remaining=60_000_000_000L-(time-value.start)
            throw EarthRateLimited(((remaining+999_999_999L)/1_000_000_000L).coerceIn(1,60).toInt())
        }
        value.count++
        // Only authenticated account IDs allocate buckets. Memory is globally bounded.
        while(buckets.size>20_000) buckets.remove(buckets.keys.first())
    }
}
