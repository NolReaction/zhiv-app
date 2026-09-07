package ru.zhiv.identity

import java.time.ZoneId

private val supportedTimeZones = ZoneId.getAvailableZoneIds()

/** Named IANA zones only: raw UTC offsets are not timezone rules. */
fun validTimeZone(raw: String): String? = raw.takeIf {
    it.length in 1..64 && it in supportedTimeZones &&
        (it == "UTC" || ('/' in it && !it.startsWith("SystemV/")))
}

class InvalidTimeZoneException : RuntimeException("Unsupported time zone")

sealed interface TimeZoneUpdateResult {
    data class Success(val user: UserSnapshot) : TimeZoneUpdateResult
    data object Unauthorized : TimeZoneUpdateResult
    data object Invalid : TimeZoneUpdateResult
    data object IdempotencyConflict : TimeZoneUpdateResult
}
