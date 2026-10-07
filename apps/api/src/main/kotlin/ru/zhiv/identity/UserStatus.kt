package ru.zhiv.identity

// New writes have a shorter limit; the database retains legacy values without truncation.
internal const val MAX_STATUS_LENGTH = 30

internal fun validStatus(raw: String): String? {
    if (hasUserTextControls(raw)) return null
    val text = raw.trim { it.isWhitespace() || Character.isSpaceChar(it) }.replace(Regex("[\\s\\p{Z}]+"), " ")
    return text.takeIf { it.codePointCount(0, it.length) <= MAX_STATUS_LENGTH }
}
