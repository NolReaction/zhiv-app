package ru.zhiv.db

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.flywaydb.core.Flyway
import ru.zhiv.config.AppConfig
import javax.sql.DataSource

object DatabaseFactory {
    fun create(config: AppConfig): HikariDataSource = HikariDataSource(
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
            connectionInitSql = "SET statement_timeout = '8s'; SET lock_timeout = '3s'; SET idle_in_transaction_session_timeout = '10s'"
            isAutoCommit = false
            transactionIsolation = "TRANSACTION_READ_COMMITTED"
            addDataSourceProperty("ApplicationName", "zhiv-api")
            addDataSourceProperty("reWriteBatchedInserts", "true")
            addDataSourceProperty("logServerErrorDetail", "false")
            addDataSourceProperty("connectTimeout", "5")
            addDataSourceProperty("socketTimeout", "10")
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
