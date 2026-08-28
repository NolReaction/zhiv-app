package ru.zhiv.security

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class TokenCodecTest {
    private val codec = TokenCodec()

    @Test
    fun `issues opaque 256-bit token and stores a sha-256 hash`() {
        val token = codec.issue()

        assertEquals(43, token.raw.length)
        assertEquals(32, token.hash.size)
        assertContentEquals(token.hash, codec.hash(token.raw))
        assertFalse(token.raw.toByteArray().contentEquals(token.hash))
    }
}
