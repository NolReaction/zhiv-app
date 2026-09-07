package ru.zhiv.identity

// New writes have a shorter limit; the database retains legacy values without truncation.
internal const val MAX_STATUS_LENGTH = 30

internal fun validStatus(raw: String): String? {
    if (raw.any { it.isISOControl() || it in '\u202a'..'\u202e' || it in '\u2066'..'\u2069' }) return null
    val text = raw.trim { it.isWhitespace() || Character.isSpaceChar(it) }.replace(Regex("[\\s\\p{Z}]+"), " ")
    return text.takeIf { it.codePointCount(0, it.length) <= MAX_STATUS_LENGTH }
}
