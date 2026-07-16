package io.xkeen.mobile.app

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import java.util.ArrayDeque

internal data class EditorCursor(
    val line: Int = 1,
    val column: Int = 1,
)

internal data class EditorMetrics(
    val characterCount: Int = 0,
    val wordCount: Int = 0,
    val lineCount: Int = 1,
    val cursor: EditorCursor = EditorCursor(),
)

internal data class EditorTextSearchResult(
    val matchCount: Int = 0,
    val selectedMatch: Int? = null,
    val range: TextRange? = null,
)

internal fun findEditorText(
    source: String,
    query: String,
    selectionStart: Int,
    selectionEnd: Int,
    forward: Boolean,
): EditorTextSearchResult {
    if (query.isEmpty() || source.isEmpty()) return EditorTextSearchResult()
    val matches = buildList {
        var searchFrom = 0
        while (searchFrom <= source.length - query.length) {
            val foundAt = source.indexOf(query, searchFrom, ignoreCase = true)
            if (foundAt < 0) break
            add(TextRange(foundAt, foundAt + query.length))
            searchFrom = foundAt + query.length
        }
    }
    if (matches.isEmpty()) return EditorTextSearchResult()

    val start = minOf(selectionStart, selectionEnd).coerceIn(0, source.length)
    val end = maxOf(selectionStart, selectionEnd).coerceIn(0, source.length)
    val selectedIndex = if (forward) {
        matches.indexOfFirst { it.start >= end }.takeIf { it >= 0 } ?: 0
    } else {
        matches.indexOfLast { it.end <= start }.takeIf { it >= 0 } ?: matches.lastIndex
    }
    return EditorTextSearchResult(
        matchCount = matches.size,
        selectedMatch = selectedIndex + 1,
        range = matches[selectedIndex],
    )
}

/**
 * A compact index shared by cursor status, line selection and go-to-line. It is rebuilt only when
 * text changes, so selection moves and fast scrolling never rescan a large routing document.
 */
internal class EditorDocumentIndex private constructor(
    private val lineStarts: IntArray,
    val characterCount: Int,
    val wordCount: Int,
) {
    val lineCount: Int
        get() = lineStarts.size

    fun cursorAt(offset: Int): EditorCursor {
        val safeOffset = offset.coerceIn(0, characterCount)
        val exact = lineStarts.binarySearch(safeOffset)
        val lineIndex = if (exact >= 0) exact else (-exact - 2).coerceAtLeast(0)
        return EditorCursor(
            line = lineIndex + 1,
            column = safeOffset - lineStarts[lineIndex] + 1,
        )
    }

    fun metricsAt(offset: Int): EditorMetrics = EditorMetrics(
        characterCount = characterCount,
        wordCount = wordCount,
        lineCount = lineCount,
        cursor = cursorAt(offset),
    )

    fun offsetForLine(line: Int): Int =
        lineStarts[(line.coerceIn(1, lineCount) - 1)]

    fun lineRangeAt(source: String, offset: Int): TextRange {
        val cursor = cursorAt(offset)
        val start = offsetForLine(cursor.line)
        var end = if (cursor.line < lineCount) {
            offsetForLine(cursor.line + 1) - 1
        } else {
            source.length
        }
        if (end > start && source.getOrNull(end - 1) == '\r') end -= 1
        return TextRange(start, end.coerceAtLeast(start))
    }

    companion object {
        fun build(source: String): EditorDocumentIndex {
            val lineCount = source.count { it == '\n' } + 1
            val starts = IntArray(lineCount)
            var nextLine = 1
            var words = 0
            var insideWord = false

            source.forEachIndexed { index, char ->
                if (char == '\n') starts[nextLine++] = index + 1
                val isWordCharacter = char.isLetterOrDigit() || char == '_'
                if (!isWordCharacter) {
                    insideWord = false
                } else if (!insideWord) {
                    words += 1
                    insideWord = true
                }
            }
            return EditorDocumentIndex(
                lineStarts = starts,
                characterCount = source.length,
                wordCount = words,
            )
        }
    }
}

internal data class EditorMutation(
    val start: Int,
    val removed: String,
    val inserted: String,
    val selectionBefore: TextRange,
    val selectionAfter: TextRange,
    val timestampMillis: Long,
) {
    val storedCharacterCount: Int
        get() = removed.length + inserted.length
}

/**
 * Bounded incremental undo history. Only changed slices are retained, rather than full copies of
 * potentially multi-megabyte routing files.
 */
internal class EditorHistory(
    private val maxEntries: Int = 100,
    private val maxStoredCharacters: Int = 1_000_000,
) {
    private val undo = ArrayDeque<EditorMutation>()
    private val redo = ArrayDeque<EditorMutation>()
    private var storedCharacters = 0

    val canUndo: Boolean
        get() = undo.isNotEmpty()

    val canRedo: Boolean
        get() = redo.isNotEmpty()

    fun record(
        before: TextFieldValue,
        after: TextFieldValue,
        timestampMillis: Long = System.nanoTime() / 1_000_000,
    ) {
        if (before.text == after.text) return
        clearRedo()
        val mutation = buildEditorMutation(before, after, timestampMillis)
        if (mutation.storedCharacterCount > maxStoredCharacters) {
            clear()
            return
        }

        val previous = undo.peekLast()
        val merged = previous?.let { mergeEditorMutations(it, mutation) }
        if (merged != null) {
            undo.removeLast()
            storedCharacters -= previous.storedCharacterCount
            undo.addLast(merged)
            storedCharacters += merged.storedCharacterCount
        } else {
            undo.addLast(mutation)
            storedCharacters += mutation.storedCharacterCount
        }
        trim()
    }

    fun undo(current: TextFieldValue): TextFieldValue? {
        val mutation = undo.peekLast() ?: return null
        val updated = applyMutation(
            current = current,
            start = mutation.start,
            expected = mutation.inserted,
            replacement = mutation.removed,
            selection = mutation.selectionBefore,
        ) ?: return null
        undo.removeLast()
        redo.addLast(mutation)
        return updated
    }

    fun redo(current: TextFieldValue): TextFieldValue? {
        val mutation = redo.peekLast() ?: return null
        val updated = applyMutation(
            current = current,
            start = mutation.start,
            expected = mutation.removed,
            replacement = mutation.inserted,
            selection = mutation.selectionAfter,
        ) ?: return null
        redo.removeLast()
        undo.addLast(mutation)
        return updated
    }

    fun clear() {
        undo.clear()
        redo.clear()
        storedCharacters = 0
    }

    private fun clearRedo() {
        while (redo.isNotEmpty()) {
            storedCharacters -= redo.removeLast().storedCharacterCount
        }
    }

    private fun trim() {
        while (undo.size > maxEntries || storedCharacters > maxStoredCharacters) {
            storedCharacters -= undo.removeFirst().storedCharacterCount
        }
    }
}

internal fun selectEditorLine(
    value: TextFieldValue,
    index: EditorDocumentIndex = EditorDocumentIndex.build(value.text),
): TextFieldValue = value.copy(selection = index.lineRangeAt(value.text, value.selection.end))

internal fun duplicateEditorLine(
    value: TextFieldValue,
    index: EditorDocumentIndex = EditorDocumentIndex.build(value.text),
): TextFieldValue {
    val currentRange = index.lineRangeAt(value.text, value.selection.end)
    val currentLine = index.cursorAt(value.selection.end).line
    return if (currentLine < index.lineCount) {
        val insertionOffset = index.offsetForLine(currentLine + 1)
        val lineWithBreak = value.text.substring(currentRange.start, insertionOffset)
        val updatedText = value.text.replaceRange(insertionOffset, insertionOffset, lineWithBreak)
        value.copy(
            text = updatedText,
            selection = TextRange(
                insertionOffset,
                insertionOffset + currentRange.length,
            ),
            composition = null,
        )
    } else {
        val line = value.text.substring(currentRange.start, currentRange.end)
        val separator = when {
            value.text.isEmpty() -> ""
            value.text.contains("\r\n") -> "\r\n"
            else -> "\n"
        }
        val insertionOffset = value.text.length
        val updatedText = value.text + separator + line
        val duplicateStart = insertionOffset + separator.length
        value.copy(
            text = updatedText,
            selection = TextRange(duplicateStart, duplicateStart + line.length),
            composition = null,
        )
    }
}

private fun buildEditorMutation(
    before: TextFieldValue,
    after: TextFieldValue,
    timestampMillis: Long,
): EditorMutation {
    val prefixLimit = minOf(before.text.length, after.text.length)
    var prefix = 0
    while (prefix < prefixLimit && before.text[prefix] == after.text[prefix]) prefix += 1

    val suffixLimit = minOf(before.text.length - prefix, after.text.length - prefix)
    var suffix = 0
    while (
        suffix < suffixLimit &&
        before.text[before.text.lastIndex - suffix] == after.text[after.text.lastIndex - suffix]
    ) {
        suffix += 1
    }

    return EditorMutation(
        start = prefix,
        removed = before.text.substring(prefix, before.text.length - suffix),
        inserted = after.text.substring(prefix, after.text.length - suffix),
        selectionBefore = before.selection,
        selectionAfter = after.selection,
        timestampMillis = timestampMillis,
    )
}

private fun mergeEditorMutations(
    previous: EditorMutation,
    current: EditorMutation,
): EditorMutation? {
    if (current.timestampMillis - previous.timestampMillis !in 0..1_200) return null
    val hasLineBreak = previous.inserted.contains('\n') || current.inserted.contains('\n') ||
        previous.removed.contains('\n') || current.removed.contains('\n')
    if (hasLineBreak) return null

    return when {
        previous.removed.isEmpty() &&
            current.removed.isEmpty() &&
            current.start == previous.start + previous.inserted.length -> previous.copy(
                inserted = previous.inserted + current.inserted,
                selectionAfter = current.selectionAfter,
                timestampMillis = current.timestampMillis,
            )

        previous.inserted.isEmpty() &&
            current.inserted.isEmpty() &&
            current.start + current.removed.length == previous.start -> current.copy(
                removed = current.removed + previous.removed,
                selectionBefore = previous.selectionBefore,
            )

        previous.inserted.isEmpty() &&
            current.inserted.isEmpty() &&
            current.start == previous.start -> previous.copy(
                removed = previous.removed + current.removed,
                selectionAfter = current.selectionAfter,
                timestampMillis = current.timestampMillis,
            )

        else -> null
    }
}

private fun applyMutation(
    current: TextFieldValue,
    start: Int,
    expected: String,
    replacement: String,
    selection: TextRange,
): TextFieldValue? {
    val end = start + expected.length
    if (start !in 0..current.text.length || end > current.text.length) return null
    if (!current.text.regionMatches(start, expected, 0, expected.length)) return null
    val updatedText = current.text.replaceRange(start, end, replacement)
    return current.copy(
        text = updatedText,
        selection = TextRange(
            selection.start.coerceIn(0, updatedText.length),
            selection.end.coerceIn(0, updatedText.length),
        ),
        composition = null,
    )
}
