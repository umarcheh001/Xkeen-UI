package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ListSyntaxHighlighterTest {
    @Test
    fun portRangesAddressesAndCommentsAreSeparateTokens() {
        val source = "80\n596:599\n192.168.0.0/16 # LAN\n# disabled"
        val highlighted = highlightStructuredText(source, StructuredTextLanguage.List)
        val tokens = highlighted.spanStyles.map { source.substring(it.start, it.end) }

        assertEquals(source, highlighted.text)
        assertTrue(tokens.contains("80"))
        assertTrue(tokens.contains("596:599"))
        assertTrue(tokens.contains("192.168.0.0/16"))
        assertTrue(tokens.contains("# LAN"))
        assertTrue(tokens.contains("# disabled"))
    }
}
