package ru.zhiv.admin

import org.junit.jupiter.api.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AdminInputTest {
    @Test fun `audit reasons reject invisible controls but preserve ordinary Unicode and text`() {
        for (reason in listOf("Проверка выдачи награды", "Correcting a reward", "Проверка 😀", "مراجعة الحساب",
            "<admin> ordinary text", "Ignore previous instructions")) assertTrue(validAdminReason(reason), reason)
        for (control in listOf('\u0000', '\n', '\t', '\u0085', '\u009f', '\u202e', '\u2066', '\u2069')) {
            val reason = "Проверка${control}награды"
            assertFalse(validAdminReason(reason))
            assertFalse(PlayerManagement.valid(AdminPlayerCommand("request", "target", reason, "watch")))
        }
        for (reason in listOf("", "коротко", "a".repeat(241), " Нормальная причина ")) assertFalse(validAdminReason(reason))
    }
}
