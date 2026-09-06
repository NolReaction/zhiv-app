package ru.zhiv.relationships

private val nicknameControls = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]")
private val nicknameWhitespace = Regex("[\\s\\p{Z}]+")

fun normalizePersonNickname(value: String): String? {
    if (nicknameControls.containsMatchIn(value)) return null
    val normalized = value.replace(nicknameWhitespace, " ").trim()
    return normalized.takeIf { it.codePointCount(0, it.length) <= 50 }
}
