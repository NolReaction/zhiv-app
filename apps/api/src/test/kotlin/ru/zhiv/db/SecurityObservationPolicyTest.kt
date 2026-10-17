package ru.zhiv.db

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.economy.EconomyBarterCommand
import ru.zhiv.economy.EconomyCommand
import ru.zhiv.economy.economyJson
import ru.zhiv.game.ProgressionRewardClaim
import ru.zhiv.game.progressionRewardsJson
import java.util.UUID
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SecurityObservationPolicyTest {
    @Test fun `revision refresh account merge and old undecodable formats are not evidence`() {
        val command = EconomyCommand(UUID.randomUUID().toString(), "0000-0000-0000", 3, "sell", "wood", 1)
        val old = economyJson.encodeToString(command)
        assertFalse(semanticEconomyTamper(old, command))
        assertFalse(semanticEconomyTamper(old, command.copy(expectedRevision=4, ownerPublicId="1111-1111-1111")))
        assertFalse(semanticEconomyTamper("{\"oldFormat\":true}", command))
        assertTrue(semanticEconomyTamper(old, command.copy(quantity=2)))
        assertTrue(semanticEconomyTamper(old, command.copy(action="start_production",targetId="planks")))
    }

    @Test fun `fish map order is irrelevant but selection changes are meaningful`() {
        val command = EconomyCommand(UUID.randomUUID().toString(), "0000-0000-0000", 3, "sell_fish", "fish_common", 2,
            fishSelection=linkedMapOf("minnow" to 1L,"perch" to 1L))
        val old = economyJson.encodeToString(command)
        assertFalse(semanticEconomyTamper(old, command.copy(fishSelection=linkedMapOf("perch" to 1L,"minnow" to 1L))))
        assertTrue(semanticEconomyTamper(old, command.copy(fishSelection=mapOf("perch" to 2L))))
    }

    @Test fun `barter and rewards ignore owner rebind but keep signed business parameters`() {
        val barter = EconomyBarterCommand(UUID.randomUUID().toString(),"0000-0000-0000",0,"create_offer","living_resin","moon_crystal")
        val oldBarter = economyJson.encodeToString(barter)
        assertFalse(semanticBarterTamper(oldBarter,barter.copy(expectedRevision=9,ownerPublicId="1111-1111-1111")))
        assertTrue(semanticBarterTamper(oldBarter,barter.copy(requestedItemId="ancient_core")))
        val reward = ProgressionRewardClaim(UUID.randomUUID().toString(),"0000-0000-0000","daily")
        val oldReward = progressionRewardsJson.encodeToString(reward)
        assertFalse(semanticRewardTamper(oldReward,reward.copy(ownerPublicId="1111-1111-1111")))
        assertTrue(semanticRewardTamper(oldReward,reward.copy(kind="achievement",achievementId="thousand_taps",level=1)))
    }
}
