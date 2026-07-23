package io.xkeen.mobile.app

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.FullscreenExit
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material.icons.outlined.SettingsBackupRestore
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.launch

@Composable
internal fun PortsWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    isFullscreen: Boolean,
    onFullscreenChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val ports = state.portsEditor
    val document = ports.selectedDocument ?: return
    val scope = rememberCoroutineScope()
    val editorView = remember(document.id) { mutableStateOf<AdvancedJsonEditorView?>(null) }
    val metrics = remember(document.id) { mutableStateOf(EditorMetrics()) }
    val showPicker = rememberSaveable { mutableStateOf(false) }
    val showFind = rememberSaveable(document.id) { mutableStateOf(false) }
    val findQuery = rememberSaveable(document.id) { mutableStateOf("") }
    val findResult = remember(document.id) { mutableStateOf(EditorTextSearchResult()) }
    val confirmSave = rememberSaveable { mutableStateOf(false) }
    val showStatusDetails = rememberSaveable { mutableStateOf(false) }
    val findFocusRequester = remember { FocusRequester() }

    LaunchedEffect(state.dashboard.endpoint, document.id) {
        controller.loadSelectedPortsDocument()
    }
    LaunchedEffect(showFind.value, document.id) {
        if (showFind.value) findFocusRequester.requestFocus()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .imePadding(),
    ) {
        Surface(color = Color.Transparent, shadowElevation = 5.dp) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .background(
                        Brush.verticalGradient(
                            listOf(WebPanelPalette.Surface, WebPanelPalette.BackgroundDeep),
                        ),
                    )
                    .padding(horizontal = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (showFind.value) {
                    SearchToolbarField(
                        value = findQuery.value,
                        onValueChange = { query ->
                            findQuery.value = query
                            findResult.value = editorView.value?.findText(query, true, true)
                                ?: EditorTextSearchResult()
                        },
                        onSearch = {
                            findResult.value = editorView.value?.findText(findQuery.value, true)
                                ?: EditorTextSearchResult()
                        },
                        modifier = Modifier
                            .weight(1f)
                            .focusRequester(findFocusRequester),
                    )
                    if (findQuery.value.isNotBlank()) {
                        Text(
                            text = findResult.value.selectedMatch?.let { "$it/${findResult.value.matchCount}" }
                                ?: "0/${findResult.value.matchCount}",
                            modifier = Modifier.padding(horizontal = 4.dp),
                            color = WebPanelPalette.Muted,
                            style = MaterialTheme.typography.labelSmall,
                            maxLines = 1,
                        )
                    }
                    EditorToolbarButton(
                        Icons.Outlined.KeyboardArrowUp,
                        "Предыдущее совпадение",
                        onClick = {
                            findResult.value = editorView.value?.findText(findQuery.value, false)
                                ?: EditorTextSearchResult()
                        },
                    )
                    EditorToolbarButton(
                        Icons.Outlined.KeyboardArrowDown,
                        "Следующее совпадение",
                        onClick = {
                            findResult.value = editorView.value?.findText(findQuery.value, true)
                                ?: EditorTextSearchResult()
                        },
                    )
                    EditorToolbarButton(Icons.Outlined.Close, "Закрыть поиск", onClick = {
                        editorView.value?.clearSearchHighlight()
                        showFind.value = false
                        findQuery.value = ""
                        findResult.value = EditorTextSearchResult()
                    })
                } else {
                    val currentIndex = ports.documents.indexOfFirst { it.id == document.id }.coerceAtLeast(0)
                    PersistentEditorToolbarContent(
                        layoutId = EditorToolbarLayoutId.Ports,
                        title = document.id.fileName,
                        detail = "${currentIndex + 1}/${ports.documents.size}",
                        onTitleClick = { showPicker.value = true },
                        titleEnabled = !ports.isSaving,
                        editor = editorView.value,
                        editorMetrics = metrics.value,
                        editorActionsEnabled = document.hasLoaded && !ports.isBusy,
                        searchDescription = "Поиск в файле",
                        onSearchClick = { showFind.value = true },
                        searchEnabled = document.hasLoaded,
                    ) {
                        EditorToolbarButton(
                            icon = if (isFullscreen) Icons.Outlined.FullscreenExit else Icons.Outlined.Fullscreen,
                            description = if (isFullscreen) {
                                "Выйти из полноэкранного режима"
                            } else {
                                "Открыть редактор на весь экран"
                            },
                            onClick = { onFullscreenChange(!isFullscreen) },
                        )
                        EditorToolbarButton(
                            Icons.Outlined.SettingsBackupRestore,
                            "Откатить локальные изменения",
                            controller::revertPortsDocument,
                            enabled = document.hasChanges && !ports.isBusy,
                        )
                        EditorToolbarButton(
                            Icons.Outlined.Refresh,
                            "Обновить файл с сервера",
                            onClick = { scope.launch { controller.loadSelectedPortsDocument(force = true) } },
                            enabled = document.hasLoaded && !document.hasChanges && !ports.isBusy,
                        )
                        EditorToolbarButton(
                            icon = Icons.Outlined.Save,
                            description = "Сохранить и перезапустить xkeen",
                            onClick = { confirmSave.value = true },
                            accent = document.hasChanges,
                            accentColor = WebPanelPalette.Warning,
                            enabled = document.hasChanges && !ports.isBusy,
                        )
                    }
                }
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                document.isLoading -> CircularProgressIndicator(
                    color = WebPanelPalette.Accent,
                    modifier = Modifier.align(Alignment.Center),
                )

                !document.hasLoaded -> Column(
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        text = document.error ?: ports.message,
                        color = if (document.error != null) WebPanelPalette.Error else WebPanelPalette.Text,
                    )
                    if (document.error != null) {
                        OutlinedButton(onClick = { scope.launch { controller.loadSelectedPortsDocument(force = true) } }) {
                            Text("Повторить")
                        }
                    }
                }

                else -> key(document.id) {
                    StructuredTextEditor(
                        value = document.content,
                        baselineValue = document.savedContent,
                        language = if (document.id.isJson) {
                            StructuredTextLanguage.Jsonc
                        } else {
                            StructuredTextLanguage.List
                        },
                        onValueChange = controller::updatePortsDocument,
                        onMetricsChange = { metrics.value = it },
                        onEditorReady = { editorView.value = it },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }

        EditorMetricsStatusBar(
            statusText = ports.message,
            statusColor = when {
                ports.error != null -> WebPanelPalette.Error
                ports.isBusy -> WebPanelPalette.TextBlue
                document.hasChanges -> WebPanelPalette.Warning
                document.hasLoaded -> WebPanelPalette.Success
                else -> WebPanelPalette.Muted
            },
            metrics = metrics.value,
            onClick = { showStatusDetails.value = true },
        )
    }

    if (showPicker.value) {
        PortsDocumentPickerDialog(
            documents = ports.documents,
            selectedId = document.id,
            onDismiss = { showPicker.value = false },
            onSelect = { selected ->
                controller.selectPortsDocument(selected)
                showPicker.value = false
            },
        )
    }
    if (confirmSave.value) {
        PortsSaveDialog(
            document = document,
            isSaving = ports.isSaving,
            onDismiss = { if (!ports.isSaving) confirmSave.value = false },
            onConfirm = {
                confirmSave.value = false
                scope.launch { controller.savePortsDocument() }
            },
        )
    }
    if (showStatusDetails.value) {
        PortsStatusDialog(
            document = document,
            message = ports.message,
            metrics = metrics.value,
            onDismiss = { showStatusDetails.value = false },
        )
    }
}

@Composable
private fun PortsDocumentPickerDialog(
    documents: List<PortsEditorDocument>,
    selectedId: PortsDocumentId,
    onDismiss: () -> Unit,
    onSelect: (PortsDocumentId) -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "ПОРТЫ И ИСКЛЮЧЕНИЯ",
                color = WebPanelPalette.Border,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.7.sp,
            )
            Text(
                text = "Выберите файл",
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "Файлы из каталога /opt/etc/xkeen",
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.bodySmall,
            )
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 380.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                documents.forEachIndexed { index, document ->
                    val selected = document.id == selectedId
                    val shape = RoundedCornerShape(12.dp)
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                if (selected) WebPanelPalette.Accent else WebPanelPalette.Surface,
                                shape,
                            )
                            .border(
                                1.dp,
                                if (selected) {
                                    WebPanelPalette.Border.copy(alpha = 0.72f)
                                } else {
                                    WebPanelPalette.AccentMiddle.copy(alpha = 0.28f)
                                },
                                shape,
                            )
                            .clickable { onSelect(document.id) }
                            .padding(horizontal = 13.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(11.dp),
                    ) {
                        Text(
                            text = (index + 1).toString().padStart(2, '0'),
                            color = if (selected) WebPanelPalette.TextStrong else WebPanelPalette.Muted,
                            style = MaterialTheme.typography.labelMedium,
                            fontFamily = FontFamily.Monospace,
                        )
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = document.id.fileName,
                                color = WebPanelPalette.TextStrong,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Bold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = document.id.description,
                                color = if (selected) WebPanelPalette.TextBlue else WebPanelPalette.Muted,
                                style = MaterialTheme.typography.labelSmall,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (document.hasChanges) {
                            Text("●", color = WebPanelPalette.Warning)
                        } else if (selected) {
                            Text(
                                text = "ОТКРЫТ",
                                color = WebPanelPalette.TextStrong,
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                }
            }
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                OutlinedButton(onClick = onDismiss) { Text("Закрыть") }
            }
        }
    }
}

@Composable
private fun PortsSaveDialog(
    document: PortsEditorDocument,
    isSaving: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "Сохранить ${document.id.fileName}?",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "Файл будет проверен на внешние изменения, сохранён в /opt/etc/xkeen, после чего xkeen перезапустится.",
                color = WebPanelPalette.Muted,
            )
            if (document.id in setOf(PortsDocumentId.PortProxying, PortsDocumentId.PortExclude)) {
                Text(
                    text = "Важно: одновременно использовать список проксируемых портов и исключения нельзя; приоритет у port_proxying.lst.",
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(WebPanelPalette.Surface, RoundedCornerShape(10.dp))
                        .padding(10.dp),
                    color = WebPanelPalette.Warning,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedButton(onClick = onDismiss, enabled = !isSaving) { Text("Отмена") }
                Spacer(Modifier.width(8.dp))
                Button(onClick = onConfirm, enabled = !isSaving) {
                    Text("Сохранить и перезапустить")
                }
            }
        }
    }
}

@Composable
private fun PortsStatusDialog(
    document: PortsEditorDocument,
    message: String,
    metrics: EditorMetrics,
    onDismiss: () -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Text(document.id.fileName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(document.id.path, color = WebPanelPalette.TextBlue, fontFamily = FontFamily.Monospace)
            Text(document.id.description, color = WebPanelPalette.Muted)
            Text(message, color = if (document.error != null) WebPanelPalette.Error else WebPanelPalette.Text)
            Text(
                text = "${metrics.lineCount} строк · ${metrics.characterCount} символов",
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.bodySmall,
            )
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                OutlinedButton(onClick = onDismiss) { Text("Закрыть") }
            }
        }
    }
}
