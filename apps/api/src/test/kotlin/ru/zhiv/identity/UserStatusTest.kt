package ru.zhiv.identity

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class UserStatusTest {
    @Test
    fun `status limit counts 30 Unicode code points after whitespace normalization`() {
        for (character in listOf("я", "😀")) {
            assertEquals(character.repeat(30), validStatus(character.repeat(30)))
            assertEquals(character.repeat(30), validStatus("  ${character.repeat(30)}  "))
            assertNull(validStatus(character.repeat(31)))
        }
        assertEquals("я 😀", validStatus("  я\u00a0\u2003😀  "))
        assertEquals("", validStatus("  \u00a0  "))
        for (value in listOf("я\nдома", "a\u202eb", "a\u2066b", "я\u007f")) {
            assertNull(validStatus(value))
        }
    }
}
