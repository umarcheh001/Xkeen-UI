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
    val selectionLength: Int = 0,
    val canUndo: Boolean = false,
    val canRedo: Boolean = false,
)

internal data class EditorTextSearchResult(
    val matchCount: Int = 0,
    val selectedMatch: Int? = null,
    val range: TextRange? = null,
)

/**
 * Returns the one-based lines in [current] that differ from [baseline]. Inserted and replaced
 * lines are highlighted directly. A deletion has no text range of its own, so it marks the next
 * remaining line (or the previous line when content was removed from the end of the document).
 *
 * Small changed blocks use an exact LCS. Large blocks use patience-diff anchors first, which keeps
 * recomputing the markers after typing linear for the large, mostly unchanged config files this
 * editor is designed to handle.
 */
internal fun editorChangedLineRanges(
    baseline: String,
    current: String,
): List<IntRange> {
    if (baseline == current) return emptyList()

    val baselineLines = editorLineFingerprints(baseline)
    val currentLines = editorLineFingerprints(current)
    val baselineForCurrent = IntArray(currentLines.size) { UnmatchedEditorLine }

    matchEditorLineBlock(
        baseline = baselineLines,
        current = currentLines,
        baselineStart = 0,
        baselineEnd = baselineLines.size,
        currentStart = 0,
        currentEnd = currentLines.size,
        baselineForCurrent = baselineForCurrent,
        depth = 0,
    )

    val changed = BooleanArray(currentLines.size) { index ->
        baselineForCurrent[index] == UnmatchedEditorLine
    }

    var previousBaseline = -1
    var previousCurrent = -1
    baselineForCurrent.forEachIndexed { currentIndex, baselineIndex ->
        if (baselineIndex == UnmatchedEditorLine) return@forEachIndexed
        // Adjacent current matches with a gap in the baseline mean that one or more lines were
        // deleted. Mark the line immediately after that deletion.
        if (
            baselineIndex > previousBaseline + 1 &&
            currentIndex == previousCurrent + 1
        ) {
            changed[currentIndex] = true
        }
        previousBaseline = baselineIndex
        previousCurrent = currentIndex
    }
    if (
        previousBaseline < baselineLines.lastIndex &&
        previousCurrent == currentLines.lastIndex &&
        previousCurrent >= 0
    ) {
        changed[previousCurrent] = true
    }

    return changed.toEditorLineRanges()
}

private fun editorLineFingerprints(source: String): LongArray {
    val result = LongArray(source.count { it == '\n' } + 1)
    var line = 0
    var hash = EditorLineHashSeed
    var length = 0
    source.forEach { char ->
        if (char == '\n') {
            result[line++] = hash xor length.toLong()
            hash = EditorLineHashSeed
            length = 0
        } else {
            hash = hash * EditorLineHashMultiplier + char.code
            length += 1
        }
    }
    result[line] = hash xor length.toLong()
    return result
}

private fun matchEditorLineBlock(
    baseline: LongArray,
    current: LongArray,
    baselineStart: Int,
    baselineEnd: Int,
    currentStart: Int,
    currentEnd: Int,
    baselineForCurrent: IntArray,
    depth: Int,
) {
    var leftBaseline = baselineStart
    var leftCurrent = currentStart
    while (
        leftBaseline < baselineEnd &&
        leftCurrent < currentEnd &&
        baseline[leftBaseline] == current[leftCurrent]
    ) {
        baselineForCurrent[leftCurrent] = leftBaseline
        leftBaseline += 1
        leftCurrent += 1
    }

    var rightBaseline = baselineEnd
    var rightCurrent = currentEnd
    while (
        rightBaseline > leftBaseline &&
        rightCurrent > leftCurrent &&
        baseline[rightBaseline - 1] == current[rightCurrent - 1]
    ) {
        rightBaseline -= 1
        rightCurrent -= 1
        baselineForCurrent[rightCurrent] = rightBaseline
    }

    val baselineCount = rightBaseline - leftBaseline
    val currentCount = rightCurrent - leftCurrent
    if (baselineCount == 0 || currentCount == 0) return

    if (baselineCount.toLong() * currentCount <= MaxExactEditorDiffCells) {
        matchSmallEditorLineBlock(
            baseline = baseline,
            current = current,
            baselineStart = leftBaseline,
            baselineEnd = rightBaseline,
            currentStart = leftCurrent,
            currentEnd = rightCurrent,
            baselineForCurrent = baselineForCurrent,
        )
        return
    }
    if (depth >= MaxEditorDiffAnchorDepth) return

    val anchors = editorPatienceAnchors(
        baseline = baseline,
        current = current,
        baselineStart = leftBaseline,
        baselineEnd = rightBaseline,
        currentStart = leftCurrent,
        currentEnd = rightCurrent,
    )
    if (anchors.isEmpty()) return

    var nextBaseline = leftBaseline
    var nextCurrent = leftCurrent
    anchors.forEach { anchor ->
        matchEditorLineBlock(
            baseline = baseline,
            current = current,
            baselineStart = nextBaseline,
            baselineEnd = anchor.baseline,
            currentStart = nextCurrent,
            currentEnd = anchor.current,
            baselineForCurrent = baselineForCurrent,
            depth = depth + 1,
        )
        baselineForCurrent[anchor.current] = anchor.baseline
        nextBaseline = anchor.baseline + 1
        nextCurrent = anchor.current + 1
    }
    matchEditorLineBlock(
        baseline = baseline,
        current = current,
        baselineStart = nextBaseline,
        baselineEnd = rightBaseline,
        currentStart = nextCurrent,
        currentEnd = rightCurrent,
        baselineForCurrent = baselineForCurrent,
        depth = depth + 1,
    )
}

private fun matchSmallEditorLineBlock(
    baseline: LongArray,
    current: LongArray,
    baselineStart: Int,
    baselineEnd: Int,
    currentStart: Int,
    currentEnd: Int,
    baselineForCurrent: IntArray,
) {
    val baselineCount = baselineEnd - baselineStart
    val currentCount = currentEnd - currentStart
    val columns = currentCount + 1
    val lengths = IntArray((baselineCount + 1) * columns)

    for (baselineOffset in 1..baselineCount) {
        for (currentOffset in 1..currentCount) {
            val cell = baselineOffset * columns + currentOffset
            lengths[cell] = if (
                baseline[baselineStart + baselineOffset - 1] ==
                current[currentStart + currentOffset - 1]
            ) {
                lengths[(baselineOffset - 1) * columns + currentOffset - 1] + 1
            } else {
                maxOf(
                    lengths[(baselineOffset - 1) * columns + currentOffset],
                    lengths[baselineOffset * columns + currentOffset - 1],
                )
            }
        }
    }

    var baselineOffset = baselineCount
    var currentOffset = currentCount
    while (baselineOffset > 0 && currentOffset > 0) {
        if (
            baseline[baselineStart + baselineOffset - 1] ==
            current[currentStart + currentOffset - 1]
        ) {
            baselineForCurrent[currentStart + currentOffset - 1] =
                baselineStart + baselineOffset - 1
            baselineOffset -= 1
            currentOffset -= 1
        } else if (
            lengths[(baselineOffset - 1) * columns + currentOffset] >=
            lengths[baselineOffset * columns + currentOffset - 1]
        ) {
            baselineOffset -= 1
        } else {
            currentOffset -= 1
        }
    }
}

private fun editorPatienceAnchors(
    baseline: LongArray,
    current: LongArray,
    baselineStart: Int,
    baselineEnd: Int,
    currentStart: Int,
    currentEnd: Int,
): List<EditorLineAnchor> {
    val uniqueBaseline = uniqueEditorLinePositions(baseline, baselineStart, baselineEnd)
    val uniqueCurrent = uniqueEditorLinePositions(current, currentStart, currentEnd)
    val candidates = buildList {
        for (baselineIndex in baselineStart until baselineEnd) {
            val fingerprint = baseline[baselineIndex]
            if (uniqueBaseline[fingerprint] != baselineIndex) continue
            val currentIndex = uniqueCurrent[fingerprint] ?: continue
            if (currentIndex != DuplicateEditorLine) {
                add(EditorLineAnchor(baselineIndex, currentIndex))
            }
        }
    }
    if (candidates.isEmpty()) return emptyList()

    val tailCurrent = IntArray(candidates.size)
    val tailCandidate = IntArray(candidates.size)
    val predecessor = IntArray(candidates.size) { -1 }
    var size = 0
    candidates.forEachIndexed { candidateIndex, candidate ->
        var low = 0
        var high = size
        while (low < high) {
            val middle = (low + high) ushr 1
            if (tailCurrent[middle] < candidate.current) low = middle + 1 else high = middle
        }
        if (low > 0) predecessor[candidateIndex] = tailCandidate[low - 1]
        tailCurrent[low] = candidate.current
        tailCandidate[low] = candidateIndex
        if (low == size) size += 1
    }

    val result = ArrayList<EditorLineAnchor>(size)
    var candidateIndex = tailCandidate[size - 1]
    repeat(size) {
        result += candidates[candidateIndex]
        candidateIndex = predecessor[candidateIndex]
    }
    result.reverse()
    return result
}

private fun uniqueEditorLinePositions(
    lines: LongArray,
    start: Int,
    end: Int,
): Map<Long, Int> {
    val positions = HashMap<Long, Int>((end - start).coerceAtLeast(1))
    for (index in start until end) {
        val fingerprint = lines[index]
        positions[fingerprint] = if (positions.containsKey(fingerprint)) {
            DuplicateEditorLine
        } else {
            index
        }
    }
    return positions
}

private fun BooleanArray.toEditorLineRanges(): List<IntRange> = buildList {
    var start = -1
    for (index in this@toEditorLineRanges.indices) {
        if (this@toEditorLineRanges[index] && start < 0) start = index
        val closesRange = start >= 0 && (
            !this@toEditorLineRanges[index] || index == this@toEditorLineRanges.lastIndex
        )
        if (closesRange) {
            val end = if (this@toEditorLineRanges[index]) index else index - 1
            add((start + 1)..(end + 1))
            start = -1
        }
    }
}

private data class EditorLineAnchor(
    val baseline: Int,
    val current: Int,
)

private const val UnmatchedEditorLine = -1
private const val DuplicateEditorLine = -1
private const val MaxExactEditorDiffCells = 16_384L
private const val MaxEditorDiffAnchorDepth = 32
private const val EditorLineHashSeed = 1_125_899_906_842_597L
private const val EditorLineHashMultiplier = 31L

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
