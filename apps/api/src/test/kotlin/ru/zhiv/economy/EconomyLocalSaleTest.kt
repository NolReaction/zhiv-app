package ru.zhiv.economy

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyLocalSaleTest {
    private val now = Instant.parse("2026-10-05T00:00:00Z")
    private fun command(action: String, target: String, quantity: Long = 1, minimum: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity, minimum)

    @Test fun `old catalogs default to full payout while current catalog has one explicit discount`() {
        val json=economyJson.encodeToJsonElement(EconomyRules.catalog).jsonObject
        val legacy=economyJson.decodeFromJsonElement<EconomyCatalog>(JsonObject(json-"localBuyer"))
        assertEquals(10_000,legacy.localBuyer.payoutBps)
        assertEquals(6000,EconomyRules.catalog.localBuyer.payoutBps)
        assertEquals(27L,EconomyRules.localSellPrice(3,9,legacy.localBuyer))
        assertEquals(16L,EconomyRules.localSellPrice(3,9))
        assertEquals(1800L,EconomyRules.catalog.fishing!!.rods.single { it.id=="river_rod" }.price)
        assertEquals(7200L,EconomyRules.catalog.fishing!!.rods.single { it.id=="willow_rod" }.price)
    }

    @Test fun `packet rounding cannot earn more by splitting and stays precise near command limits`() {
        for(base in listOf(1L,2L,3L,8L,34L,180L,ECONOMY_MAX_BALANCE)) for(quantity in listOf(1L,2L,3L,7L,9999L,10000L)) {
            val amount=EconomyRules.localSellPrice(base,quantity)
            assertEquals(base*quantity*6000/10000,amount)
            assertTrue(amount>=quantity*EconomyRules.localSellPrice(base))
            for(split in listOf(0L,quantity/2,quantity))
                assertTrue(EconomyRules.localSellPrice(base,split)+EconomyRules.localSellPrice(base,quantity-split)<=amount)
        }
    }

    @Test fun `sale minimum cannot mint coins and specialist fish offers keep their full value`() {
        val state=EconomyRules.initial().copy(inventory=mapOf("berries" to 9L,"fish" to 4L))
        assertEquals("ECONOMY_SALE_PRICE_CHANGED",assertFailsWith<AuthFailure> {
            EconomyRules.apply(state,command("sell","berries",3,6),now)
        }.code)
        val sold=EconomyRules.apply(state,command("sell","berries",3,5),now).first
        assertEquals(5L,sold.wallet.coins)
        assertEquals(6L,sold.inventory["berries"])
        val generic=EconomyRules.apply(sold,command("sell","fish",2),now).first
        assertEquals(14L,generic.wallet.coins)
        val specialist=EconomyRules.apply(generic,command("sell_fish","fish",2),now).first
        assertEquals(30L,specialist.wallet.coins)
        assertTrue(specialist.fishing.catches.isEmpty())
        assertEquals(0L,state.wallet.coins,"the domain input remains unchanged")
    }

    @Test fun `zero proceeds cannot discard goods and exact rounded wallet headroom is accepted`() {
        val state=EconomyRules.initial().copy(inventory=mapOf("crumb_bait" to 2L,"berries" to 4L))
        assertEquals("ECONOMY_SALE_QUANTITY",assertFailsWith<AuthFailure> {
            EconomyRules.apply(state,command("sell","crumb_bait"),now)
        }.code)
        assertEquals(1L,EconomyRules.apply(state,command("sell","crumb_bait",2,1),now).first.wallet.coins)
        val full=state.copy(wallet=EconomyWallet(ECONOMY_MAX_BALANCE-5))
        assertEquals("ECONOMY_CAPACITY",assertFailsWith<AuthFailure> {
            EconomyRules.apply(full,command("sell","berries",4),now)
        }.code)
        assertEquals(ECONOMY_MAX_BALANCE,EconomyRules.apply(full,command("sell","berries",3,5),now).first.wallet.coins)
    }

    @Test fun `smoking retains a positive sale margin without nerfing specialist raw fish`() {
        val smoked=EconomyRules.catalog.items.single { it.id=="smoked_fish" }
        assertEquals(34L,smoked.baseSellPrice)
        assertEquals(20L,EconomyRules.localSellPrice(smoked.baseSellPrice))
        assertTrue(EconomyRules.localSellPrice(smoked.baseSellPrice)>16+EconomyRules.localSellPrice(4))
    }
}
