package io.xkeen.mobile.app

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ContentCut
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.xkeen.mobile.ui.theme.WebPanelPalette

private const val EditorToolbarPreferencesName = "xkeen_editor_toolbar_layout"
private const val MinDocumentTitleWidthDp = 72f
private const val MaxDocumentTitleWidthDp = 260f
private const val DefaultDocumentTitleWidthDp = 164f
private const val DocumentCounterWidthThresholdDp = 132f

internal enum class EditorToolbarLayoutId(
    val storageKey: String,
) {
    XrayRouting("xray_routing"),
    MihomoConfig("mihomo_config"),
    Ports("ports"),
}

internal data class EditorToolbarLayout(
    val titleWidthDp: Float = DefaultDocumentTitleWidthDp,
    val scrollOffsetPx: Int = 0,
) {
    fun normalized(): EditorToolbarLayout = copy(
        titleWidthDp = titleWidthDp
            .takeIf(Float::isFinite)
            ?.coerceIn(MinDocumentTitleWidthDp, MaxDocumentTitleWidthDp)
            ?: DefaultDocumentTitleWidthDp,
        scrollOffsetPx = scrollOffsetPx.coerceAtLeast(0),
    )
}

private class EditorToolbarLayoutStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        EditorToolbarPreferencesName,
        Context.MODE_PRIVATE,
    )

    fun read(layoutId: EditorToolbarLayoutId): EditorToolbarLayout = EditorToolbarLayout(
        titleWidthDp = preferences.getFloat(
            "${layoutId.storageKey}_title_width_dp",
            DefaultDocumentTitleWidthDp,
        ),
        scrollOffsetPx = preferences.getInt("${layoutId.storageKey}_scroll_offset_px", 0),
    ).normalized()

    fun write(layoutId: EditorToolbarLayoutId, layout: EditorToolbarLayout) {
        val normalized = layout.normalized()
        preferences.edit()
            .putFloat("${layoutId.storageKey}_title_width_dp", normalized.titleWidthDp)
            .putInt("${layoutId.storageKey}_scroll_offset_px", normalized.scrollOffsetPx)
            .apply()
    }
}

@Composable
internal fun RowScope.PersistentEditorToolbarContent(
    layoutId: EditorToolbarLayoutId,
    title: String,
    detail: String,
    onTitleClick: (() -> Unit)?,
    titleEnabled: Boolean = true,
    editor: AdvancedJsonEditorView?,
    editorMetrics: EditorMetrics,
    editorActionsEnabled: Boolean,
    searchDescription: String,
    onSearchClick: () -> Unit,
    searchEnabled: Boolean,
    trailingActions: @Composable RowScope.() -> Unit,
) {
    val context = LocalContext.current.applicationContext
    val store = remember(context) { EditorToolbarLayoutStore(context) }
    val initialLayout = remember(layoutId) { store.read(layoutId) }
    val density = LocalDensity.current
    val hapticFeedback = LocalHapticFeedback.current
    var titleWidthDp by rememberSaveable(layoutId.storageKey) {
        mutableFloatStateOf(initialLayout.titleWidthDp)
    }
    val toolbarScrollState = rememberScrollState(initial = initialLayout.scrollOffsetPx)
    val latestTitleWidth by rememberUpdatedState(titleWidthDp)

    fun persistLayout() {
        store.write(
            layoutId,
            EditorToolbarLayout(
                titleWidthDp = titleWidthDp,
                scrollOffsetPx = toolbarScrollState.value,
            ),
        )
    }

    LaunchedEffect(layoutId, toolbarScrollState) {
        snapshotFlow {
            if (toolbarScrollState.isScrollInProgress) null else toolbarScrollState.value
        }.collect { scrollOffset ->
            if (scrollOffset != null) {
                store.write(
                    layoutId,
                    EditorToolbarLayout(
                        titleWidthDp = titleWidthDp,
                        scrollOffsetPx = scrollOffset,
                    ),
                )
            }
        }
    }
    DisposableEffect(layoutId, toolbarScrollState) {
        onDispose {
            store.write(
                layoutId,
                EditorToolbarLayout(
                    titleWidthDp = latestTitleWidth,
                    scrollOffsetPx = toolbarScrollState.value,
                ),
            )
        }
    }

    val searchResizeModifier = Modifier.pointerInput(layoutId, density.density) {
        detectDragGesturesAfterLongPress(
            onDragStart = {
                hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
            },
            onDragEnd = ::persistLayout,
            onDragCancel = ::persistLayout,
            onDrag = { change, dragAmount ->
                change.consume()
                titleWidthDp = resizedDocumentTitleWidth(
                    currentWidthDp = titleWidthDp,
                    dragDeltaPx = dragAmount.x,
                    density = density.density,
                )
            },
        )
    }
    val titleClickModifier = if (onTitleClick != null) {
        Modifier.clickable(enabled = titleEnabled, onClick = onTitleClick)
    } else {
        Modifier
    }
    val detailText = when {
        titleWidthDp >= DocumentCounterWidthThresholdDp && detail.isNotBlank() -> {
            "  $detail${if (onTitleClick != null) "  ▾" else ""}"
        }
        onTitleClick != null -> "  ▾"
        else -> ""
    }

    Row(
        modifier = Modifier
            .width(titleWidthDp.dp)
            .fillMaxHeight()
            .then(titleClickModifier)
            .padding(start = 9.dp, end = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            modifier = Modifier.weight(1f),
            color = if (titleEnabled) WebPanelPalette.TextStrong else WebPanelPalette.Muted,
            style = androidx.compose.material3.MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (detailText.isNotEmpty()) {
            Text(
                text = detailText,
                color = WebPanelPalette.Muted,
                style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
                maxLines = 1,
            )
        }
    }
    Row(
        modifier = Modifier
            .weight(1f)
            .fillMaxHeight()
            .horizontalScroll(toolbarScrollState),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        EditorToolbarButton(
            icon = Icons.Outlined.Search,
            description = "$searchDescription; удерживайте и тяните, чтобы изменить ширину имени",
            onClick = onSearchClick,
            enabled = searchEnabled,
            modifier = searchResizeModifier,
        )
        EditorToolbarButton(
            icon = Icons.Outlined.ContentCut,
            description = "Вырезать выделение",
            onClick = { editor?.cutSelection() },
            enabled = editorActionsEnabled && editor != null && editorMetrics.selectionLength > 0,
        )
        EditorToolbarButton(
            icon = Icons.Outlined.ContentCopy,
            description = "Копировать выделение",
            onClick = { editor?.copySelection() },
            enabled = editorActionsEnabled && editor != null && editorMetrics.selectionLength > 0,
        )
        EditorToolbarButton(
            icon = Icons.Outlined.ContentPaste,
            description = "Вставить из буфера",
            onClick = { editor?.pasteClipboard() },
            enabled = editorActionsEnabled && editor != null,
        )
        EditorToolbarButton(
            icon = Icons.AutoMirrored.Outlined.Undo,
            description = "Отменить изменение",
            onClick = { editor?.undo() },
            enabled = editorActionsEnabled && editor != null && editorMetrics.canUndo,
        )
        EditorToolbarButton(
            icon = Icons.AutoMirrored.Outlined.Redo,
            description = "Вернуть изменение",
            onClick = { editor?.redo() },
            enabled = editorActionsEnabled && editor != null && editorMetrics.canRedo,
        )
        trailingActions()
        Spacer(Modifier.size(2.dp))
    }
}

internal fun resizedDocumentTitleWidth(
    currentWidthDp: Float,
    dragDeltaPx: Float,
    density: Float,
): Float = (currentWidthDp + dragDeltaPx / density.coerceAtLeast(0.1f))
    .coerceIn(MinDocumentTitleWidthDp, MaxDocumentTitleWidthDp)
