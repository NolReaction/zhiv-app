package ru.zhiv.db

import kotlinx.coroutines.runBlocking
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.AdminConfig
import ru.zhiv.admin.AdminPlayerCommand
import ru.zhiv.config.AppConfig
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
class JdbcModerationMigrationIntegrationTest {
    private class Postgres(image: String): PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres=Postgres("postgres:18-alpine") }
    @Test fun `V27 upgrades a populated V26 database without changing users rewards or audit history`() = runBlocking<Unit> {
        val config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            Flyway.configure().dataSource(source).locations("classpath:db/migration").target("26").cleanDisabled(true).load().migrate()
            val admin=UUID.randomUUID(); val player=UUID.randomUUID(); val key=ByteArray(32) { 7 }; val auditId=UUID.randomUUID()
            source.connection.use { c ->
                c.prepareStatement("INSERT INTO app_users(id,public_id,display_name) VALUES (?,'0000-0000-0001','Admin'),(?,'0000-0000-0002','Player')").use { s -> s.setObject(1,admin);s.setObject(2,player);s.executeUpdate() }
                c.prepareStatement("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 day')").use { s -> s.setObject(1,admin);s.setBytes(2,key);s.executeUpdate() }
                c.prepareStatement("INSERT INTO game_items(user_id,item_id) VALUES (?,'flower')").use { s -> s.setObject(1,player);s.executeUpdate() }
                c.prepareStatement("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,action,reason,affected_sessions,reward_id,granted)
                    VALUES (?,?,?,'0000-0000-0001','0000-0000-0002','grant_item','Existing valid award',0,'flower',true)""").use { s ->
                    s.setObject(1,auditId);s.setObject(2,admin);s.setObject(3,player);s.executeUpdate()
                }
                c.commit()
            }
            DatabaseFactory.migrate(source)
            val repo=JdbcAdminRepository(source,AdminConfig(setOf("0000-0000-0001")))
            assertEquals(listOf("flower"),repo.rewards(key,"0000-0000-0002").items)
            assertNull(repo.player(key,"0000-0000-0002").bannedAt)
            assertNull(repo.player(key,"0000-0000-0002").tag)
            val old=repo.audit(key,0,25).events.single()
            assertEquals(auditId.toString(),old.requestId); assertEquals("flower",old.rewardId)
            val request=AdminPlayerCommand(UUID.randomUUID().toString(),"0000-0000-0002","Upgrade validation grant","grant_resource","wood",12)
            assertTrue(repo.managePlayer(key,"0000-0000-0002",UUID.fromString(request.requestId),request).changed)
            assertEquals(12L,repo.player(key,"0000-0000-0002").world.resources.wood)
            assertEquals(2L,repo.audit(key,0,25).total)
        }
    }
}
