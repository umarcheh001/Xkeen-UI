package io.xkeen.mobile.app

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorEngineTest {
    @Test
    fun documentIndexProvidesMetricsAndDirectLineOffsets() {
        val source = "{\n  \"routing\": {\n    \"rules\": []\n  }\n}"
        val index = EditorDocumentIndex.build(source)
        val rulesOffset = source.indexOf("rules")

        assertEquals(5, index.lineCount)
        assertEquals(source.length, index.characterCount)
        assertEquals(2, index.wordCount)
        assertEquals(EditorCursor(line = 3, column = 6), index.cursorAt(rulesOffset))
        assertEquals(source.indexOf("    \"rules\""), index.offsetForLine(3))
        assertEquals(
            "    \"rules\": []",
            source.substring(index.lineRangeAt(source, rulesOffset).start, index.lineRangeAt(source, rulesOffset).end),
        )
    }

    @Test
    fun lineRangeExcludesWindowsLineEnding() {
        val source = "first\r\nsecond\r\n"
        val index = EditorDocumentIndex.build(source)

        assertEquals(TextRange(0, 5), index.lineRangeAt(source, 2))
        assertEquals(TextRange(7, 13), index.lineRangeAt(source, 10))
        assertEquals(EditorCursor(3, 1), index.cursorAt(source.length))
    }

    @Test
    fun incrementalHistoryMergesTypingWithoutStoringWholeDocument() {
        val history = EditorHistory()
        val initial = TextFieldValue("prefix ", selection = TextRange(7))
        val one = TextFieldValue("prefix r", selection = TextRange(8))
        val two = TextFieldValue("prefix ru", selection = TextRange(9))
        val three = TextFieldValue("prefix rul", selection = TextRange(10))

        history.record(initial, one, timestampMillis = 100)
        history.record(one, two, timestampMillis = 200)
        history.record(two, three, timestampMillis = 300)

        assertTrue(history.canUndo)
        val undone = history.undo(three)
        assertEquals(initial, undone)
        assertFalse(history.canUndo)
        assertTrue(history.canRedo)
        assertEquals(three, history.redo(requireNotNull(undone)))
    }

    @Test
    fun incrementalHistoryRestoresReplacementAndBackspaceGroups() {
        val history = EditorHistory()
        val initial = TextFieldValue("alpha beta", selection = TextRange(6, 10))
        val replaced = TextFieldValue("alpha rule", selection = TextRange(10))
        history.record(initial, replaced, timestampMillis = 100)

        assertEquals(initial, history.undo(replaced))
        assertEquals(replaced, history.redo(initial))

        val minusE = TextFieldValue("alpha rul", selection = TextRange(9))
        val minusL = TextFieldValue("alpha ru", selection = TextRange(8))
        history.record(replaced, minusE, timestampMillis = 1_000)
        history.record(minusE, minusL, timestampMillis = 1_100)

        assertEquals(replaced, history.undo(minusL))
    }

    @Test
    fun lineActionsSelectAndDuplicateCurrentJsonLine() {
        val source = "{\n  \"rules\": []\n}"
        val cursor = source.indexOf("rules")
        val value = TextFieldValue(source, selection = TextRange(cursor))

        val selected = selectEditorLine(value)
        assertEquals("  \"rules\": []", source.substring(selected.selection.start, selected.selection.end))

        val duplicated = duplicateEditorLine(value)
        assertEquals("{\n  \"rules\": []\n  \"rules\": []\n}", duplicated.text)
        assertEquals(
            "  \"rules\": []",
            duplicated.text.substring(duplicated.selection.start, duplicated.selection.end),
        )
    }

    @Test
    fun duplicatingLastLinePreservesWindowsLineEnding() {
        val source = "first\r\nsecond"
        val value = TextFieldValue(source, selection = TextRange(source.length))

        val duplicated = duplicateEditorLine(value)

        assertEquals("first\r\nsecond\r\nsecond", duplicated.text)
        assertEquals("second", duplicated.text.substring(duplicated.selection.start, duplicated.selection.end))
    }

    @Test
    fun internetSearchUsesSelectionOrWordAtCursor() {
        val source = "\"domainStrategy\": \"IPIfNonMatch\""

        assertEquals("domainStrategy", editorInternetSearchQuery(source, 1, 15))
        assertEquals("IPIfNonMatch", editorInternetSearchQuery(source, source.indexOf("NonMatch"), source.indexOf("NonMatch")))
        assertEquals("", editorInternetSearchQuery(source, source.indexOf(':'), source.indexOf(':')))
    }

    @Test
    fun editorPasteActionAlwaysUsesPlainText() {
        assertEquals(android.R.id.pasteAsPlainText, editorPlainTextMenuAction(android.R.id.paste))
        assertEquals(android.R.id.pasteAsPlainText, editorPlainTextMenuAction(android.R.id.pasteAsPlainText))
        assertEquals(android.R.id.copy, editorPlainTextMenuAction(android.R.id.copy))
    }

    @Test
    fun documentToolbarTitleResizeUsesScreenDensityAndSafeBounds() {
        assertEquals(114f, resizedDocumentTitleWidth(164f, dragDeltaPx = -100f, density = 2f), 0.001f)
        assertEquals(72f, resizedDocumentTitleWidth(80f, dragDeltaPx = -100f, density = 2f), 0.001f)
        assertEquals(260f, resizedDocumentTitleWidth(250f, dragDeltaPx = 100f, density = 2f), 0.001f)
    }

    @Test
    fun persistedToolbarLayoutRejectsInvalidWidthAndScrollOffset() {
        assertEquals(
            EditorToolbarLayout(titleWidthDp = 164f, scrollOffsetPx = 0),
            EditorToolbarLayout(titleWidthDp = Float.NaN, scrollOffsetPx = -50).normalized(),
        )
        assertEquals(
            EditorToolbarLayout(titleWidthDp = 260f, scrollOffsetPx = 40),
            EditorToolbarLayout(titleWidthDp = 900f, scrollOffsetPx = 40).normalized(),
        )
    }

    @Test
    fun editorSearchFindsMatchesCaseInsensitivelyAndWraps() {
        val source = "rule RULE rule"

        val first = findEditorText(source, "rule", 0, 0, forward = true)
        assertEquals(3, first.matchCount)
        assertEquals(1, first.selectedMatch)
        assertEquals(TextRange(0, 4), first.range)

        val next = findEditorText(source, "rule", 0, 4, forward = true)
        assertEquals(2, next.selectedMatch)
        assertEquals(TextRange(5, 9), next.range)

        val wrappedBack = findEditorText(source, "rule", 0, 0, forward = false)
        assertEquals(3, wrappedBack.selectedMatch)
        assertEquals(TextRange(10, 14), wrappedBack.range)
    }

    @Test
    fun changedLineRangesTrackSeparateEditsAgainstSavedContent() {
        val saved = "one\ntwo\nthree\nfour"
        val edited = "one\nTWO\nthree\nFOUR"

        assertEquals(listOf(2..2, 4..4), editorChangedLineRanges(saved, edited))
        assertEquals(emptyList<IntRange>(), editorChangedLineRanges(saved, saved))
    }

    @Test
    fun changedLineRangesDoNotMarkUnchangedLinesShiftedByInsertion() {
        val saved = "alpha\ngamma\nomega"
        val edited = "alpha\nbeta\ngamma\nomega"

        assertEquals(listOf(2..2), editorChangedLineRanges(saved, edited))
    }

    @Test
    fun changedLineRangesAnchorDeletedContentToNearestRemainingLine() {
        assertEquals(
            listOf(2..2),
            editorChangedLineRanges("alpha\nbeta\ngamma", "alpha\ngamma"),
        )
        assertEquals(
            listOf(1..1),
            editorChangedLineRanges("alpha\nbeta", "alpha"),
        )
        assertEquals(
            listOf(1..1),
            editorChangedLineRanges("alpha", ""),
        )
    }

    @Test
    fun documentIndexHandlesLargeRoutingDocument() {
        val source = buildString {
            repeat(100_000) { line -> append("rule-").append(line).append('\n') }
        }

        val index = EditorDocumentIndex.build(source)

        assertEquals(100_001, index.lineCount)
        assertEquals(EditorCursor(100_000, 1), index.cursorAt(index.offsetForLine(100_000)))
        assertEquals(EditorCursor(100_001, 1), index.cursorAt(source.length))
    }
}
