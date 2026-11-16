package ru.zhiv.economy

import org.junit.jupiter.api.Test
import kotlin.test.*

class EconomyConstructionMealsTest {
    @Test fun `cheap servings cover a fixed budget while expensive food has a long-work niche`() {
        assertEquals(14237L, EconomyFood.builderWorkDuration(14400, 1000, 0, 1800))
        assertEquals(28637L, EconomyFood.builderWorkDuration(28800, 1000, 0, 1800))
        assertEquals(546L, EconomyFood.builderWorkDuration(600, 1000, 0, 1800))
        assertEquals(11400L, EconomyFood.builderWorkDuration(14400, 5000, 0, 9000))
    }

    @Test fun `old servings keep full duration while zero budget grants no food benefit`() {
        assertEquals(13091L, EconomyFood.builderWorkDuration(14400, 1000, 0))
        assertEquals(13090910L, EconomyFood.fedConstructionDuration(14400000, 1000, 0))
        assertEquals(14400L, EconomyFood.builderWorkDuration(14400, 1000, 0, 0))
        assertEquals(14400000L, EconomyFood.fedConstructionDuration(14400000, 1000, 0, 0))
    }

    @Test fun `before and after feeding agree within one millisecond with saved professional bonuses`() {
        for (seconds in listOf(1L, 601L, 3600L, 14400L, 31536000L))
            for (food in listOf(0, 1000, 6500, 10000)) for (trade in listOf(0, 500, 1000))
                for (skill in listOf(0, 150, 300)) for (budget in listOf(60L, 1800L, 21600L, null)) {
                    val unfed = EconomyFood.builderWorkDuration(seconds * 1000, 0, trade, 0, skill)
                    val after = EconomyFood.fedConstructionDuration(unfed, food, trade, budget?.times(1000), skill)
                    val before = EconomyFood.builderWorkDuration(seconds * 1000, food, trade, budget?.times(1000), skill)
                    assertTrue(kotlin.math.abs(after - before) <= 1)
                    assertTrue(after in 0..unfed)
                }
    }

    @Test fun `fractional milliseconds never promise an early finish`() {
        assertEquals(501L, EconomyFood.fedConstructionDuration(1001, 10000, 0, 100000))
        assertEquals(545455L, EconomyFood.fedConstructionDuration(600000, 1000, 0, 1800000))
        assertEquals(0L, EconomyFood.fedConstructionDuration(0, 1000, 1000, 1800000, 300))
        assertFailsWith<IllegalArgumentException> { EconomyFood.builderWorkDuration(100, 1000, 0, -1) }
        assertFailsWith<IllegalArgumentException> { EconomyFood.fedConstructionDuration(100, 1000, 1001) }
    }
}
