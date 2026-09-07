package ru.zhiv.db

import ru.zhiv.identity.validTimeZone
import java.sql.Connection

/** Both the JVM and PostgreSQL must understand the supplied IANA identifier. */
internal fun Connection.acceptsTimeZone(timeZone: String): Boolean {
    if (validTimeZone(timeZone) == null) return false
    return prepareStatement("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ?)").use { statement ->
        statement.setString(1, timeZone)
        statement.executeQuery().use { result -> result.next() && result.getBoolean(1) }
    }
}
