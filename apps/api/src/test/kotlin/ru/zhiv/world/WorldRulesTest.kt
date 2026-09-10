package ru.zhiv.world

import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertFailsWith
import ru.zhiv.auth.AuthFailure

class WorldRulesTest {
    private val now = Instant.parse("2026-09-08T12:00:00Z")
    private fun command(action: String) = WorldCommand(UUID.randomUUID().toString(), "OWNER", 0, action)

    @Test
    fun `new houses stop at two without charging again and preserve legacy higher levels`() {
        val initial = WorldState(resources = WorldResources(300, 200, 100))
        val state = WorldRules.apply(initial, command("upgrade_house"), now).first
        assertEquals(2, state.houseLevel)
        assertEquals(WorldResources(290, 194, 98), state.resources)
        assertEquals("WORLD_MAX_LEVEL", assertFailsWith<AuthFailure> {
            WorldRules.apply(state, command("upgrade_house"), now)
        }.code)
        assertEquals(WorldResources(290, 194, 98), state.resources)
        for (level in 3..5) {
            val legacy = state.copy(houseLevel = level)
            assertEquals("WORLD_MAX_LEVEL", assertFailsWith<AuthFailure> {
                WorldRules.apply(legacy, command("upgrade_house"), now)
            }.code)
            assertEquals(legacy.copy(inventory = legacy.inventory.sorted()), WorldRules.merge(legacy, WorldState()))
        }
    }

    @Test
    fun `workshop upgrades preserve legacy ownership and stop at three`() {
        var state = WorldState(workshop=true,resources=WorldResources(200,200,200))
        state = WorldRules.apply(state,command("upgrade_workshop"),now).first
        assertEquals(2,state.workshopLevel)
        state = WorldRules.apply(state,command("upgrade_workshop"),now).first
        assertEquals(3,state.workshopLevel)
        assertEquals(WorldResources(95,140,165),state.resources)
        assertEquals("WORLD_MAX_LEVEL",assertFailsWith<AuthFailure> { WorldRules.apply(state,command("upgrade_workshop"),now) }.code)
        assertEquals("WORLD_WORKSHOP_REQUIRED",assertFailsWith<AuthFailure> { WorldRules.apply(WorldState(),command("upgrade_workshop"),now) }.code)
        assertEquals(3,WorldRules.merge(WorldState(),state).workshopLevel)
        assertEquals(1,WorldRules.merge(WorldState(),WorldState(workshop=true)).workshopLevel)
    }

    @Test
    fun `production rules never grant development resources`() {
        assertEquals("INVALID_WORLD_COMMAND", assertFailsWith<AuthFailure> {
            WorldRules.apply(WorldState(), command("dev_grant_resources"), now)
        }.code)
    }
    @Test
    fun `fishing claim becomes valid exactly when the complete outing ends`() {
        for (minutes in listOf(5L, 15L, 30L, 60L)) {
            val before = WorldState(houseLevel = 2)
            val started = WorldRules.apply(before, command("start_journey").copy(target = "fishing_$minutes"), now).first
            val journey = started.journeys.single()
            val finish = now.plusSeconds(minutes * 60)
            val claim = command("claim_journey").copy(target = journey.id)
            assertEquals(finish, Instant.parse(journey.finishesAt))
            assertEquals(before.resources, started.resources)
            assertEquals("WORLD_JOURNEY_NOT_READY", assertFailsWith<AuthFailure> {
                WorldRules.apply(started, claim, finish.minusNanos(1))
            }.code)
            val paid = WorldRules.apply(started, claim, finish).first
            assertEquals(journey.rewards, paid.resources)
            assertEquals(1L, paid.completedJourneys)
            assertEquals(emptyList(), paid.journeys)
            assertEquals("WORLD_JOURNEY_GONE", assertFailsWith<AuthFailure> {
                WorldRules.apply(paid, claim, finish)
            }.code)
        }
    }

    @Test
    fun `all twelve finds are reachable with independent album equipment rewards`() {
        var state = WorldState()
        var time = now
        val schedule = listOf("first_path") + List(3) { "forest_path" } + List(8) { "fishing_5" }
        for ((index, route) in schedule.withIndex()) {
            state = WorldRules.apply(state, command("start_journey").copy(target = route), time).first
            val trip = state.journeys.single()
            time = Instant.parse(trip.finishesAt)
            state = WorldRules.apply(state, command("claim_journey").copy(target = trip.id), time).first
            assertEquals(index + 1, state.collection.size)
            if (index == 0) state = WorldRules.apply(state, command("upgrade_house"), time).first
            if (index == 5) {
                assertTrue("explorer_cap" in state.inventory)
                assertFalse("willow_rod" in state.inventory)
            }
        }
        assertEquals(now.plusSeconds(56 * 60), time)
        assertEquals(WorldRules.catalog.finds.map { it.id }.sorted(), state.collection)
        assertEquals(1, state.inventory.count { it == "explorer_cap" })
        assertEquals(1, state.inventory.count { it == "willow_rod" })
        state = WorldRules.apply(state, command("equip").copy(target = "willow_rod"), time).first
        assertEquals("willow_rod", state.equipment.rod)
        state = WorldRules.apply(state, command("equip").copy(target = "remove_rod"), time).first
        assertNull(state.equipment.rod)
        assertEquals("WORLD_ITEM", assertFailsWith<AuthFailure> {
            WorldRules.apply(state, command("craft").copy(target = "willow_rod"), time)
        }.code)
    }

    @Test
    fun `group rewards exclude unknown ids and merge preserves earned equipment`() {
        val forest = WorldRules.catalog.finds.filter { it.group == "forest" }.map { it.id }
        val fishing = WorldRules.catalog.finds.filter { it.group == "fishing" }.map { it.id }
        assertEquals(6, forest.size); assertEquals(6, fishing.size)
        assertEquals(listOf("explorer_cap"), WorldRules.collectionRewards(forest + forest))
        assertEquals(listOf("willow_rod"), WorldRules.collectionRewards(fishing))
        assertEquals(emptyList(), WorldRules.collectionRewards(forest.drop(1) + fishing.drop(1) + List(12) { "unknown" }))
        val merged = WorldRules.merge(WorldState(collection = forest, houseLevel = 5), WorldState(collection = fishing))
        assertEquals(5, merged.houseLevel)
        assertEquals(12, merged.collection.size)
        assertEquals(1, merged.inventory.count { it == "explorer_cap" })
        assertEquals(1, merged.inventory.count { it == "willow_rod" })
    }

    @Test
    fun `longer forest and fishing modes retain reward rates and access to finds`() {
        val families = listOf(
            WorldRules.catalog.routes.filter { it.id == "forest_path" || it.id == "forest_10" },
            WorldRules.catalog.routes.filter { it.id.startsWith("fishing_") },
        )
        assertEquals(listOf(300L, 600L), families[0].map { it.seconds })
        assertEquals(listOf(300L, 900L, 1800L, 3600L), families[1].map { it.seconds })
        for (family in families) {
            val first = family.first()
            for (route in family) {
                assertEquals(first.sparks * route.seconds, route.sparks * first.seconds)
                assertEquals(first.wood * route.seconds, route.wood * first.seconds)
                assertEquals(first.stone * route.seconds, route.stone * first.seconds)
                assertEquals(first.finds, route.finds)
            }
        }
    }

    @Test
    fun `saved catalog two fishing trip keeps its original rewards and duration`() {
        val trip = WorldJourney(UUID.randomUUID().toString(), "fishing_15", now.toString(), now.plusSeconds(900).toString(),
            WorldResources(9, 5, 5), listOf("river_stone", "moon_moth"), false, 2)
        val saved = WorldState(houseLevel = 5, journeys = listOf(trip), collection = listOf("river_stone"))
        val paid = WorldRules.apply(saved, command("claim_journey").copy(target = trip.id), now.plusSeconds(900)).first
        assertEquals(WorldResources(9, 5, 5), paid.resources)
        assertEquals(listOf("moon_moth", "river_stone"), paid.collection)
        assertEquals(5, paid.houseLevel)
        assertTrue(paid.journeys.isEmpty())
    }

    @Test
    fun `missing introductory acorn remains reachable after completing introduction`() {
        for (route in listOf("forest_path", "forest_10")) {
            val before = WorldState(firstJourneyCompleted = true, collection = listOf("feather", "fern_leaf", "winged_seed"))
            val started = WorldRules.apply(before, command("start_journey").copy(target = route), now).first
            val trip = started.journeys.single()
            val paid = WorldRules.apply(started, command("claim_journey").copy(target = trip.id), Instant.parse(trip.finishesAt)).first
            assertTrue("acorn" in paid.collection)
        }
    }

}
