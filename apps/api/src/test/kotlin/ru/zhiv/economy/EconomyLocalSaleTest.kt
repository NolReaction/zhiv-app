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
        // Older catalogs omit the discount; prices are projected to current coin units before quoting.
        val nominalBase = EconomyMoney.nominal(3)
        assertEquals(270L,EconomyRules.localSellPrice(nominalBase,9,legacy.localBuyer))
        assertEquals(160L,EconomyRules.localSellPrice(nominalBase,9))
        assertEquals(18000L,EconomyRules.catalog.fishing!!.rods.single { it.id=="river_rod" }.price)
        assertEquals(72000L,EconomyRules.catalog.fishing!!.rods.single { it.id=="willow_rod" }.price)
    }

    @Test fun `packet rounding cannot earn more by splitting and stays precise near command limits`() {
        for(base in listOf(10L,20L,30L,80L,340L,1800L,ECONOMY_MAX_BALANCE)) for(quantity in listOf(1L,2L,3L,7L,9999L,10000L)) {
            val amount=EconomyRules.localSellPrice(base,quantity)
            // Floor in old coin units, then redenominate: x10 must not change earning rates.
            assertEquals((base/10*quantity*6000/10000)*10,amount)
            assertTrue(amount>=quantity*EconomyRules.localSellPrice(base))
            for(split in listOf(0L,quantity/2,quantity))
                assertTrue(EconomyRules.localSellPrice(base,split)+EconomyRules.localSellPrice(base,quantity-split)<=amount)
        }
    }

    @Test fun `sale minimum cannot mint coins and specialist fish offers keep their full value`() {
        val state=EconomyRules.initial().copy(inventory=mapOf("berries" to 9L,"fish" to 4L))
        assertEquals("ECONOMY_SALE_PRICE_CHANGED",assertFailsWith<AuthFailure> {
            EconomyRules.apply(state,command("sell","berries",3,60),now)
        }.code)
        val sold=EconomyRules.apply(state,command("sell","berries",3,50),now).first
        assertEquals(50L,sold.wallet.coins)
        assertEquals(6L,sold.inventory["berries"])
        val generic=EconomyRules.apply(sold,command("sell","fish",2),now).first
        assertEquals(140L,generic.wallet.coins)
        val specialist=EconomyRules.apply(generic,command("sell_fish","fish",2),now).first
        assertEquals(300L,specialist.wallet.coins)
        assertTrue(specialist.fishing.catches.isEmpty())
        assertEquals(0L,state.wallet.coins,"the domain input remains unchanged")
    }

    @Test fun `zero proceeds cannot discard goods and exact rounded wallet headroom is accepted`() {
        val state=EconomyRules.initial().copy(inventory=mapOf("crumb_bait" to 2L,"berries" to 4L))
        assertEquals("ECONOMY_SALE_QUANTITY",assertFailsWith<AuthFailure> {
            EconomyRules.apply(state,command("sell","crumb_bait"),now)
        }.code)
        assertEquals(10L,EconomyRules.apply(state,command("sell","crumb_bait",2,10),now).first.wallet.coins)
        val full=state.copy(wallet=EconomyWallet(ECONOMY_MAX_BALANCE-50))
        assertEquals("ECONOMY_CAPACITY",assertFailsWith<AuthFailure> {
            EconomyRules.apply(full,command("sell","berries",4),now)
        }.code)
        assertEquals(ECONOMY_MAX_BALANCE,EconomyRules.apply(full,command("sell","berries",3,50),now).first.wallet.coins)
    }

    @Test fun `smoking retains a positive sale margin without nerfing specialist raw fish`() {
        val items=EconomyRules.catalog.items.associateBy { it.id }
        val recipe=EconomyRules.catalog.recipes.single { it.id=="smoke_fish" }
        val fishInput=assertNotNull(recipe.fishInput)
        val specialistValue=fishInput.itemIds.maxOf { items.getValue(it).baseSellPrice }
        val inputValue=recipe.cost.coins + recipe.cost.items.entries.sumOf { (id, quantity) ->
            if (id == "fish") specialistValue * quantity
            else EconomyRules.localSellPrice(items.getValue(id).baseSellPrice, quantity)
        }
        val outputValue=recipe.rewards.entries.sumOf { (id, quantity) ->
            EconomyRules.localSellPrice(items.getValue(id).baseSellPrice, quantity)
        }
        assertTrue(outputValue > inputValue,
            "Smoking even the highest-value allowed fish must retain a margin after the local buyer discount")
    }
}
