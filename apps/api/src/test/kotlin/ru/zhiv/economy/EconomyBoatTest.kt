package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyBoatTest {
    private val now = Instant.parse("2026-11-02T12:00:00Z")
    private val config get() = checkNotNull(EconomyRules.catalog.boat)
    private fun command(action: String, target: String, reel: EconomyBoatReelSubmission? = null) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, reel = reel)
    private fun funded() = EconomyRules.initial().copy(wallet = EconomyWallet(50_000, 100),
        buildings = EconomyRules.initial().buildings + mapOf("home" to 4, "workshop" to 3, "lighthouse" to 1, "warehouse" to 10),
        inventory = mapOf("planks" to 20L, "rope" to 20L, "hardwood" to 10L, "lens" to 1L, "metal_parts" to 1L))
    private fun call(state: EconomyState, action: String, target: String, at: Instant = now, reel: EconomyBoatReelSubmission? = null) =
        EconomyRules.apply(state, command(action, target, reel), at).first
    private fun depart(state: EconomyState = funded().copy(boat = EconomyBoatState(level = 1))): EconomyState {
        val started = EconomyBoats.command(state, command("depart_boat", config.routeId), now, random = { 0L }).first
        val b = started.boat!!; val v = b.voyage!!
        return started.copy(boat = b.copy(voyage = v.copy(slots = v.slots.mapIndexed { i, slot ->
            slot.copy(fishId = "fish_silverfin", weightGrams = 500 + i, challengeSeed = i.toLong(), difficulty = 1) })))
    }
    private fun caughtTrace(challenge: EconomyBoatChallenge): EconomyBoatReelSubmission {
        var frame = EconomyBoatReel.Frame(); var held = false
        val inputs = mutableListOf<EconomyBoatReelInput>()
        while (frame.status == "active") {
            val next = frame.bar + frame.velocity * 6 < frame.fish
            if (next != held) { held = next; inputs += EconomyBoatReelInput(frame.tick, held) }
            frame = EconomyBoatReel.step(frame, held, challenge.seed, challenge.zoneWidth, challenge.difficulty)
        }
        assertEquals("caught", frame.status)
        return EconomyBoatReelSubmission(challenge.id, inputs, frame.tick)
    }
    private fun ready(castsUsed: Int = 4): EconomyState {
        val state = depart(); val b = state.boat!!; val v = b.voyage!!
        return state.copy(boat = b.copy(voyage = v.copy(castsUsed = castsUsed,
            catches = listOf(EconomyBoatCatch(0, "fish_silverfin", 500, now.plusSeconds(320).toString())))))
    }
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `repair reserves builder pays once and needs an explicit completed work claim`() {
        val state = funded(); val start = call(state, "start_boat_upgrade", "repair")
        val work = start.boat!!.work!!
        assertEquals(state.wallet.coins - 400, start.wallet.coins)
        assertEquals(16L, start.inventory["planks"])
        assertEquals(900L, Instant.parse(work.finishesAt).epochSecond - now.epochSecond)
        failure("ECONOMY_BOAT_WORK_WAIT") { call(start, "claim_boat_upgrade", work.id) }
        failure("ECONOMY_CONSTRUCTION_BUSY") { call(start, "start_construction", "garden") }
        failure("ECONOMY_BOAT_UPGRADE") { call(start, "start_boat_upgrade", "repair") }
        val repaired = call(start, "claim_boat_upgrade", work.id, now.plusSeconds(900))
        assertEquals(1, repaired.boat!!.level); assertNull(repaired.boat!!.work)
        failure("ECONOMY_BOAT_WORK_GONE") { call(repaired, "claim_boat_upgrade", work.id, now.plusSeconds(901)) }
        failure("ECONOMY_BOAT_UPGRADE") { call(repaired, "start_boat_upgrade", "repair") }
        failure("ECONOMY_BOAT_UPGRADE") { call(repaired, "start_boat_upgrade", "landing_net") }
        val withPages = repaired.copy(boat = repaired.boat!!.copy(blueprints = EconomyBoatBlueprints(3, 0)))
        assertEquals("landing_net", call(withPages, "start_boat_upgrade", "landing_net").boat!!.work!!.upgradeId)
    }

    @Test fun `departure freezes loadout slots and timing spends one bait and ignores meals and skill speed`() {
        val bait = EconomyRules.catalog.fishing!!.baits.first { EconomyRules.fishingBaitCompatible("reed_rod", it.itemId) }.itemId
        val state = funded().copy(boat = EconomyBoatState(level = 1, upgrades = listOf("crate", "oars"), artifacts = listOf("landing_net")),
            inventory = mapOf(bait to 3L), food = EconomyFoodState(heroMeal = "grilled_fish"),
            progression = EconomyProgression(skills = EconomyCraftSkills(fishingSeconds = 31_536_000, travelSeconds = 31_536_000)),
            fishing = EconomyFishing(equippedBaitId = bait))
        val started = depart(state); val v = started.boat!!.voyage!!
        assertEquals(2L, started.inventory[bait]); assertEquals(5, v.maxCasts); assertEquals(5, v.slots.size)
        assertEquals(240L, v.outboundSeconds); assertEquals(240L, v.inboundSeconds)
        assertEquals(now.plusSeconds(240), Instant.parse(v.arrivesAt)); assertEquals(state.food, started.food)
        assertEquals(setOf(4000), v.slots.map { it.zoneWidth }.toSet())
        val serialized = economyJson.encodeToString(started)
        assertEquals(started, economyJson.decodeFromString<EconomyState>(serialized))
        assertEquals(v, started.copy(fishing = EconomyFishing()).boat!!.voyage)
        failure("ECONOMY_BOAT_DEPARTURE") { call(started, "depart_boat", config.routeId) }
        failure("ECONOMY_BOAT_BUSY") { call(started, "start_fishing", "shore") }
        failure("ECONOMY_BOAT_BUSY") { call(started.copy(inventory = mapOf("grilled_fish" to 1)), "eat_food", "grilled_fish") }
    }

    @Test fun `read only phases use saved times and explicit return cannot skip the inbound journey`() {
        val state = depart(); val b = state.boat!!; val v = b.voyage!!
        val saved = economyJson.encodeToString(state)
        assertEquals("outbound", EconomyBoats.phase(b, now))
        assertEquals("fishing", EconomyBoats.phase(b, now.plusSeconds(300)))
        assertEquals("returning", EconomyBoats.phase(b, now.plusSeconds(2100)))
        assertEquals("ready", EconomyBoats.phase(b, now.plusSeconds(2400)))
        assertEquals(saved, economyJson.encodeToString(state))
        failure("ECONOMY_BOAT_PHASE") { call(state, "return_boat", v.id) }
        val returned = call(state, "return_boat", v.id, now.plusSeconds(300))
        failure("ECONOMY_BOAT_PHASE") { call(returned, "claim_boat", v.id, now.plusSeconds(599)) }
        assertNull(call(returned, "claim_boat", v.id, now.plusSeconds(600)).boat!!.voyage)
    }

    @Test fun `begin consumes an attempt and expiry moves to the next saved slot without reroll`() {
        val state = depart(); val v = state.boat!!.voyage!!
        failure("ECONOMY_BOAT_PHASE") { call(state, "begin_boat_cast", v.id) }
        val first = call(state, "begin_boat_cast", v.id, now.plusSeconds(300))
        val challenge = first.boat!!.voyage!!.challenge!!
        assertEquals(1, first.boat!!.voyage!!.castsUsed)
        assertEquals(0L, challenge.seed)
        failure("ECONOMY_BOAT_CAST_ACTIVE") { call(first, "begin_boat_cast", v.id, now.plusSeconds(419)) }
        val second = call(first, "begin_boat_cast", v.id, now.plusSeconds(420))
        assertEquals(2, second.boat!!.voyage!!.castsUsed)
        assertEquals(1L, second.boat!!.voyage!!.challenge!!.seed)
        assertEquals(v.slots, second.boat!!.voyage!!.slots)
        failure("ECONOMY_BOAT_CAST_GONE") { call(second, "submit_boat_cast", v.id, now.plusSeconds(421), caughtTrace(challenge)) }
    }

    @Test fun `submitted replay needs elapsed time terminal controls and the current challenge`() {
        val started = depart(); val id = started.boat!!.voyage!!.id
        val state = call(started, "begin_boat_cast", id, now.plusSeconds(300))
        val challenge = state.boat!!.voyage!!.challenge!!; val reel = caughtTrace(challenge)
        failure("ECONOMY_BOAT_TRACE") { call(state, "submit_boat_cast", id, now.plusSeconds(301), reel) }
        failure("ECONOMY_BOAT_TRACE") { call(state, "submit_boat_cast", id, now.plusSeconds(312), reel.copy(inputs = emptyList(), endTick = 1)) }
        failure("ECONOMY_BOAT_CAST_EXPIRED") { call(state, "submit_boat_cast", id, now.plusSeconds(420), reel) }
        val caught = call(state, "submit_boat_cast", id, now.plusSeconds(300).plusMillis(reel.endTick * 50L), reel)
        assertEquals(listOf("fish_silverfin"), caught.boat!!.voyage!!.catches.map { it.fishId })
        assertEquals(500, caught.boat!!.voyage!!.catches.single().weightGrams)
        assertFalse("fish_common" in caught.inventory, "Cargo is not yet in the warehouse")
        assertNull(caught.boat!!.voyage!!.challenge)
        failure("ECONOMY_BOAT_CAST_GONE") { call(caught, "submit_boat_cast", id, now.plusSeconds(320), reel) }
    }

    @Test fun `claim delivers exact stock records progress one blueprint page and bounded practice only once`() {
        val state = ready(); val v = state.boat!!.voyage!!
        val claimed = call(state, "claim_boat", v.id, now.plusSeconds(2400))
        assertEquals(1L, claimed.inventory["fish_common"])
        assertEquals(1L, claimed.fishing.stock!!["fish_silverfin"])
        assertEquals(1L, claimed.fishing.catches["fish_silverfin"])
        assertTrue(claimed.familiarItems.orEmpty().containsAll(listOf("fish_common", "fish_silverfin")))
        assertEquals(500, claimed.boat!!.records.getValue("fish_silverfin").weightGrams)
        assertEquals(1L, claimed.boat!!.completedVoyages); assertEquals(1L, claimed.boat!!.qualifiedVoyages)
        assertEquals(EconomyBoatBlueprints(1, 0), claimed.boat!!.blueprints)
        assertEquals(150L, claimed.progression.skills!!.fishingSeconds)
        assertEquals(0L, claimed.progression.skills!!.travelSeconds)
        assertEquals(1L, claimed.progression.routes[config.routeId])
        failure("ECONOMY_BOAT_VOYAGE_GONE") { call(claimed, "claim_boat", v.id, now.plusSeconds(2401)) }
    }

    @Test fun `full warehouse preserves ready catch while empty or partial trips never manufacture blueprint pages`() {
        val state = ready().let { it.copy(inventory = mapOf("wood" to 50L), buildings = it.buildings + ("warehouse" to 1)) }
        val saved = economyJson.encodeToString(state); val id = state.boat!!.voyage!!.id
        failure("ECONOMY_STORAGE_FULL") { call(state, "claim_boat", id, now.plusSeconds(2400)) }
        assertEquals(saved, economyJson.encodeToString(state))
        assertNotNull(state.boat!!.voyage)
        val partial = ready(1); val partialId = partial.boat!!.voyage!!.id
        assertEquals(0L, call(partial, "claim_boat", partialId, now.plusSeconds(2400)).boat!!.qualifiedVoyages)
        val empty = depart(); val result = call(empty, "claim_boat", empty.boat!!.voyage!!.id, now.plusSeconds(2400))
        assertEquals(0L, result.boat!!.qualifiedVoyages); assertEquals(EconomyBoatBlueprints(), result.boat!!.blueprints)
        assertEquals(0L, result.progression.skills!!.fishingSeconds)
    }

    @Test fun `private draws are omitted from player views and command decoder accepts only bounded control trace`() {
        val state = depart(); val public = economyJson.encodeToString(EconomyBoats.publicView(state.boat))
        assertFalse("slots" in public); assertFalse("challengeSeed" in public); assertFalse("weightGrams" in public)
        val challenge = EconomyBoatChallenge(UUID.randomUUID().toString(), seed = 0, zoneWidth = 3200, difficulty = 1,
            startedAt = now.toString(), expiresAt = now.plusSeconds(120).toString())
        val valid = command("submit_boat_cast", state.boat!!.voyage!!.id, caughtTrace(challenge))
        assertEquals(valid, decodeEconomyCommand(economyJson.encodeToJsonElement(valid)))
        val root = economyJson.encodeToJsonElement(valid).jsonObject
        val rawReel = root.getValue("reel").jsonObject
        failure("INVALID_ECONOMY_COMMAND") { decodeEconomyCommand(JsonObject(root + ("reel" to JsonObject(rawReel + ("win" to JsonPrimitive(true)))))) }
        failure("INVALID_ECONOMY_COMMAND") { validateEconomyCommand(valid.copy(action = "return_boat")) }
        failure("INVALID_ECONOMY_COMMAND") { validateEconomyCommand(valid.copy(quantity = 2)) }
        failure("INVALID_ECONOMY_COMMAND") { validateEconomyCommand(valid.copy(totalPrice = 10)) }
        assertFailsWith<IllegalArgumentException> { valid.reel!!.copy(inputs = listOf(EconomyBoatReelInput(2, true), EconomyBoatReelInput(1, false))) }
    }

    @Test fun `settled account merge keeps highest permanent progress without summing milestones and rejects active cargo`() {
        val a = EconomyBoatState(level = 1, upgrades = listOf("crate"), blueprints = EconomyBoatBlueprints(2, 0),
            completedVoyages = 5, qualifiedVoyages = 3, records = mapOf("fish_silverfin" to EconomyBoatRecord(600, now.toString())))
        val b = EconomyBoatState(level = 1, upgrades = listOf("oars"), blueprints = EconomyBoatBlueprints(1, 1),
            completedVoyages = 9, qualifiedVoyages = 8, records = mapOf("fish_silverfin" to EconomyBoatRecord(500, now.plusSeconds(1).toString())))
        val merged = EconomyBoats.merge(a, b)!!
        assertEquals(9L, merged.completedVoyages); assertEquals(8L, merged.qualifiedVoyages)
        assertEquals(EconomyBoatBlueprints(2, 1), merged.blueprints)
        assertEquals(setOf("crate", "oars"), merged.upgrades.toSet()); assertEquals(600, merged.records.getValue("fish_silverfin").weightGrams)
        val tied = b.copy(records = mapOf("fish_silverfin" to EconomyBoatRecord(600, now.plusMillis(100).toString())))
        assertEquals(now.toString(), EconomyBoats.merge(a, tied)!!.records.getValue("fish_silverfin").caughtAt)
        assertFailsWith<IllegalArgumentException> { EconomyBoats.merge(a, depart().boat) }
        assertEquals(EconomyBoatState(), EconomyRules.initial().boat)
        val old = economyJson.encodeToJsonElement(EconomyRules.initial()).jsonObject - "boat"
        assertNull(economyJson.decodeFromJsonElement<EconomyState>(JsonObject(old)).boat)
        assertEquals(EconomyBoatView(), EconomyBoats.publicView(null))
    }
}
