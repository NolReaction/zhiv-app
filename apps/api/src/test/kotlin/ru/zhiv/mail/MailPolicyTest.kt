package ru.zhiv.mail

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class MailPolicyTest {
    private fun request()=AdminMailBroadcastRequest(UUID.randomUUID().toString(),"Проверенная рассылка","Новости","Обычный текст\nВторая строка",
        "players",listOf("0000-0000-0001"),false,"ОТПРАВИТЬ")
    @Test fun `mail is plaintext and multiline body never permits controls or visual identity substitution`() {
        assertTrue(validPlayerMailMessage(PlayerMailMessage("<b>Новости</b>","Обычный текст\n\tОтступ")))
        assertTrue(validPlayerMailMessage(PlayerMailMessage("🌲".repeat(120),"Текст")))
        for(value in listOf(PlayerMailMessage(" title","Body"),PlayerMailMessage("Title","Body\r\nNext"),
            PlayerMailMessage("Title\u202e","Body"),PlayerMailMessage("Title","Body\u0000"),PlayerMailMessage("T".repeat(121),"Body")))
            assertFalse(validPlayerMailMessage(value))
    }
    @Test fun `broadcast requires explicit scope unique bounded recipients and confirmation`() {
        validateBroadcast(request())
        validateBroadcast(request().copy(audience="all",publicIds=emptyList()))
        for(value in listOf(request().copy(audience="all"),request().copy(publicIds=emptyList()),request().copy(confirmation="Отправить"),
            request().copy(publicIds=listOf("0000-0000-0001","0000-0000-0001")),request().copy(reason="short"),request().copy(title="")))
            assertFailsWith<AuthFailure> { validateBroadcast(value) }
    }
    @Test fun `cursor is bounded canonical and carries exact timestamp and UUID tie breaker`() {
        val cursor=MailCursor(Instant.parse("2026-10-18T12:34:56.123456Z"),UUID.randomUUID())
        assertEquals(cursor,MailCursor.decode(cursor.encode()));assertNull(MailCursor.decode(null))
        for(raw in listOf("","bad!","a".repeat(161),"MjAyNi0xMC0xOFQxMjozNDo1Nlo=")) assertFailsWith<AuthFailure>{ MailCursor.decode(raw) }
    }
}
