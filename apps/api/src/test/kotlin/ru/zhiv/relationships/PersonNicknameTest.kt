package ru.zhiv.relationships

import kotlin.test.Test
import kotlin.test.assertEquals

class PersonNicknameTest {
    @Test
    fun `nickname normalizes spaces counts Unicode and rejects controls`() {
        assertEquals("Мама 💚", normalizePersonNickname("  Мама   💚  "))
        assertEquals("", normalizePersonNickname("  "))
        assertEquals("😀".repeat(50), normalizePersonNickname("😀".repeat(50)))
        for (value in listOf("😀".repeat(51), "a\nb", "a\u202eb", "a\u0000b")) {
            assertEquals(null, normalizePersonNickname(value))
        }
    }
}
