package ru.zhiv.db

import ru.zhiv.config.AppConfig

/** One-shot process; never grant migration credentials to the API process. */
fun main() {
    val config = AppConfig.fromEnvironment()
    require(config.databaseUser != "zhiv_app") { "Runtime role must not execute migrations" }
    DatabaseFactory.create(config).use { source ->
        DatabaseFactory.migrate(source)
        source.connection.use { connection ->
            connection.createStatement().use {
                it.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zhiv_app")
                it.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zhiv_app")
                it.execute("REVOKE ALL ON TABLE public.flyway_schema_history FROM zhiv_app")
                it.execute("REVOKE ALL ON TABLE account_recovery_contacts, account_recovery_contact_removals, account_recovery_attempts FROM zhiv_app")
            }
            connection.commit()
        }
    }
}
