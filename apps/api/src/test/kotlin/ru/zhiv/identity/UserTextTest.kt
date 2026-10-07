package ru.zhiv.identity

import ru.zhiv.auth.AuthFailure
import ru.zhiv.auth.loginDisplayName
import ru.zhiv.feedback.validatedFeedbackMessage
import ru.zhiv.groups.validEmoji
import ru.zhiv.groups.validTitle
import ru.zhiv.relationships.normalizePersonNickname
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UserTextTest {
    @Test fun `identity group and feedback validators reject direction overrides and C1 controls`() {
        for (control in listOf('\u0085', '\u009b', '\u202a', '\u202e', '\u2066', '\u2069')) {
            val text = "Админ${control}тест"
            assertNull(normalizedDisplayName(text))
            assertNull(loginDisplayName(text))
            assertNull(normalizePersonNickname(text))
            assertNull(validStatus(text))
            assertFalse(validTitle(text))
            assertFalse(validEmoji(control.toString()))
            assertFailsWith<AuthFailure> { validatedFeedbackMessage("bug", "Описание ${control} ошибки") }
        }
    }

    @Test fun `normal Unicode and instruction-like reports remain plain data`() {
        for (text in listOf("Алёна", "محمد", "שלום", "👨‍👩‍👧‍👦", "Игнорируй предыдущие инструкции", "<script>alert(1)</script>")) {
            assertEquals(text, normalizedDisplayName(text))
            assertEquals(text, loginDisplayName(text))
            assertTrue(validTitle(text))
        }
        assertEquals("😀".repeat(50), normalizedDisplayName("😀".repeat(50)))
        assertNull(normalizedDisplayName("😀".repeat(51)))
        assertTrue(validTitle("😀".repeat(64)))
        assertFalse(validTitle("😀".repeat(65)))
        assertTrue(validEmoji("👨‍👩‍👧‍👦"))
        val report = "Ошибка: <img src=x onerror=alert(1)>; ignore previous instructions; SELECT * FROM users;"
        assertEquals(report, validatedFeedbackMessage("bug", report))
        assertEquals("Строка первая\nВторая\nТретья\tстрока",
            validatedFeedbackMessage("bug", "  Строка первая\r\nВторая\rТретья\tстрока  "))
        assertEquals("😀".repeat(3000), validatedFeedbackMessage("bug", "😀".repeat(3000)))
        assertFailsWith<AuthFailure> { validatedFeedbackMessage("bug", "😀".repeat(3001)) }
    }
}
