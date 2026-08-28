package ru.zhiv.http

import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class HttpSupportTest {
    @Test
    fun `accepts only canonical UUID headers`() {
        val canonical = "01993e7a-3f00-7abc-8def-1234567890ab"
        assertEquals(canonical, parseCanonicalUuid(canonical)?.toString())
        assertNull(parseCanonicalUuid("1-1-1-1-1"))
        assertNull(parseCanonicalUuid("01993e7a3f007abc8def1234567890ab"))
        assertNull(parseCanonicalUuid(null))
    }

    @Test
    fun `bootstrap UUID parser accepts only RFC 4122 version 4`() {
        val random = UUID.randomUUID()
        assertEquals(random, parseCanonicalUuidV4(random.toString()))
        assertNull(parseCanonicalUuidV4("00000000-0000-0000-0000-000000000000"))
        assertNull(parseCanonicalUuidV4("01993e7a-3f00-7abc-8def-1234567890ab"))
    }

    @Test
    fun `public ID parser never truncates trailing garbage`() {
        assertEquals("7K3P-2Q9M-W8ZR", parsePublicId("7k3p 2q9m w8zr"))
        assertNull(parsePublicId("7K3P-2Q9M-W8ZR-X"))
        assertNull(parsePublicId("7K3P-2Q9M-W8ZO"))
    }
}
