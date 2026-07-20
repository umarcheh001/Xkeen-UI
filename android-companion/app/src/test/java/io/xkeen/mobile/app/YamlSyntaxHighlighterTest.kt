package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class YamlSyntaxHighlighterTest {
    @Test
    fun mappingKeysScalarsAndCommentsAreSeparateTokens() {
        val source = "port: 7890\nenabled: true\nproxy: \"https://example/#node\" # comment"
        val highlighted = highlightYaml(source)
        val tokens = highlighted.spanStyles.map { source.substring(it.start, it.end) }

        assertTrue(tokens.contains("port"))
        assertTrue(tokens.contains("7890"))
        assertTrue(tokens.contains("true"))
        assertTrue(tokens.contains("\"https://example/#node\""))
        assertTrue(tokens.contains("# comment"))
        assertFalse(tokens.contains("#node\" # comment"))
    }

    @Test
    fun structuredDispatcherKeepsJsonAndYamlModesIndependent() {
        val json = highlightStructuredText("{\"port\": 7890}", StructuredTextLanguage.Jsonc)
        val yaml = highlightStructuredText("port: 7890", StructuredTextLanguage.Yaml)

        assertEquals("{\"port\": 7890}", json.text)
        assertEquals("port: 7890", yaml.text)
    }
}
