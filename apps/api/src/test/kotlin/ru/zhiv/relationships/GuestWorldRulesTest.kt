package ru.zhiv.relationships

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.economy.EconomyRules
import java.util.UUID
import kotlin.test.*

class GuestWorldRulesTest {
    private fun json(raw: String) = Json.parseToJsonElement(raw).jsonObject

    @Test fun `new worlds use catalog defaults and existing legacy buildings remain visible`() {
        val empty = GuestWorldRules.scene(null,null,emptyList())
        assertEquals(EconomyRules.catalog.buildings.map { it.id }.toSet(),empty.buildings.keys)
        assertEquals(1,empty.buildings["home"])
        val legacy = GuestWorldRules.scene(null,json("""{"houseLevel":4,"workshop":true,"workshopLevel":2}"""),emptyList())
        assertEquals(4,legacy.buildings["home"]);assertEquals(2,legacy.buildings["workshop"])
        val current = GuestWorldRules.scene(json("""{"buildings":{"home":2,"workshop":0,"private_place":99}}"""),
            json("""{"houseLevel":5,"workshop":true,"workshopLevel":3}"""),emptyList())
        assertEquals(2,current.buildings["home"]);assertEquals(0,current.buildings["workshop"])
        assertFalse("private_place" in current.buildings)
    }

    @Test fun `only actual catalog clothing and earned decorations are exposed`() {
        val result = GuestWorldRules.scene(null,json("""{"equipment":{"palette":"moss","head":"rain_hood","neck":"amber_scarf","rod":"unknown"},
            "hiddenGifts":["flower","leaf_bed","unknown"],"inventory":["secret"]}"""),listOf("flower","keepsakes","unknown"))
        assertEquals("moss",result.equipment.palette);assertEquals("rain_hood",result.equipment.head)
        assertEquals("amber_scarf",result.equipment.neck);assertNull(result.equipment.rod)
        assertEquals(listOf("flower","keepsakes"),result.gifts);assertEquals(listOf("flower"),result.hiddenGifts)
        assertFalse(Json.encodeToString(result).contains("secret"))
    }

    @Test fun `work clocks keep real collection and construction stages without private reward rolls`() {
        val first = UUID.randomUUID();val second=UUID.randomUUID()
        val result = GuestWorldRules.scene(json("""{"wallet":{"coins":54321},"inventory":{"wood":876},"fishingCastSeed":"secret-seed",
          "jobs":[{"id":"$first","kind":"production","targetId":"garden","recipeId":"grow_berries",
            "startedAt":"2026-10-19T00:00:00Z","finishesAt":"2026-10-19T00:01:00Z",
            "rewards":{"berries":99},"cost":{"coins":999},"rareDrop":{"itemId":"secret-roll"},
            "collection":{"kind":"berry_harvest","seconds":8,"startedAt":"2026-10-19T00:02:00Z","finishesAt":"2026-10-19T00:02:08Z","batchId":"secret-batch"}},
            {"id":"$second","kind":"construction","targetId":"home","targetLevel":3,
            "startedAt":"2026-10-19T00:00:00Z","finishesAt":"2026-10-19T01:00:00Z","meal":{"itemId":"secret-meal"}}]}"""),null,emptyList())
        assertEquals(2,result.jobs.size)
        assertEquals("grow_berries",result.jobs.first().recipeId)
        assertEquals("2026-10-19T00:02:08Z",result.jobs.first().collection?.finishesAt)
        assertEquals(3,result.jobs.last().targetLevel)
        val serialized=Json.encodeToString(result)
        for (secret in listOf("wallet","inventory","rewards","cost","rareDrop","batchId","meal","secret")) assertFalse(serialized.contains(secret),secret)
    }

    @Test fun `unknown or malformed job targets and clocks never become scenery`() {
        val id=UUID.randomUUID()
        val result=GuestWorldRules.scene(json("""{"jobs":[{"id":"$id","kind":"private","targetId":"home","startedAt":"2026-10-19T00:00:00Z","finishesAt":"2026-10-19T00:01:00Z"},
          {"id":"$id","kind":"construction","targetId":"unknown","startedAt":"2026-10-19T00:00:00Z","finishesAt":"2026-10-19T00:01:00Z"},
          {"id":"$id","kind":"construction","targetId":"home","startedAt":"2026-10-19T00:01:00Z","finishesAt":"2026-10-19T00:00:00Z"}]}"""),null,emptyList())
        assertTrue(result.jobs.isEmpty())
    }
}
