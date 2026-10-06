package ru.zhiv.identity

// New writes only. Mirror lib/user-text.ts; ordinary RTL letters and emoji stay
// valid. Do not interpret user text as markup, code or assistant instructions.
internal fun hasUserTextControls(value: String, multiline: Boolean = false): Boolean = value.any {
    (it.isISOControl() && !(multiline && (it == '\n' || it == '\t'))) ||
        it in '\u202a'..'\u202e' || it in '\u2066'..'\u2069'
}

internal fun normalizedDisplayName(raw: String): String? {
    if (hasUserTextControls(raw)) return null
    val normalized = raw.trim { it.isWhitespace() || Character.isSpaceChar(it) }
        .replace(Regex("[\\s\\p{Z}]+"), " ")
    return normalized.takeIf { it.codePointCount(0, it.length) in 1..50 }
}
