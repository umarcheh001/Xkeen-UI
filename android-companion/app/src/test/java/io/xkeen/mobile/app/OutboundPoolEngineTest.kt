package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboundPoolEngineTest {
    @Test
    fun poolInputAcceptsThreeFormatsNormalizesAndCreatesUniqueTags() {
        val result = mergeOutboundPoolInput(
            current = emptyList(),
            input = """
                nl main | vless://123e4567-e89b-12d3-a456-426614174000@nl.example.net:443?security=tls&type=ws&path=socket#Amsterdam
                de = trojan://secret@de.example.net:443?security=tls#Berlin
                trojan://secret@de2.example.net:443?security=tls#Berlin
                direct | trojan://secret@reserved.example.net:443?security=tls
            """.trimIndent(),
        )

        assertEquals(4, result.addedCount)
        assertEquals(listOf("nl_main", "de", "Berlin", "direct-2"), result.entries.map(OutboundPoolEntryDraft::tag))
        assertTrue(result.entries.first().url.contains("path=%2Fsocket"))
        assertTrue(result.entries.all(OutboundPoolEntryDraft::isValid))
    }

    @Test
    fun explicitTagUpdatesExistingEntryAndInvalidLinkStaysVisibleForCorrection() {
        val first = mergeOutboundPoolInput(
            current = emptyList(),
            input = "node | trojan://secret@old.example.net:443?security=tls",
        )
        val second = mergeOutboundPoolInput(
            current = first.entries,
            input = "node = socks://unsupported.example.net:1080",
        )

        assertEquals(1, second.entries.size)
        assertEquals("node", second.entries.single().tag)
        assertFalse(second.entries.single().isValid)
        assertTrue(second.entries.single().preview.errors.isNotEmpty())
    }
}
