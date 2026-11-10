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
    // Prior releases persisted complete journeys (including durations, cap and private slots).
    private fun legacyDepart(): EconomyState {
        val departed = depart()
        val boat = checkNotNull(departed.boat)
        val voyage = checkNotNull(boat.voyage)
        return departed.copy(boat = boat.copy(fuel = null, voyage = voyage.copy(
            arrivesAt = now.plusSeconds(300).toString(), fishingUntil = now.plusSeconds(2100).toString(),
            maxCasts = 4, maxCatches = 4, slots = voyage.slots.take(4), outboundSeconds = 300, inboundSeconds = 300)))
    }
    private fun caughtTrace(challenge: EconomyBoatChallenge): EconomyBoatReelSubmission {
        var frame = EconomyBoatReel.Frame(); var held = false
        val inputs = mutableListOf<EconomyBoatReelInput>()
        while (frame.status == "active") {
            val next = frame.bar + frame.velocity * 6 < frame.fish
            if (next != held) { held = next; inputs += EconomyBoatReelInput(frame.tick, held) }
            frame = EconomyBoatReel.step(frame, held, challenge)
        }
        assertEquals("caught", frame.status)
        return EconomyBoatReelSubmission(challenge.id, inputs, frame.tick)
    }
    private fun ready(castsUsed: Int = 4): EconomyState {
        val state = legacyDepart(); val b = state.boat!!; val v = b.voyage!!
        return state.copy(boat = b.copy(voyage = v.copy(castsUsed = castsUsed,
            catches = listOf(EconomyBoatCatch(0, "fish_silverfin", 500, now.plusSeconds(320).toString())))))
    }
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `a missed hook clears only that cast after the bite window`() {
        val original = depart()
        val id = original.boat!!.voyage!!.id
        val issued = call(original, "begin_boat_cast", id)
        val voyage = issued.boat!!.voyage!!
        val challenge = voyage.challenge!!
        val missed = EconomyBoatReelSubmission(challenge.id, emptyList(), 0, missedBite = true)
        val deadline = Instant.parse(challenge.biteAt).plusMillis(3200)
        failure("ECONOMY_BOAT_TRACE") { call(issued, "submit_boat_cast", id, deadline.minusMillis(1), missed) }
        val settled = call(issued, "submit_boat_cast", id, deadline, missed)
        assertEquals(voyage.copy(challenge = null), settled.boat!!.voyage)
        failure("ECONOMY_BOAT_CAST_GONE") { call(settled, "submit_boat_cast", id, deadline, missed) }
    }

    @Test fun `dock sale exchanges saved catch for the confirmed weight quote and keeps records without adding stock`() {
        val loaded = ready()
        val v = loaded.boat!!.voyage!!
        val id = "fish_silverfin"
        val range = config.weights.getValue(id)
        val catches = listOf(range.minGrams, range.maxGrams).mapIndexed { index, grams ->
            EconomyBoatCatch(index, id, grams, now.toString())
        }
        val state = loaded.copy(boat = loaded.boat!!.copy(voyage = v.copy(catches = catches)))
        val base = EconomyRules.catalog.items.single { it.id == "fish_common" }.baseSellPrice
        val bonus = base * checkNotNull(config.dockSaleBonusPercent) / 100
        assertTrue(bonus > 0)
        val total = 2 * base + bonus
        val sale = command("sell_boat_catch", v.id).copy(totalPrice = total)
        val time = Instant.parse(v.fishingUntil).plusSeconds(v.inboundSeconds)
        failure("ECONOMY_BOAT_PHASE") { EconomyRules.apply(state, sale, now) }
        failure("ECONOMY_BOAT_SALE_PRICE") { EconomyRules.apply(state, sale.copy(totalPrice = total - 1), time) }
        failure("ECONOMY_CAPACITY") { EconomyRules.apply(state.copy(wallet = state.wallet.copy(coins = ECONOMY_MAX_BALANCE)), sale, time) }
        val sold = EconomyRules.apply(state, sale, time).first
        assertEquals(state.wallet.coins + total, sold.wallet.coins); assertEquals(state.inventory, sold.inventory)
        assertEquals(state.fishing.stock, sold.fishing.stock); assertEquals(2L, sold.fishing.catches[id])
        assertEquals(range.maxGrams, sold.boat!!.records.getValue(id).weightGrams)
        assertNull(sold.boat!!.voyage)
        failure("ECONOMY_BOAT_VOYAGE_GONE") { EconomyRules.apply(sold, sale, time) }
        failure("ECONOMY_BOAT_VOYAGE_GONE") { call(sold, "claim_boat", v.id, time) }
    }

    @Test fun `starter repair is free even during construction and a legacy paid repair keeps its saved terms`() {
        val job = EconomyJob(UUID.randomUUID().toString(), "construction", "woodlot", targetLevel = 1,
            startedAt = now.toString(), finishesAt = now.plusSeconds(300).toString())
        val state = EconomyRules.initial().copy(buildings = mapOf("home" to 1), jobs = listOf(job),
            wallet = EconomyWallet(0, 0), inventory = emptyMap())
        val repaired = call(state, "start_boat_upgrade", "repair")
        assertEquals(state.wallet, repaired.wallet); assertEquals(state.inventory, repaired.inventory)
        assertEquals(state.jobs, repaired.jobs); assertNull(repaired.boat!!.work)
        assertEquals(1, repaired.boat!!.level); assertEquals(1, EconomyBoatWorkshop.modules(repaired.boat!!).hull)
        failure("ECONOMY_BOAT_UPGRADE") { call(repaired, "start_boat_upgrade", "repair") }
        failure("ECONOMY_BOAT_UPGRADE") { call(repaired, "start_boat_upgrade", "tank_1") }
        val work = EconomyBoatWork(UUID.randomUUID().toString(), "repair", now.toString(), now.plusSeconds(900).toString(),
            EconomyCost(400, mapOf("planks" to 4L, "rope" to 2L)))
        val old = state.copy(jobs = emptyList(), boat = EconomyBoatState(work = work))
        failure("ECONOMY_BOAT_UPGRADE") { call(old, "start_boat_upgrade", "repair") }
        failure("ECONOMY_BOAT_WORK_WAIT") { call(old, "claim_boat_upgrade", work.id, now.plusSeconds(899)) }
        val delivered = call(old, "claim_boat_upgrade", work.id, now.plusSeconds(900))
        assertEquals(1, delivered.boat!!.level); assertNull(delivered.boat!!.work)
        assertEquals(old.wallet, delivered.wallet); assertEquals(old.inventory, delivered.inventory)
        failure("ECONOMY_BOAT_WORK_GONE") { call(delivered, "claim_boat_upgrade", work.id, now.plusSeconds(901)) }
    }

    @Test fun `a legacy complete blueprint remains installable in the coin workshop`() {
        val repaired = call(EconomyRules.initial(), "start_boat_upgrade", "repair")
        failure("ECONOMY_BOAT_UPGRADE") { call(repaired, "start_boat_upgrade", "landing_net") }
        val withPages = funded().copy(boat = repaired.boat!!.copy(blueprints = EconomyBoatBlueprints(3, 0)))
        val paid = call(withPages, "start_boat_upgrade", "landing_net")
        val saved = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(paid))
        val artifactWork = saved.boat!!.work!!
        assertEquals("landing_net", artifactWork.upgradeId)
        val installed = call(saved, "claim_boat_upgrade", artifactWork.id, Instant.parse(artifactWork.finishesAt))
        assertEquals(listOf("landing_net"), installed.boat!!.artifacts)
        assertEquals(saved.boat!!.blueprints, installed.boat!!.blueprints)
        assertEquals(saved.wallet, installed.wallet); assertEquals(saved.inventory, installed.inventory)
        assertNull(installed.boat!!.work)
        failure("ECONOMY_BOAT_WORK_GONE") { call(installed, "claim_boat_upgrade", artifactWork.id, Instant.parse(artifactWork.finishesAt)) }
    }

    @Test fun `departure freezes loadout slots and timing spends one bait and ignores meals and skill speed`() {
        val bait = EconomyRules.catalog.fishing!!.baits.first { EconomyRules.fishingBaitCompatible("reed_rod", it.itemId) }.itemId
        val state = funded().copy(boat = EconomyBoatState(level = 1, upgrades = listOf("crate", "oars"), artifacts = listOf("landing_net")),
            inventory = mapOf(bait to 3L), food = EconomyFoodState(heroMeal = "grilled_fish"),
            progression = EconomyProgression(skills = EconomyCraftSkills(fishingSeconds = 31_536_000, travelSeconds = 31_536_000)),
            fishing = EconomyFishing(equippedBaitId = bait))
        val started = depart(state); val v = started.boat!!.voyage!!
        assertEquals(2L, started.inventory[bait]); assertEquals(7, v.maxCasts); assertEquals(5, v.maxCatches); assertEquals(7, v.slots.size)
        assertEquals(0L, v.outboundSeconds); assertEquals(0L, v.inboundSeconds)
        assertEquals(now, Instant.parse(v.arrivesAt)); assertEquals(state.food, started.food)
        assertEquals(setOf(4000), v.slots.map { it.zoneWidth }.toSet())
        val serialized = economyJson.encodeToString(started)
        assertEquals(started, economyJson.decodeFromString<EconomyState>(serialized))
        assertEquals(v, started.copy(fishing = EconomyFishing()).boat!!.voyage)
        failure("ECONOMY_BOAT_DEPARTURE") { call(started, "depart_boat", config.routeId) }
        failure("ECONOMY_BOAT_BUSY") { call(started, "start_fishing", "shore") }
        failure("ECONOMY_BOAT_BUSY") { call(started.copy(inventory = mapOf("grilled_fish" to 1)), "eat_food", "grilled_fish") }
    }

    @Test fun `read only phases use saved times and explicit return cannot skip the inbound journey`() {
        val state = legacyDepart(); val b = state.boat!!; val v = b.voyage!!
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
        val first = call(state, "begin_boat_cast", v.id)
        val challenge = first.boat!!.voyage!!.challenge!!
        assertEquals(1, first.boat!!.voyage!!.castsUsed)
        assertEquals(0L, challenge.seed)
        failure("ECONOMY_BOAT_CAST_ACTIVE") { call(first, "begin_boat_cast", v.id, now.plusSeconds(119)) }
        val second = call(first, "begin_boat_cast", v.id, now.plusSeconds(120))
        assertEquals(2, second.boat!!.voyage!!.castsUsed)
        assertEquals(1L, second.boat!!.voyage!!.challenge!!.seed)
        assertEquals(v.slots, second.boat!!.voyage!!.slots)
        failure("ECONOMY_BOAT_CAST_GONE") { call(second, "submit_boat_cast", v.id, now.plusSeconds(121), caughtTrace(challenge)) }
    }

    @Test fun `submitted replay needs elapsed time terminal controls and the current challenge`() {
        val started = depart(); val id = started.boat!!.voyage!!.id
        val state = call(started, "begin_boat_cast", id, now.plusSeconds(300))
        val challenge = state.boat!!.voyage!!.challenge!!; val reel = caughtTrace(challenge)
        failure("ECONOMY_BOAT_TRACE") { call(state, "submit_boat_cast", id, now.plusSeconds(301), reel) }
        failure("ECONOMY_BOAT_TRACE") { call(state, "submit_boat_cast", id, now.plusSeconds(312), reel.copy(inputs = emptyList(), endTick = 1)) }
        failure("ECONOMY_BOAT_CAST_EXPIRED") { call(state, "submit_boat_cast", id, now.plusSeconds(420), reel) }
        val caught = call(state, "submit_boat_cast", id, Instant.parse(challenge.biteAt).plusMillis(reel.endTick * 50L), reel)
        assertEquals(listOf("fish_silverfin"), caught.boat!!.voyage!!.catches.map { it.fishId })
        assertEquals(500, caught.boat!!.voyage!!.catches.single().weightGrams)
        assertFalse("fish_common" in caught.inventory, "Cargo is not yet in the warehouse")
        assertNull(caught.boat!!.voyage!!.challenge)
        failure("ECONOMY_BOAT_CAST_GONE") { call(caught, "submit_boat_cast", id, now.plusSeconds(320), reel) }
    }

    @Test fun `deferred terminal trace reconciles only the still pending cast within a day`() {
        val issued = depart(); val voyage = issued.boat!!.voyage!!
        val fishing = call(issued, "begin_boat_cast", voyage.id)
        val challenge = fishing.boat!!.voyage!!.challenge!!
        val legacyTrace = caughtTrace(challenge)
        assertFalse("deferred" in economyJson.encodeToString(legacyTrace))
        val trace = legacyTrace.copy(deferred = true)
        val deadline = Instant.parse(challenge.expiresAt)
        val late = deadline.plusSeconds(86_400)
        failure("ECONOMY_BOAT_CAST_EXPIRED") { call(fishing, "submit_boat_cast", voyage.id, late, legacyTrace) }
        failure("ECONOMY_BOAT_CAST_EXPIRED") { call(fishing, "submit_boat_cast", voyage.id, late.plusMillis(1), trace) }
        val replayed = call(fishing, "submit_boat_cast", voyage.id, late, trace)
        val fish = replayed.boat!!.voyage!!.catches.single()
        assertEquals(deadline, Instant.parse(fish.caughtAt))
        assertEquals(trace.endTick * 50 / 1000, fish.reelSeconds)
        failure("ECONOMY_BOAT_CAST_GONE") { call(replayed, "submit_boat_cast", voyage.id, late, trace) }
        val claimed = call(replayed, "claim_boat", voyage.id, late)
        assertEquals(1L, claimed.inventory["fish_common"])
        assertEquals(fish.reelSeconds!!.toLong(), claimed.progression.skills!!.fishingSeconds)

        val second = call(fishing, "begin_boat_cast", voyage.id, deadline)
        failure("ECONOMY_BOAT_CAST_GONE") { call(second, "submit_boat_cast", voyage.id, late, trace) }
        val c = challenge.copy(expiresAt = Instant.parse(challenge.biteAt).plusMillis(50).toString())
        val boat = fishing.boat!!
        val short = fishing.copy(boat = boat.copy(voyage = boat.voyage!!.copy(challenge = c)))
        failure("ECONOMY_BOAT_CAST_EXPIRED") { call(short, "submit_boat_cast", voyage.id, late.minusSeconds(1000), trace) }
    }

    @Test fun `cast waits before replay and exposes only current rarity with legacy fallback`() {
        val departed = depart(); val v = departed.boat!!.voyage!!
        val started = now.plusSeconds(300)
        val state = call(departed, "begin_boat_cast", v.id, started)
        val challenge = state.boat!!.voyage!!.challenge!!
        val bite = Instant.parse(challenge.biteAt)
        assertEquals(started.plusSeconds(4), bite)
        assertEquals("common", challenge.fishRarity)
        assertEquals(6, challenge.rulesVersion); assertEquals("steady", challenge.resistance)
        val public = economyJson.encodeToString(EconomyBoats.publicView(state.boat))
        assertTrue("biteAt" in public); assertTrue("fishRarity" in public)
        assertFalse("fishId" in public); assertFalse("weightGrams" in public); assertFalse("slots" in public)
        val reel = caughtTrace(challenge); val finished = bite.plusMillis(reel.endTick * 50L)
        failure("ECONOMY_BOAT_TRACE") { call(state, "submit_boat_cast", v.id, finished.minusMillis(1), reel) }
        assertEquals(1, call(state, "submit_boat_cast", v.id, finished, reel).boat!!.voyage!!.catches.size)
        val old = challenge.copy(rulesVersion = 1, resistance = null, biteAt = null, fishRarity = null, motorResponse = null, hullDamping = null)
        val oldReel = caughtTrace(old)
        val legacy = state.copy(boat = state.boat!!.copy(voyage = state.boat!!.voyage!!.copy(challenge = old)))
        assertEquals(1, call(legacy, "submit_boat_cast", v.id, started.plusMillis(oldReel.endTick * 50L), oldReel).boat!!.voyage!!.catches.size)
        failure("ECONOMY_BOAT_CAST_WAIT") { call(departed, "begin_boat_cast", v.id, Instant.parse(v.fishingUntil).minusSeconds(1)) }
        failure("ECONOMY_BOAT_CAST_WAIT") { call(departed, "begin_boat_cast", v.id, Instant.parse(v.fishingUntil).minusMillis(4050)) }
        assertFailsWith<IllegalArgumentException> { challenge.copy(biteAt = challenge.expiresAt) }
        assertFailsWith<IllegalArgumentException> { challenge.copy(fishRarity = "invented") }
        assertFailsWith<IllegalArgumentException> { challenge.copy(resistance = null) }
        assertFailsWith<IllegalArgumentException> { challenge.copy(resistance = "invented") }
    }

    @Test fun `claim delivers exact stock records progress and bounded practice without new blueprint pages`() {
        val state = ready(); val v = state.boat!!.voyage!!
        val claimed = call(state, "claim_boat", v.id, now.plusSeconds(2400))
        assertEquals(1L, claimed.inventory["fish_common"])
        assertEquals(1L, claimed.fishing.stock!!["fish_silverfin"])
        assertEquals(1L, claimed.fishing.catches["fish_silverfin"])
        assertTrue(claimed.familiarItems.orEmpty().containsAll(listOf("fish_common", "fish_silverfin")))
        assertEquals(500, claimed.boat!!.records.getValue("fish_silverfin").weightGrams)
        assertEquals(1L, claimed.boat!!.completedVoyages); assertEquals(1L, claimed.boat!!.qualifiedVoyages)
        assertEquals(EconomyBoatBlueprints(), claimed.boat!!.blueprints)
        assertEquals(150L, claimed.progression.skills!!.fishingSeconds)
        assertEquals(0L, claimed.progression.skills!!.travelSeconds)
        assertEquals(1L, claimed.progression.routes[config.routeId])
        failure("ECONOMY_BOAT_VOYAGE_GONE") { call(claimed, "claim_boat", v.id, now.plusSeconds(2401)) }
    }

    @Test fun `qualifying voyages crossing legacy thresholds preserve earned pages and permanent items`() {
        for (qualified in listOf(0L, 2L, 4L, 7L, 10L, 13L, 15L)) {
            val pages = EconomyBoatBlueprints(2, 1)
            val artifacts = listOf("landing_net", "telescope")
            val state = ready().let { it.copy(boat = it.boat!!.copy(completedVoyages = qualified, qualifiedVoyages = qualified,
                blueprints = pages, artifacts = artifacts)) }
            val claimed = call(state, "claim_boat", state.boat!!.voyage!!.id, now.plusSeconds(2400))
            assertEquals(qualified + 1, claimed.boat!!.qualifiedVoyages)
            assertEquals(qualified + 1, claimed.boat!!.completedVoyages)
            assertEquals(pages, claimed.boat!!.blueprints)
            assertEquals(artifacts, claimed.boat!!.artifacts)
        }
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
