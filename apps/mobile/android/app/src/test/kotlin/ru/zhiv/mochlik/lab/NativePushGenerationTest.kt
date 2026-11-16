package ru.zhiv.mochlik.lab

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativePushGenerationTest {
    private fun bridgeCall(json: String): PluginCall = PluginCall(
        null, "MochlikNative", "test-callback", "registerRemotePush", JSObject(json)
    )

    private fun generation(json: String): Long? =
        NativePushGeneration.parse(bridgeCall(json).data.opt("expectedSessionGeneration"))

    @Test
    fun acceptsSmallIntegersFromTheJavascriptBridge() {
        val call = bridgeCall("""{"expectedSessionGeneration":1}""")
        assertTrue(call.data.opt("expectedSessionGeneration") is Int)
        assertEquals(1L, NativePushGeneration.parse(call.data.opt("expectedSessionGeneration")))
        assertEquals(0L, generation("""{"expectedSessionGeneration":0}"""))
        assertEquals(Int.MAX_VALUE.toLong(), generation("""{"expectedSessionGeneration":2147483647}"""))
    }

    @Test
    fun acceptsLargerExactIntegersWithinTheJavascriptRange() {
        assertEquals(2_147_483_648L, generation("""{"expectedSessionGeneration":2147483648}"""))
        assertEquals(9_007_199_254_740_991L, generation("""{"expectedSessionGeneration":9007199254740991}"""))
    }

    @Test
    fun rejectsMissingCoercedFractionalNegativeAndUnsafeValues() {
        for (json in listOf(
            "{}",
            """{"expectedSessionGeneration":null}""",
            """{"expectedSessionGeneration":"1"}""",
            """{"expectedSessionGeneration":true}""",
            """{"expectedSessionGeneration":1.5}""",
            """{"expectedSessionGeneration":1.0}""",
            """{"expectedSessionGeneration":-1}""",
            """{"expectedSessionGeneration":9007199254740992}""",
            """{"expectedSessionGeneration":9223372036854775807}""",
        )) {
            assertNull(json, generation(json))
        }
        assertNull(NativePushGeneration.parse(Double.NaN))
        assertNull(NativePushGeneration.parse(Double.POSITIVE_INFINITY))
        assertNull(NativePushGeneration.parse(Double.NEGATIVE_INFINITY))
    }
}
