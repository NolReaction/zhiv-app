package ru.zhiv.world

import java.time.Instant
import java.util.UUID
import kotlin.test.*
import ru.zhiv.auth.AuthFailure

class SettlementRulesTest {
    private val now = Instant.parse("2026-09-09T10:00:00Z")
    private fun command(action: String, target: String = "") = WorldCommand(UUID.randomUUID().toString(), "OWNER", 0, action, target)
    private fun apply(state: SettlementState?, action: String, target: String = "", time: Instant = now) = SettlementRules.apply(state, command(action, target), time).first

    @Test fun `building and upgrading use the shared prices and preserve the home`() {
        val home = WorldState(resources = WorldResources(12, 8, 4), houseLevel = 2)
        val built = WorldRules.apply(home, command("settlement_build", "workshop:2:2"), now).first
        assertEquals(home, built.copy(settlement = null))
        assertEquals(SettlementMaterials(110, 85), built.settlement!!.resources)
        var state = apply(built.settlement, "settlement_build", "storehouse:4:2")
        state = apply(state, "settlement_upgrade", "workshop")
        assertEquals(SettlementMaterials(25, 40), state.resources)
        assertEquals(listOf(2, 1), state.buildings.map { it.level })
        val moved = apply(state, "settlement_move", "workshop:5:5")
        assertEquals(state.resources, moved.resources)
        assertEquals(SettlementBuilding("workshop", 2, 5, 5), moved.buildings[0])
        assertEquals("SETTLEMENT_MAX_LEVEL", assertFailsWith<AuthFailure> { apply(moved, "settlement_upgrade", "workshop") }.code)
        assertEquals("SETTLEMENT_RESOURCES", assertFailsWith<AuthFailure> { apply(moved, "settlement_upgrade", "storehouse") }.code)
    }

    @Test fun `footprints reject overlaps locked rings and malformed targets`() {
        for (target in listOf("workshop:0:0", "workshop:7:7", "house:2:2", "workshop:2.5:2", "workshop:22:2", "workshop:2:2:extra")) {
            assertEquals("SETTLEMENT_PLACEMENT", assertFailsWith<AuthFailure> { apply(null, "settlement_build", target) }.code)
        }
        val built = apply(null, "settlement_build", "workshop:2:2")
        assertEquals("SETTLEMENT_PLACEMENT", assertFailsWith<AuthFailure> { apply(built, "settlement_build", "storehouse:3:3") }.code)
        assertEquals("SETTLEMENT_BUILDING", assertFailsWith<AuthFailure> { apply(built, "settlement_build", "workshop:4:4") }.code)
        val expanded = apply(built, "settlement_expand")
        assertEquals(2, expanded.areaLevel)
        assertEquals(SettlementMaterials(50, 50), expanded.resources)
        assertEquals(built.buildings, expanded.buildings)
        assertTrue(SettlementRules.canPlace(expanded, 1, 1, "workshop"))
        assertFalse(SettlementRules.canPlace(expanded, 0, 0, "workshop"))
    }

    @Test fun `gather snapshots rewards and only server deadline permits collection`() {
        val built = apply(null, "settlement_build", "workshop:2:2")
        val started = apply(built, "settlement_gather")
        val trip = started.gathering!!
        assertEquals(now.plusSeconds(60), Instant.parse(trip.finishesAt))
        assertEquals("SETTLEMENT_GATHERING", assertFailsWith<AuthFailure> { apply(started, "settlement_gather") }.code)
        val upgraded = apply(started, "settlement_upgrade", "workshop")
        assertEquals("SETTLEMENT_NOT_READY", assertFailsWith<AuthFailure> { apply(upgraded, "settlement_claim", trip.id, now.plusMillis(59999)) }.code)
        val collected = apply(upgraded, "settlement_claim", trip.id, now.plusSeconds(60))
        assertEquals(SettlementMaterials(70, 62), collected.resources)
        assertNull(collected.gathering)
        assertEquals("SETTLEMENT_GATHERING_GONE", assertFailsWith<AuthFailure> { apply(collected, "settlement_claim", trip.id) }.code)
        assertEquals(SettlementMaterials(30, 18), apply(collected, "settlement_gather").gathering!!.rewards)
    }

    @Test fun `storage caps stock and each level increases capacity`() {
        val almostFull = SettlementRules.initial().copy(resources = SettlementMaterials(195, 197))
        val started = apply(almostFull, "settlement_gather")
        val full = apply(started, "settlement_claim", started.gathering!!.id, now.plusSeconds(60))
        assertEquals(SettlementMaterials(200, 200), full.resources)
        assertEquals("SETTLEMENT_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(full, "settlement_gather") }.code)
        val built = apply(full, "settlement_build", "storehouse:2:2")
        assertEquals(400L, SettlementRules.capacity(built))
        val upgraded = apply(built, "settlement_upgrade", "storehouse")
        assertEquals(800L, SettlementRules.capacity(upgraded))
        assertEquals(SettlementMaterials(125, 165), upgraded.resources)
        assertEquals("SETTLEMENT_MAX_LEVEL", assertFailsWith<AuthFailure> { apply(upgraded.copy(areaLevel = 3), "settlement_expand") }.code)
    }

    @Test fun `legacy JSON stays compatible and merging one settlement preserves its whole save`() {
        assertNull(worldJson.decodeFromString<WorldState>("{}").settlement)
        val populated = WorldState(settlement = apply(null, "settlement_build", "workshop:2:2"))
        assertEquals(populated, worldJson.decodeFromString<WorldState>(worldJson.encodeToString(WorldState.serializer(), populated)))
        assertEquals(populated.settlement, WorldRules.merge(WorldState(), populated).settlement)
        assertEquals(populated.settlement, WorldRules.merge(populated, WorldState()).settlement)
        assertEquals("SETTLEMENT_MERGE_CONFLICT", assertFailsWith<AuthFailure> { WorldRules.merge(populated, populated) }.code)
    }
}
