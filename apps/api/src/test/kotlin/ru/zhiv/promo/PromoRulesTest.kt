package ru.zhiv.promo

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class PromoRulesTest {
    private val now = Instant.parse("2026-10-12T08:00:00Z")
    private val entry = PromoDefinition("test-gift-v1", "TEST-GIFT", true, "Подарок", reward = PromoReward(500, 20, mapOf("wood" to 5)))
    private fun parse(value: PromoDefinition) = PromoRules.parse(promoJson.encodeToString(PromoCatalog(1, listOf(value))))
    @Test fun `catalog keeps disabled sample and validates quantities IDs dates and duplicate campaigns`() {
        assertFalse(PromoRules.catalog.codes.single { it.id == "welcome-example-v1" }.enabled)
        listOf(entry.copy(reward = PromoReward(-1)), entry.copy(reward = PromoReward(pearls = 10_001)), entry.copy(reward = PromoReward()),
            entry.copy(reward = PromoReward(items = mapOf("missing" to 1))), entry.copy(reward = PromoReward(items = mapOf("wood" to 0))),
            entry.copy(code = "lowercase"), entry.copy(startsAt = "bad"), entry.copy(startsAt = now.toString(), endsAt = now.toString()))
            .forEach { assertFails { parse(it) } }
        assertFails { PromoRules.parse(promoJson.encodeToString(PromoCatalog(1, listOf(entry, entry)))) }
    }
    @Test fun `requests normalize code and reject reward injection or invalid identity`() {
        val request = PromoRequest(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, " test-gift ")
        assertEquals("TEST-GIFT", validatePromoRequest(request).code)
        assertFailsWith<AuthFailure> { validatePromoRequest(request.copy(requestId = "bad")) }
        assertFailsWith<AuthFailure> { validatePromoRequest(request.copy(code = "не-код")) }
        assertFails { promoJson.decodeFromString<PromoRequest>(promoJson.encodeToString(request).dropLast(1) + ",\"coins\":999}") }
    }
    @Test fun `visible gifts use exact coin amount two stored units per pearl and warehouse limits`() {
        val before = EconomyRules.initial(); val reward = PromoRules.storedReward(entry)
        val after = PromoRules.apply(before, reward)
        assertEquals(before.wallet.coins + 500, after.wallet.coins)
        assertEquals(before.wallet.pearls + 40, after.wallet.pearls)
        assertEquals(before.inventory.getValue("wood") + 5, after.inventory.getValue("wood"))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { PromoRules.apply(before.copy(inventory = mapOf("wood" to 300)), reward) }.code)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { PromoRules.apply(before, reward, mapOf("stone" to 270)) }.code)
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> { PromoRules.apply(before.copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE)), reward) }.code)
    }
    @Test fun `time window is inclusive start exclusive end and disabled code is unknown`() {
        assertEquals(entry.id, PromoRules.available(parse(entry.copy(startsAt = now.toString())), " test-gift ", now).id)
        for ((code, value) in listOf("PROMO_NOT_FOUND" to entry.copy(enabled = false), "PROMO_NOT_STARTED" to entry.copy(startsAt = now.plusSeconds(1).toString()),
            "PROMO_EXPIRED" to entry.copy(endsAt = now.toString())))
            assertEquals(code, assertFailsWith<AuthFailure> { PromoRules.available(parse(value), entry.code, now) }.code)
    }

    @Test fun `specific fish gifts preserve species without adding catches knowledge or losing stage progress`() {
        val before = EconomyRules.initial(includeStartingPack = false).copy(inventory = mapOf("fish_epic" to 1L),
            fishing = EconomyFishing(stock = mapOf("fish_mirror_koi" to 1L)), marketSlots = 8,
            stageOrders = EconomyStageOrderState(stages = mapOf("2" to EconomyStageOrderProgress(step = 1))),
            unlockedItems = listOf("wood"))
        val next = PromoRules.apply(before, PromoReward(items = mapOf("fish_sturgeon" to 2L, "fish_epic" to 3L)))
        assertEquals(6L, next.inventory["fish_epic"])
        assertFalse("fish_sturgeon" in next.inventory)
        assertEquals(mapOf("fish_mirror_koi" to 1L, "fish_sturgeon" to 2L), next.fishing.stock)
        assertEquals(before.fishing.catches, next.fishing.catches)
        assertEquals(before.progression, next.progression)
        assertEquals(before.unlockedItems, next.unlockedItems)
        assertEquals(before.marketSlots, next.marketSlots)
        assertEquals(before.stageOrders, next.stageOrders)
    }
}
