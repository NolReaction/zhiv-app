package ru.zhiv.earth

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.db.EarthCommandBudgets
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EarthLocationTest {
    private val owner="0000-0000-0001"
    private val circle=UUID.randomUUID().toString()
    private val sharing=EarthSharingWrite(owner,0,"SHARING","APPROXIMATE",listOf(circle),60)
    private val position=EarthPositionWrite(owner,UUID.randomUUID().toString(),1,55.75555,37.617,7.0,Instant.now().toString())
    @Test fun `consent is explicit bounded and never accepts missing friends or arbitrary durations`() {
        validateEarthSharing(sharing)
        for(bad in listOf(sharing.copy(recipientCircleIds=emptyList()),sharing.copy(recipientCircleIds=listOf(circle,circle)),
            sharing.copy(durationMinutes=1),sharing.copy(mode="PUBLIC"),sharing.copy(precision="CITY"),
            sharing.copy(expectedRevision=-1),sharing.copy(expectedOwnerPublicId="wrong"),
            sharing.copy(recipientCircleIds=List(101) { UUID.randomUUID().toString() }))) {
            assertEquals("INVALID_EARTH_SHARING",assertFailsWith<AuthFailure> { validateEarthSharing(bad) }.code)
        }
        validateEarthSharing(sharing.copy(mode="GHOST",recipientCircleIds=emptyList(),durationMinutes=null))
        validateEarthSharing(sharing.copy(mode="OFF",recipientCircleIds=emptyList(),durationMinutes=null))
    }
    @Test fun `positions reject nonfinite ranges epochs sequences and timestamps`() {
        validateEarthPosition(position)
        for(bad in listOf(position.copy(latitude=Double.NaN),position.copy(longitude=Double.POSITIVE_INFINITY),
            position.copy(latitude=90.001),position.copy(longitude=-180.001),position.copy(accuracyMeters=-1.0),
            position.copy(accuracyMeters=100001.0),position.copy(sequence=0),position.copy(sequence=Long.MAX_VALUE),
            position.copy(publicationEpoch="bad"),position.copy(capturedAt="yesterday"))) {
            assertEquals("INVALID_EARTH_POSITION",assertFailsWith<AuthFailure> { validateEarthPosition(bad) }.code)
        }
        assertEquals(55.76,approximateEarthCoordinate(55.755))
        assertEquals(-55.75,approximateEarthCoordinate(-55.755))
    }
    @Test fun `command quotas cannot let publication or enable exhaustion consume privacy capacity`() {
        var now=0L;val budgets=EarthCommandBudgets { now };val user=UUID.randomUUID()
        repeat(120) { budgets.take(user,"publish");budgets.take(user,"enable") }
        assertEquals(60,assertFailsWith<EarthRateLimited> { budgets.take(user,"publish") }.seconds)
        assertFailsWith<EarthRateLimited> { budgets.take(user,"enable") }
        repeat(600) { budgets.take(user,"privacy") }
        assertFailsWith<EarthRateLimited> { budgets.take(user,"privacy") }
        now=60_000_000_000L
        budgets.take(user,"publish");budgets.take(user,"enable");budgets.take(user,"privacy")
    }
}
