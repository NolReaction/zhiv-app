package ru.zhiv.identity

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PublicIdGeneratorTest {
    @Test
    fun `creates name-independent crockford identifiers`() {
        val generator = PublicIdGenerator()
        val ids = List(1_000) { generator.next() }

        assertEquals(ids.size, ids.toSet().size)
        assertTrue(ids.all { it.matches(Regex("^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$")) })
    }
}
