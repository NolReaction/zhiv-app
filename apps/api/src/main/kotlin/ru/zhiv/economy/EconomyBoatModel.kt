package ru.zhiv.economy

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import ru.zhiv.http.parseCanonicalUuidV4
import java.time.Instant

internal val boatUpgradeIds = setOf("repair", "crate", "oars", "landing_net", "telescope")
internal val boatArtifactIds = setOf("landing_net", "telescope")
private fun boatUuid(value: String) = require(parseCanonicalUuidV4(value) != null)
private fun boatItemId(value: String) = require(value.length in 1..80)
private fun boatCost(value: EconomyCost) = require(value.coins in 0L..1_000_000_000L && value.items.all { (id, count) -> id.length in 1..80 && count in 0L..1_000_000L })

@Serializable data class EconomyBoatBlueprints(val landing_net: Int = 0, val telescope: Int = 0) {
    init { require(landing_net in 0..3 && telescope in 0..3) }
    fun pages(id: String): Int = if (id == "landing_net") landing_net else telescope
}
@Serializable data class EconomyBoatRecord(val weightGrams: Int, val caughtAt: String) {
    init { require(weightGrams in 1..1_000_000); Instant.parse(caughtAt) }
}
@Serializable data class EconomyBoatCatch(val castIndex: Int, val fishId: String, val weightGrams: Int, val caughtAt: String) {
    init { require(castIndex in 0..9 && weightGrams in 1..1_000_000); boatItemId(fishId); Instant.parse(caughtAt) }
}
@Serializable data class EconomyBoatLoadout(val rodId: String, val hookId: String, val baitId: String?) {
    init { boatItemId(rodId); boatItemId(hookId); baitId?.let(::boatItemId) }
}
@Serializable data class EconomyBoatWork(val id: String, val upgradeId: String, val startedAt: String, val finishesAt: String, val cost: EconomyCost) {
    init { boatUuid(id); require(upgradeId in boatUpgradeIds); boatCost(cost); require(Instant.parse(finishesAt).isAfter(Instant.parse(startedAt))) }
}
@Serializable data class EconomyBoatChallenge(val id: String, val rulesVersion: Int = 1, val seed: Long,
    val tickMs: Int = 50, val maxTicks: Int = 600, val zoneWidth: Int, val difficulty: Int, val startedAt: String, val expiresAt: String) {
    init {
        boatUuid(id); require(rulesVersion == 1 && seed in 0L..0xffff_ffffL && tickMs == 50 && maxTicks == 600)
        require(zoneWidth in setOf(3200, 4000) && difficulty in 1..5 && Instant.parse(expiresAt).isAfter(Instant.parse(startedAt)))
    }
}
@Serializable data class EconomyBoatSlot(val fishId: String, val weightGrams: Int, val challengeSeed: Long, val difficulty: Int, val zoneWidth: Int) {
    init { boatItemId(fishId); require(weightGrams in 1..1_000_000 && challengeSeed in 0L..0xffff_ffffL && difficulty in 1..5 && zoneWidth in setOf(3200,4000)) }
}

/** Stored voyage contains the fixed private draw. Never serialize it as a public view. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyBoatVoyage(
    val id: String, val routeId: String, val departedAt: String, val arrivesAt: String, val fishingUntil: String,
    val maxCasts: Int, val maxCatches: Int, val castsUsed: Int = 0, val catches: List<EconomyBoatCatch> = emptyList(),
    val loadout: EconomyBoatLoadout, val outboundSeconds: Long, val inboundSeconds: Long, val slots: List<EconomyBoatSlot>,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val returnStartedAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val returnsAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val challenge: EconomyBoatChallenge? = null,
) {
    init {
        boatUuid(id); boatItemId(routeId)
        require(maxCasts in 1..10 && maxCatches in 1..10 && castsUsed in 0..maxCasts && catches.size <= minOf(maxCatches, castsUsed) && slots.size == maxCasts)
        require(catches.map { it.castIndex }.distinct().size == catches.size && catches.all { it.castIndex < castsUsed })
        require(outboundSeconds in 1L..3600L && inboundSeconds in 1L..3600L)
        require(!Instant.parse(arrivesAt).isBefore(Instant.parse(departedAt)) && Instant.parse(fishingUntil).isAfter(Instant.parse(arrivesAt)))
        require((returnStartedAt == null) == (returnsAt == null))
        if (returnStartedAt != null && returnsAt != null) require(Instant.parse(returnsAt).isAfter(Instant.parse(returnStartedAt)))
        require(challenge == null || castsUsed > 0 && returnStartedAt == null)
    }
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyBoatVoyageView(
    val id: String, val routeId: String, val departedAt: String, val arrivesAt: String, val fishingUntil: String,
    val maxCasts: Int, val maxCatches: Int, val castsUsed: Int, val catches: List<EconomyBoatCatch>,
    val loadout: EconomyBoatLoadout, val outboundSeconds: Long, val inboundSeconds: Long,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val returnStartedAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val returnsAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val challenge: EconomyBoatChallenge? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyBoatState(
    val version: Int = 1, val level: Int = 0, val upgrades: List<String> = emptyList(),
    val blueprints: EconomyBoatBlueprints = EconomyBoatBlueprints(), val artifacts: List<String> = emptyList(),
    val completedVoyages: Long = 0, val qualifiedVoyages: Long = 0, val records: Map<String, EconomyBoatRecord> = emptyMap(),
    @EncodeDefault(EncodeDefault.Mode.NEVER) val work: EconomyBoatWork? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val voyage: EconomyBoatVoyage? = null,
) {
    init {
        require(version == 1 && level in 0..1 && upgrades.distinct().size == upgrades.size && upgrades.all { it in setOf("crate", "oars") })
        require(artifacts.distinct().size == artifacts.size && artifacts.all { it in boatArtifactIds })
        require(completedVoyages in 0L..1_000_000_000L && qualifiedVoyages in 0L..completedVoyages && records.keys.all { it.length in 1..80 })
        require(work == null || voyage == null)
    }
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyBoatView(
    val version: Int = 1, val level: Int = 0, val upgrades: List<String> = emptyList(),
    val blueprints: EconomyBoatBlueprints = EconomyBoatBlueprints(), val artifacts: List<String> = emptyList(),
    val completedVoyages: Long = 0, val qualifiedVoyages: Long = 0, val records: Map<String, EconomyBoatRecord> = emptyMap(),
    @EncodeDefault(EncodeDefault.Mode.NEVER) val work: EconomyBoatWork? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val voyage: EconomyBoatVoyageView? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyBoatUpgrade(val id: String, val name: String, val description: String, val cost: EconomyCost,
    val seconds: Long, val requiredHomeLevel: Int, val requiredBuildings: Map<String, Int>,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val blueprint: String? = null) {
    init { require(id in boatUpgradeIds && seconds in 1L..86400L && requiredHomeLevel in 1..5 && requiredBuildings.values.all { it in 1..100 })
        require(blueprint == null || blueprint in boatArtifactIds); boatCost(cost) }
}
@Serializable data class EconomyBoatBlueprintSpec(val id: String, val name: String, val milestones: List<Int>) {
    init { require(id in boatArtifactIds && milestones.size == 3 && milestones.all { it in 1..100 } && milestones.zipWithNext().all { (a,b) -> a < b }) }
}
@Serializable data class EconomyBoatWeight(val minGrams: Int, val maxGrams: Int) {
    init { require(minGrams in 1..1_000_000 && maxGrams in minGrams + 1..1_000_000) }
}
@Serializable data class EconomyBoatCatalog(val version: Int, val routeId: String, val name: String,
    val outboundSeconds: Long, val inboundSeconds: Long, val maxCasts: Int, val activeSeconds: Long,
    val castExpirySeconds: Long, val zoneWidth: Int, val netZoneWidth: Int, val oarsTravelSeconds: Long,
    val upgrades: List<EconomyBoatUpgrade>, val blueprints: List<EconomyBoatBlueprintSpec>, val weights: Map<String, EconomyBoatWeight>) {
    init {
        require(version == 1 && outboundSeconds in 1L..3600L && inboundSeconds in 1L..3600L && maxCasts in 1..8 && activeSeconds in 120L..3600L)
        require(castExpirySeconds == 120L && zoneWidth == 3200 && netZoneWidth == 4000 && oarsTravelSeconds in 1L..3600L)
        require(upgrades.map { it.id }.toSet() == boatUpgradeIds && upgrades.size == 5 && blueprints.map { it.id }.toSet() == boatArtifactIds && blueprints.size == 2)
    }
}
