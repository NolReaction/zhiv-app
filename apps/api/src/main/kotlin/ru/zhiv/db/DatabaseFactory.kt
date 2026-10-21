package ru.zhiv.db

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.flywaydb.core.Flyway
import ru.zhiv.config.AppConfig
import javax.sql.DataSource

object DatabaseFactory {
    fun create(config: AppConfig): HikariDataSource = create(config, migration = false)

    /** The one-shot migration process scans existing data under stopped writers.
     * Keep its bounded maintenance budget separate from short API request limits. */
    fun createForMigrations(config: AppConfig): HikariDataSource {
        require(config.databaseUser != "zhiv_app") { "Runtime role must not execute migrations" }
        return create(config, migration = true)
    }

    private fun create(config: AppConfig, migration: Boolean): HikariDataSource = HikariDataSource(
        HikariConfig().apply {
            jdbcUrl = config.databaseUrl
            username = config.databaseUser
            password = config.databasePassword
            driverClassName = "org.postgresql.Driver"
            maximumPoolSize = 8
            minimumIdle = 1
            connectionTimeout = 5_000
            validationTimeout = 2_000
            idleTimeout = 600_000
            maxLifetime = 1_800_000
            connectionInitSql = if (migration)
                "SET statement_timeout = '5min'; SET lock_timeout = '15s'; SET idle_in_transaction_session_timeout = '60s'"
            else "SET statement_timeout = '8s'; SET lock_timeout = '3s'; SET idle_in_transaction_session_timeout = '10s'"
            isAutoCommit = false
            // Commit pool initialization and isolate validation from application
            // transactions, including freshly opened connections during pool growth.
            isIsolateInternalQueries = true
            transactionIsolation = "TRANSACTION_READ_COMMITTED"
            addDataSourceProperty("ApplicationName", if (migration) "zhiv-migrate" else "zhiv-api")
            addDataSourceProperty("reWriteBatchedInserts", "true")
            addDataSourceProperty("logServerErrorDetail", "false")
            addDataSourceProperty("connectTimeout", "5")
            // Let PostgreSQL report its statement timeout before the driver closes
            // the socket; closing it first obscures whether a migration committed.
            addDataSourceProperty("socketTimeout", if (migration) "330" else "10")
            addDataSourceProperty("tcpKeepAlive", "true")
        },
    )

    fun migrate(dataSource: DataSource) {
        Flyway.configure()
            .dataSource(dataSource)
            .locations("classpath:db/migration")
            .cleanDisabled(true)
            .load()
            .migrate()
    }
}
