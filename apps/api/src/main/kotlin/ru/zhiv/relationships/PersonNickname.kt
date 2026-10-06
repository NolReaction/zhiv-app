package ru.zhiv.relationships

import ru.zhiv.identity.hasUserTextControls

private val nicknameWhitespace = Regex("[\\s\\p{Z}]+")

fun normalizePersonNickname(value: String): String? {
    if (hasUserTextControls(value)) return null
    val normalized = value.replace(nicknameWhitespace, " ").trim()
    return normalized.takeIf { it.codePointCount(0, it.length) <= 50 }
}
