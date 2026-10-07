package ru.zhiv.economy

import kotlinx.serialization.Serializable
import java.time.Duration
import java.time.Instant

@Serializable private data class TravelCollectionSpec(val secondsPerFind: Long, val routes: List<String>, val finds: List<String>)
@Serializable private data class QuarryCollectionFind(val id: String, val name: String, val description: String)
@Serializable private data class QuarryCollectionSpec(val secondsPerFind: Long, val routes: List<String>, val productionBuilding: String, val finds: List<QuarryCollectionFind>)
@Serializable private data class CollectionBookCatalog(val version: Int, val travel: TravelCollectionSpec, val quarry: QuarryCollectionSpec)

/** Cosmetic book progress shares the same catalogue and completed-job clock as TypeScript. */
object EconomyCollectionProgress {
    private val catalog: CollectionBookCatalog = economyJson.decodeFromString(
        checkNotNull(EconomyCollectionProgress::class.java.getResourceAsStream("/world/collections-catalog.json"))
            .bufferedReader().use { it.readText() })
    private val travelFinds = catalog.travel.finds
    private val quarryFinds = catalog.quarry.finds.map { it.id }
    private val knownFinds = (travelFinds + quarryFinds).toSet()
    init {
        require(catalog.version == 1 && catalog.travel.secondsPerFind > 0 && catalog.quarry.secondsPerFind > 0)
        require(knownFinds.size == travelFinds.size + quarryFinds.size)
    }
    private fun add(first: Long, second: Long): Long = minOf(ECONOMY_MAX_ITEMS, first + second)

    fun inherit(value: EconomyProgression, inherited: List<String>): EconomyProgression = value.copy(
        collections = value.collections.copy(finds = (value.collections.finds.filter { it in knownFinds } +
            inherited.filter { it in travelFinds }).distinct().sorted()))

    /** Invoke only after a successful claim, never when starting, buying or cancelling. */
    fun advance(value: EconomyProgression, job: EconomyJob): EconomyProgression {
        val seconds = maxOf(0L, Duration.between(Instant.parse(job.startedAt), Instant.parse(job.finishesAt)).seconds)
        val travel = job.kind == "exploration" && job.targetId in catalog.travel.routes
        val quarry = job.kind == "exploration" && job.targetId in catalog.quarry.routes ||
            job.kind == "production" && job.targetId == catalog.quarry.productionBuilding
        val previous = value.collections
        val travelSeconds = if (travel) add(previous.travelSeconds, seconds) else previous.travelSeconds
        val quarrySeconds = if (quarry) add(previous.quarrySeconds, seconds) else previous.quarrySeconds
        val finds = previous.finds.toMutableSet()
        fun discover(ids: List<String>, count: Long) {
            repeat(minOf(ids.size.toLong(), count).toInt()) {
                ids.firstOrNull { it !in finds }?.let(finds::add)
            }
        }
        discover(travelFinds, travelSeconds / catalog.travel.secondsPerFind - previous.travelSeconds / catalog.travel.secondsPerFind)
        discover(quarryFinds, quarrySeconds / catalog.quarry.secondsPerFind - previous.quarrySeconds / catalog.quarry.secondsPerFind)
        return value.copy(
            routes = if (job.kind == "exploration") value.routes + (job.targetId to add(value.routes[job.targetId] ?: 0, 1)) else value.routes,
            recipes = if (job.kind == "production" && job.recipeId != null) value.recipes +
                (job.recipeId to add(value.recipes[job.recipeId] ?: 0, 1)) else value.recipes,
            collections = EconomyBookCollection(finds.sorted(), travelSeconds, quarrySeconds))
    }

    fun personallyFound(value: EconomyBookCollection, inherited: List<String>): Boolean =
        value.travelSeconds >= catalog.travel.secondsPerFind && value.finds.any { it in travelFinds && it !in inherited } ||
            value.quarrySeconds >= catalog.quarry.secondsPerFind && value.finds.any { it in quarryFinds && it !in inherited }

    fun merge(first: EconomyProgression, second: EconomyProgression): EconomyProgression {
        fun counts(a: Map<String, Long>, b: Map<String, Long>) = (a.keys + b.keys).associateWith { add(a[it] ?: 0, b[it] ?: 0) }
        val finds = (first.collections.finds + second.collections.finds).filter { it in knownFinds }.toMutableSet()
        val travelSeconds = add(first.collections.travelSeconds, second.collections.travelSeconds)
        val quarrySeconds = add(first.collections.quarrySeconds, second.collections.quarrySeconds)
        fun remainderFind(ids: List<String>, total: Long, a: Long, b: Long, interval: Long) {
            val newlyClosed = maxOf(0L, total / interval - a / interval - b / interval)
            repeat(minOf(newlyClosed, ids.size.toLong()).toInt()) { ids.firstOrNull { it !in finds }?.let(finds::add) }
        }
        remainderFind(travelFinds, travelSeconds, first.collections.travelSeconds, second.collections.travelSeconds, catalog.travel.secondsPerFind)
        remainderFind(quarryFinds, quarrySeconds, first.collections.quarrySeconds, second.collections.quarrySeconds, catalog.quarry.secondsPerFind)
        return EconomyProgression(counts(first.routes, second.routes), counts(first.recipes, second.recipes),
            EconomyBookCollection(finds.sorted(), travelSeconds, quarrySeconds))
    }
}
