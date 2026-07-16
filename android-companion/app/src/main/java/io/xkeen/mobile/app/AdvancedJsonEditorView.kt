package io.xkeen.mobile.app

import android.animation.ValueAnimator
import android.app.SearchManager
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.Layout
import android.text.Spannable
import android.text.TextWatcher
import android.text.style.ForegroundColorSpan
import android.text.style.TabStopSpan
import android.util.AttributeSet
import android.util.TypedValue
import android.view.ActionMode
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.VelocityTracker
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.OverScroller
import android.widget.TextView
import android.widget.Toast
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Native text surface used inside the Compose workspace. Android's EditText owns scrolling,
 * double-tap word selection, long-press handles and IME integration; the surrounding views keep
 * the existing Xkeen gutter, palette and fast navigation for very large JSON/JSONC documents.
 */
internal class AdvancedJsonEditorView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : FrameLayout(context, attrs) {
    private var gutterWidth = context.dp(MinGutterWidthDp)
    private val fastScrollerWidth = context.dp(24f)
    private val editor = SelectionAwareEditText(context)
    private val gutter = EditorGutterView(context, editor)
    private val fastScroller = NativeEditorFastScroller(context, editor)
    private val syntaxSpans = mutableListOf<ForegroundColorSpan>()
    private val tabStopSpans = mutableListOf<TabStopSpan.Standard>()
    private var documentIndex = EditorDocumentIndex.build("")
    private var suppressCallbacks = false
    private var lastKnownText = ""
    private val highlightRunnable = Runnable(::applySyntaxHighlight)

    var onTextChanged: (String) -> Unit = {}
    var onMetricsChanged: (EditorMetrics) -> Unit = {}
    var onRequestGoToLine: (currentLine: Int, totalLines: Int) -> Unit = { _, _ -> }

    init {
        setWillNotDraw(false)
        setBackgroundColor(JsonEditorPalette.Background.toArgb())
        configureEditor()

        addView(
            editor,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
                marginStart = gutterWidth
            },
        )
        addView(
            gutter,
            LayoutParams(gutterWidth, LayoutParams.MATCH_PARENT).apply {
                gravity = Gravity.START
            },
        )
        addView(
            fastScroller,
            LayoutParams(fastScrollerWidth, LayoutParams.MATCH_PARENT).apply {
                gravity = Gravity.END
            },
        )

        editor.onSelectionChangedListener = {
            notifyMetrics()
            gutter.invalidate()
            invalidate()
        }
        editor.onEditorScrollChanged = {
            gutter.invalidate()
            fastScroller.invalidate()
            invalidate()
            if (usesViewportSyntaxHighlighting()) {
                scheduleSyntaxHighlight(delayMillis = VisibleSyntaxHighlightDelayMillis)
            }
        }
        gutter.setOnClickListener { requestGoToLine() }
        installTextWatcher()
        installActionMode()
    }

    fun setDocumentText(value: String) {
        if (value === lastKnownText || value == lastKnownText) return
        applyValue(
            value = TextFieldValue(
                text = value,
                selection = TextRange(editor.selectionStart.coerceIn(0, value.length)),
            ),
            notifyTextChanged = false,
        )
    }

    fun goToLine(line: Int) {
        val safeLine = line.coerceIn(1, documentIndex.lineCount)
        val offset = documentIndex.offsetForLine(safeLine)
        editor.requestFocus()
        editor.setSelection(offset)
        editor.post {
            val layout = editor.layout ?: return@post
            val visualLine = layout.getLineForOffset(offset)
            editor.smoothScrollToY(layout.getLineTop(visualLine))
        }
    }

    override fun dispatchDraw(canvas: Canvas) {
        super.dispatchDraw(canvas)
        val layout = editor.layout
        if (layout != null && editor.selectionStart >= 0) {
            val line = layout.getLineForOffset(editor.selectionStart.coerceAtMost(editor.text.length))
            val y = editor.top + editor.totalPaddingTop + layout.getLineBottom(line) - editor.scrollY
            currentLinePaint.color = JsonEditorPalette.Cursor.copy(alpha = 0.48f).toArgb()
            canvas.drawRect(
                gutterWidth.toFloat(),
                (y - context.dp(1f)).toFloat(),
                width.toFloat(),
                y.toFloat(),
                currentLinePaint,
            )
        }
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(highlightRunnable)
        super.onDetachedFromWindow()
    }

    private fun configureEditor() {
        editor.apply {
            setBackgroundColor(JsonEditorPalette.Background.toArgb())
            setTextColor(JsonEditorPalette.Foreground.toArgb())
            highlightColor = JsonEditorPalette.Selection.backgroundColor.toArgb()
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, EditorTextSizeSp)
            includeFontPadding = false
            gravity = Gravity.TOP or Gravity.START
            setPadding(
                context.dp(2f),
                context.dp(2f),
                fastScrollerWidth + context.dp(2f),
                context.dp(2f),
            )
            inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setSingleLine(false)
            setHorizontallyScrolling(false)
            isHorizontalScrollBarEnabled = false
            breakStrategy = Layout.BREAK_STRATEGY_SIMPLE
            hyphenationFrequency = Layout.HYPHENATION_FREQUENCY_NONE
            isVerticalScrollBarEnabled = false
            scrollBarStyle = View.SCROLLBARS_INSIDE_OVERLAY
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
            setSelectAllOnFocus(false)
            isSaveEnabled = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS

            val wantedLineHeight = context.sp(EditorLineHeightSp)
            val naturalLineHeight = paint.fontMetricsInt.run { bottom - top }
            setLineSpacing((wantedLineHeight - naturalLineHeight).coerceAtLeast(0f), 1f)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                textCursorDrawable = GradientDrawable().apply {
                    setColor(JsonEditorPalette.Cursor.toArgb())
                    setSize(context.dp(2f), 0)
                }
            }
        }
    }

    private fun installTextWatcher() {
        editor.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(
                source: CharSequence?,
                start: Int,
                count: Int,
                after: Int,
            ) = Unit

            override fun onTextChanged(
                source: CharSequence?,
                start: Int,
                before: Int,
                count: Int,
            ) = Unit

            override fun afterTextChanged(editable: Editable?) {
                if (suppressCallbacks || editable == null) return
                val updatedText = editable.toString()
                val updated = TextFieldValue(
                    text = updatedText,
                    selection = TextRange(
                        editor.selectionStart.coerceIn(0, updatedText.length),
                        editor.selectionEnd.coerceIn(0, updatedText.length),
                    ),
                )
                lastKnownText = updatedText
                updateDocumentIndex(updatedText)
                ensureCompactTabStops(editable)
                onTextChanged(updatedText)
                notifyMetrics()
                scheduleSyntaxHighlight(delayMillis = SyntaxHighlightDelayMillis)
            }
        })
    }

    private fun installActionMode() {
        val callback = object : ActionMode.Callback {
            override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean {
                if (menu == null) return true
                // EditText already contributes Android's own Undo/Redo actions. Adding our own
                // versions here produced two indistinguishable “Отменить” items in this menu.
                menu.addEditorAction(EditorMenuSelectLine, "Выделить строку")
                menu.addEditorAction(EditorMenuDuplicateLine, "Дублировать строку")
                menu.addEditorAction(EditorMenuGoToLine, "Перейти к строке…")
                menu.addEditorAction(EditorMenuSearchWeb, "Поиск в интернете")
                return true
            }

            override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean = false

            override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?): Boolean {
                val handled = when (item?.itemId) {
                    EditorMenuSelectLine -> selectLine()
                    EditorMenuDuplicateLine -> duplicateLine()
                    EditorMenuGoToLine -> {
                        requestGoToLine()
                        true
                    }
                    EditorMenuSearchWeb -> searchOnWeb()
                    else -> false
                }
                if (handled) mode?.finish()
                return handled
            }

            override fun onDestroyActionMode(mode: ActionMode?) = Unit
        }
        editor.customSelectionActionModeCallback = callback
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            editor.customInsertionActionModeCallback = callback
        }
    }

    private fun selectLine(): Boolean {
        val selected = selectEditorLine(editor.currentValue(), documentIndex)
        editor.setSelection(selected.selection.start, selected.selection.end)
        return true
    }

    private fun duplicateLine(): Boolean {
        val before = editor.currentValue()
        val updated = duplicateEditorLine(before, documentIndex)
        if (updated.text == before.text) return false
        applyValue(updated, notifyTextChanged = true)
        return true
    }

    private fun searchOnWeb(): Boolean {
        val query = editorInternetSearchQuery(
            source = editor.text?.toString().orEmpty(),
            selectionStart = editor.selectionStart,
            selectionEnd = editor.selectionEnd,
        )
        if (query.isBlank()) {
            Toast.makeText(
                context,
                "Выделите текст или установите курсор на слово для поиска.",
                Toast.LENGTH_SHORT,
            ).show()
            return true
        }
        val intent = Intent(Intent.ACTION_WEB_SEARCH).putExtra(SearchManager.QUERY, query)
        if (intent.resolveActivity(context.packageManager) == null) {
            Toast.makeText(context, "На устройстве нет приложения для интернет-поиска.", Toast.LENGTH_SHORT).show()
            return true
        }
        context.startActivity(intent)
        return true
    }

    private fun requestGoToLine() {
        val currentLine = documentIndex.cursorAt(editor.selectionEnd.coerceAtLeast(0)).line
        onRequestGoToLine(currentLine, documentIndex.lineCount)
    }

    private fun applyValue(value: TextFieldValue, notifyTextChanged: Boolean) {
        val scrollY = editor.scrollY
        suppressCallbacks = true
        try {
            tabStopSpans.clear()
            editor.setText(value.text, TextView.BufferType.EDITABLE)
            ensureCompactTabStops(editor.editableText)
            editor.setSelection(
                value.selection.start.coerceIn(0, value.text.length),
                value.selection.end.coerceIn(0, value.text.length),
            )
        } finally {
            suppressCallbacks = false
        }
        lastKnownText = value.text
        updateDocumentIndex(value.text)
        editor.post { editor.scrollTo(0, scrollY) }
        if (notifyTextChanged) onTextChanged(value.text)
        notifyMetrics()
        scheduleSyntaxHighlight(delayMillis = 0L)
    }

    private fun notifyMetrics() {
        onMetricsChanged(documentIndex.metricsAt(editor.selectionEnd.coerceAtLeast(0)))
    }

    private fun updateDocumentIndex(source: String) {
        documentIndex = EditorDocumentIndex.build(source)
        gutter.documentIndex = documentIndex
        val wantedWidth = gutter.requiredWidth()
        if (wantedWidth == gutterWidth) return
        gutterWidth = wantedWidth
        (editor.layoutParams as? LayoutParams)?.let { params ->
            params.marginStart = wantedWidth
            editor.layoutParams = params
        }
        (gutter.layoutParams as? LayoutParams)?.let { params ->
            params.width = wantedWidth
            gutter.layoutParams = params
        }
        requestLayout()
    }

    private fun ensureCompactTabStops(editable: Editable?) {
        if (editable == null || editable.isEmpty() || tabStopSpans.isNotEmpty()) return
        val tabWidth = editor.paint.measureText(" ").roundToInt().coerceAtLeast(1)
        repeat(MaxCompactTabStops) { index ->
            val span = TabStopSpan.Standard(tabWidth * (index + 1))
            tabStopSpans += span
            editable.setSpan(
                span,
                0,
                editable.length,
                Spannable.SPAN_INCLUSIVE_INCLUSIVE,
            )
        }
    }

    private fun scheduleSyntaxHighlight(delayMillis: Long) {
        removeCallbacks(highlightRunnable)
        postDelayed(highlightRunnable, delayMillis)
    }

    private fun applySyntaxHighlight() {
        val editable = editor.editableText ?: return
        syntaxSpans.forEach(editable::removeSpan)
        syntaxSpans.clear()
        val source = lastKnownText.takeIf { it.length == editable.length } ?: editable.toString()
        val highlightRange = if (usesViewportSyntaxHighlighting()) {
            visibleHighlightRange() ?: run {
                scheduleSyntaxHighlight(delayMillis = VisibleSyntaxHighlightDelayMillis)
                return
            }
        } else {
            0..source.length
        }

        val highlighted = highlightJsonc(source.substring(highlightRange.first, highlightRange.last))
        editor.beginBatchEdit()
        try {
            highlighted.spanStyles.forEach { range ->
                val start = highlightRange.first + range.start
                val end = highlightRange.first + range.end
                if (start >= end || end > editable.length) return@forEach
                val color = range.item.color
                    .takeIf { it != androidx.compose.ui.graphics.Color.Unspecified }
                    ?: return@forEach
                val span = ForegroundColorSpan(color.toArgb())
                syntaxSpans += span
                editable.setSpan(
                    span,
                    start,
                    end,
                    Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            }
        } finally {
            editor.endBatchEdit()
        }
    }

    private fun usesViewportSyntaxHighlighting(): Boolean =
        lastKnownText.length > MaxFullHighlightCharacters ||
            documentIndex.lineCount > MaxFullHighlightLines

    private fun visibleHighlightRange(): IntRange? {
        val layout = editor.layout ?: return null
        if (layout.lineCount <= 0) return 0..lastKnownText.length
        val firstVisible = layout.getLineForVertical(editor.scrollY.coerceAtLeast(0))
        val lastVisible = layout.getLineForVertical((editor.scrollY + editor.height).coerceAtLeast(0))
        val firstBuffered = (firstVisible - SyntaxHighlightLineBuffer).coerceAtLeast(0)
        val lastBuffered = (lastVisible + SyntaxHighlightLineBuffer)
            .coerceAtMost(layout.lineCount - 1)
        val firstLogicalLine = documentIndex.cursorAt(layout.getLineStart(firstBuffered)).line
        return documentIndex.offsetForLine(firstLogicalLine)..layout.getLineEnd(lastBuffered)
    }

    private companion object {
        const val EditorTextSizeSp = 15f
        const val EditorLineHeightSp = 23f
        const val MinGutterWidthDp = 36f
        const val MaxCompactTabStops = 16
        const val SyntaxHighlightDelayMillis = 220L
        const val VisibleSyntaxHighlightDelayMillis = 90L
        const val SyntaxHighlightLineBuffer = 24
        const val MaxFullHighlightCharacters = 80_000
        const val MaxFullHighlightLines = 3_000
        const val EditorMenuSelectLine = 0x584B03
        const val EditorMenuDuplicateLine = 0x584B04
        const val EditorMenuGoToLine = 0x584B05
        const val EditorMenuSearchWeb = 0x584B06

        val currentLinePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    }
}

internal fun editorInternetSearchQuery(
    source: String,
    selectionStart: Int,
    selectionEnd: Int,
): String {
    val start = minOf(selectionStart, selectionEnd).coerceIn(0, source.length)
    val end = maxOf(selectionStart, selectionEnd).coerceIn(0, source.length)
    if (start != end) return source.substring(start, end).trim()

    var wordStart = start
    while (wordStart > 0 && source[wordStart - 1].isEditorSearchCharacter()) wordStart--
    var wordEnd = end
    while (wordEnd < source.length && source[wordEnd].isEditorSearchCharacter()) wordEnd++
    return source.substring(wordStart, wordEnd).trim()
}

private fun Char.isEditorSearchCharacter(): Boolean =
    isLetterOrDigit() || this in setOf('_', '-', '.')

private class SelectionAwareEditText(context: Context) : EditText(context) {
    var onSelectionChangedListener: (() -> Unit)? = null
    var onEditorScrollChanged: (() -> Unit)? = null
    private val flingScroller = OverScroller(context)
    private val minimumFlingVelocity = ViewConfiguration.get(context).scaledMinimumFlingVelocity
    private val maximumFlingVelocity = ViewConfiguration.get(context).scaledMaximumFlingVelocity
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private var touchVelocityTracker: VelocityTracker? = null
    private var touchDownX = 0f
    private var touchDownY = 0f
    private var touchDownTime = 0L

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        onSelectionChangedListener?.invoke()
    }

    override fun onScrollChanged(left: Int, top: Int, oldLeft: Int, oldTop: Int) {
        super.onScrollChanged(left, top, oldLeft, oldTop)
        onEditorScrollChanged?.invoke()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                stopFling()
                touchVelocityTracker?.recycle()
                touchVelocityTracker = VelocityTracker.obtain()
                touchDownX = event.x
                touchDownY = event.y
                touchDownTime = event.eventTime
            }
        }
        touchVelocityTracker?.addMovement(event)
        val handled = super.onTouchEvent(event)
        if (
            event.actionMasked == MotionEvent.ACTION_UP ||
            event.actionMasked == MotionEvent.ACTION_CANCEL
        ) {
            touchVelocityTracker?.let { tracker ->
                tracker.computeCurrentVelocity(1_000, maximumFlingVelocity.toFloat())
                val elapsed = (event.eventTime - touchDownTime).coerceAtLeast(1L)
                val estimatedVelocity = (event.y - touchDownY) / elapsed * 1_000f
                val velocity = tracker.yVelocity.takeIf {
                    kotlin.math.abs(it) >= minimumFlingVelocity
                } ?: estimatedVelocity
                val verticalDistance = kotlin.math.abs(event.y - touchDownY)
                val horizontalDistance = kotlin.math.abs(event.x - touchDownX)
                if (
                    kotlin.math.abs(velocity) >= minimumFlingVelocity &&
                    verticalDistance > touchSlop &&
                    verticalDistance > horizontalDistance
                ) {
                    startVerticalFling(
                        (-velocity).coerceIn(
                            -maximumFlingVelocity.toFloat(),
                            maximumFlingVelocity.toFloat(),
                        ).roundToInt(),
                    )
                }
                tracker.recycle()
            }
            touchVelocityTracker = null
        }
        return handled
    }

    override fun computeScroll() {
        if (flingScroller.computeScrollOffset()) {
            scrollTo(scrollX, flingScroller.currY)
            postInvalidateOnAnimation()
        }
        super.computeScroll()
    }

    fun verticalScrollRange(): Int = computeVerticalScrollRange()

    fun verticalScrollExtent(): Int = computeVerticalScrollExtent()

    fun currentValue(): TextFieldValue {
        val source = text?.toString().orEmpty()
        return TextFieldValue(
            text = source,
            selection = TextRange(
                selectionStart.coerceIn(0, source.length),
                selectionEnd.coerceIn(0, source.length),
            ),
        )
    }

    fun smoothScrollToY(target: Int) {
        stopFling()
        ValueAnimator.ofInt(scrollY, target.coerceAtLeast(0)).apply {
            duration = 240L
            addUpdateListener { animator ->
                scrollTo(0, animator.animatedValue as Int)
            }
            start()
        }
    }

    fun stopFling() {
        if (!flingScroller.isFinished) flingScroller.forceFinished(true)
    }

    private fun startVerticalFling(velocityY: Int) {
        val maxScroll = (verticalScrollRange() - verticalScrollExtent()).coerceAtLeast(0)
        if (maxScroll <= 0) return
        flingScroller.fling(
            0,
            scrollY,
            0,
            velocityY,
            0,
            0,
            0,
            maxScroll,
        )
        postInvalidateOnAnimation()
    }
}

private class EditorGutterView(
    context: Context,
    private val editor: SelectionAwareEditText,
) : View(context) {
    var documentIndex: EditorDocumentIndex = EditorDocumentIndex.build("")
        set(value) {
            field = value
            invalidate()
        }

    private val numberPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = JsonEditorPalette.LineNumber.toArgb()
        textSize = context.sp(15f)
        typeface = Typeface.MONOSPACE
        textAlign = Paint.Align.RIGHT
    }
    private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = JsonEditorPalette.IndentGuide.toArgb()
        strokeWidth = context.dp(1f).toFloat()
    }

    init {
        setBackgroundColor(JsonEditorPalette.Background.toArgb())
        isClickable = true
        contentDescription = "Перейти к строке"
    }

    fun requiredWidth(): Int = max(
        context.dp(36f),
        ceil(numberPaint.measureText(documentIndex.lineCount.toString())).toInt() + context.dp(8f),
    )

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val layout = editor.layout ?: return
        if (layout.lineCount <= 0) return
        val firstVisualLine = layout.getLineForVertical(editor.scrollY.coerceAtLeast(0))
        val lastVisualLine = layout.getLineForVertical((editor.scrollY + height).coerceAtLeast(0))
        val selectedLogicalLine = documentIndex.cursorAt(
            editor.selectionStart.coerceIn(0, editor.text?.length ?: 0),
        ).line
        val right = width - context.dp(4f)

        for (visualLine in firstVisualLine..lastVisualLine) {
            val lineStart = layout.getLineStart(visualLine)
            val logicalLine = documentIndex.cursorAt(lineStart).line
            if (documentIndex.offsetForLine(logicalLine) != lineStart) continue
            numberPaint.color = if (logicalLine == selectedLogicalLine) {
                JsonEditorPalette.Cursor.toArgb()
            } else {
                JsonEditorPalette.LineNumber.toArgb()
            }
            val baseline = editor.totalPaddingTop +
                layout.getLineBaseline(visualLine) -
                editor.scrollY
            canvas.drawText(logicalLine.toString(), right.toFloat(), baseline.toFloat(), numberPaint)
        }
        canvas.drawLine(width - 1f, 0f, width - 1f, height.toFloat(), dividerPaint)
    }
}

private class NativeEditorFastScroller(
    context: Context,
    private val editor: SelectionAwareEditText,
) : View(context) {
    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = JsonEditorPalette.IndentGuide.copy(alpha = 0.72f).toArgb()
    }
    private val thumbPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = JsonEditorPalette.Cursor.copy(alpha = 0.68f).toArgb()
    }
    private var dragging = false

    init {
        isClickable = true
        contentDescription = "Быстрая прокрутка"
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val metrics = scrollMetrics() ?: return
        val centerX = (width - context.dp(2f)).toFloat()
        canvas.drawRoundRect(
            centerX - context.dp(1f).toFloat(),
            0f,
            centerX + context.dp(1f).toFloat(),
            height.toFloat(),
            context.dp(2f).toFloat(),
            context.dp(2f).toFloat(),
            trackPaint,
        )
        thumbPaint.color = JsonEditorPalette.Cursor
            .copy(alpha = if (dragging) 0.96f else 0.68f)
            .toArgb()
        canvas.drawRoundRect(
            width - context.dp(5f).toFloat(),
            metrics.thumbTop,
            width.toFloat(),
            metrics.thumbTop + metrics.thumbHeight,
            context.dp(4f).toFloat(),
            context.dp(4f).toFloat(),
            thumbPaint,
        )
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (scrollMetrics() == null) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragging = true
                parent.requestDisallowInterceptTouchEvent(true)
                editor.stopFling()
                scrollToPointer(event.y)
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                scrollToPointer(event.y)
                return true
            }
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL,
            -> {
                dragging = false
                parent.requestDisallowInterceptTouchEvent(false)
                invalidate()
                performClick()
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun scrollToPointer(pointerY: Float) {
        val metrics = scrollMetrics() ?: return
        val targetFraction = ((pointerY - metrics.thumbHeight / 2f) / metrics.travel)
            .coerceIn(0f, 1f)
        editor.scrollTo(editor.scrollX, (targetFraction * metrics.maxScroll).roundToInt())
        invalidate()
    }

    private fun scrollMetrics(): NativeScrollMetrics? {
        if (height <= 0) return null
        val range = editor.verticalScrollRange()
        val extent = editor.verticalScrollExtent()
        val maxScroll = (range - extent).coerceAtLeast(0)
        if (maxScroll <= 0 || range <= 0) return null
        val thumbHeight = max(context.dp(44f).toFloat(), height * extent.toFloat() / range)
            .coerceAtMost(height.toFloat())
        val travel = (height - thumbHeight).coerceAtLeast(1f)
        val fraction = editor.scrollY.toFloat().div(maxScroll).coerceIn(0f, 1f)
        return NativeScrollMetrics(
            maxScroll = maxScroll,
            thumbHeight = thumbHeight,
            travel = travel,
            thumbTop = travel * fraction,
        )
    }
}

private data class NativeScrollMetrics(
    val maxScroll: Int,
    val thumbHeight: Float,
    val travel: Float,
    val thumbTop: Float,
)

private fun Menu.addEditorAction(id: Int, label: String) {
    if (findItem(id) == null) {
        add(Menu.NONE, id, Menu.NONE, label).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
    }
}

private fun Context.dp(value: Float): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)
        .roundToInt()

private fun Context.sp(value: Float): Float =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)
