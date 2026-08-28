package ru.zhiv.identity

import java.security.SecureRandom

class PublicIdGenerator(private val random: SecureRandom = SecureRandom()) {
    private val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    fun next(): String {
        val raw = CharArray(12) { alphabet[random.nextInt(alphabet.length)] }.concatToString()
        return "${raw.substring(0, 4)}-${raw.substring(4, 8)}-${raw.substring(8, 12)}"
    }
}
