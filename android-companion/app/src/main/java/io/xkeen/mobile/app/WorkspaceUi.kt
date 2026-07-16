package io.xkeen.mobile.app

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FactCheck
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SettingsBackupRestore
import androidx.compose.material3.Icon
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun RoutingWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val routing = state.routing
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val showDocumentPicker = rememberSaveable { mutableStateOf(false) }
    val showEditorStatusDetails = rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(state.dashboard.endpoint, state.dashboard.availableCores) {
        controller.refreshRoutingDocuments()
    }
    LaunchedEffect(routing.selectedDocumentId) {
        controller.loadSelectedRoutingDocument()
    }
    LaunchedEffect(routing.write.phase, routing.write.message) {
        if (routing.write.phase == RoutingWritePhase.Success) {
            delay(2_500)
            controller.dismissRoutingWriteResult()
        }
    }

    val selectedDocument = routing.documents.firstOrNull {
        it.id == routing.selectedDocumentId
    }
    if (selectedDocument == null) {
        RoutingWorkspaceLoading(
            isLoading = routing.isRefreshing,
            error = routing.loadError ?: state.dashboard.lastError,
            onRetry = {
                scope.launch {
                    controller.refreshWorkspaceSnapshot()
                    controller.refreshRoutingDocuments(force = true)
                }
            },
            modifier = modifier,
        )
        return
    }
    val editorMetrics = remember(selectedDocument.id) {
        mutableStateOf(
            EditorDocumentIndex.build(selectedDocument.draftContent).metricsAt(0),
        )
    }
    val editorView = remember(selectedDocument.id) { mutableStateOf<AdvancedJsonEditorView?>(null) }
    val showFind = rememberSaveable(selectedDocument.id) { mutableStateOf(false) }
    val findQuery = rememberSaveable(selectedDocument.id) { mutableStateOf("") }
    val findResult = remember(selectedDocument.id) { mutableStateOf(EditorTextSearchResult()) }
    val findFocusRequester = remember { FocusRequester() }
    val findNext: (Boolean) -> Unit = { forward ->
        findResult.value = editorView.value?.findText(findQuery.value, forward)
            ?: findEditorText(selectedDocument.draftContent, findQuery.value, 0, 0, forward)
    }

    LaunchedEffect(showFind.value, selectedDocument.id) {
        if (showFind.value) findFocusRequester.requestFocus()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .imePadding(),
    ) {
        DocumentToolbar(
            document = selectedDocument,
            documents = routing.documents,
            validation = routing.validation,
            isValidationInFlight = routing.isValidationInFlight,
            isWriteInFlight = routing.write.isPending,
            onOpenDocumentPicker = {
                focusManager.clearFocus(force = true)
                showDocumentPicker.value = true
            },
            isFindVisible = showFind.value,
            findQuery = findQuery.value,
            findResult = findResult.value,
            findFocusRequester = findFocusRequester,
            onOpenFind = {
                showFind.value = true
                if (findQuery.value.isNotBlank()) findNext(true)
            },
            onFindQueryChange = { query ->
                findQuery.value = query
                findResult.value = editorView.value?.findText(
                    query = query,
                    forward = true,
                    restartAtSelectionStart = true,
                ) ?: findEditorText(selectedDocument.draftContent, query, 0, 0, forward = true)
            },
            onFindPrevious = { findNext(false) },
            onFindNext = { findNext(true) },
            onCloseFind = {
                editorView.value?.clearSearchHighlight()
                showFind.value = false
                findQuery.value = ""
                findResult.value = EditorTextSearchResult()
            },
            onValidate = { scope.launch { controller.validateRouting() } },
            onRevert = controller::revertRoutingDraft,
            onSave = { scope.launch { controller.saveRouting() } },
            onApply = controller::requestRoutingApply,
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            key(selectedDocument.id) {
                RoutingDocumentPage(
                    document = selectedDocument,
                    onValueChange = { value ->
                        controller.updateRoutingDraft(selectedDocument.id, value)
                    },
                    onMetricsChange = { metrics -> editorMetrics.value = metrics },
                    onEditorReady = { view -> editorView.value = view },
                    onRetry = {
                        scope.launch { controller.loadSelectedRoutingDocument() }
                    },
                )
            }
        }
        RoutingValidationDiagnosticsPanel(
            validation = routing.validation,
            isValidationInFlight = routing.isValidationInFlight,
            write = routing.write,
        )
        EditorStatusBar(
            document = selectedDocument,
            validation = routing.validation,
            write = routing.write,
            metrics = editorMetrics.value,
            onClick = { showEditorStatusDetails.value = true },
        )
    }

    if (showDocumentPicker.value) {
        RoutingDocumentPickerDialog(
            documents = routing.documents,
            selectedDocumentId = selectedDocument.id,
            onDismiss = { showDocumentPicker.value = false },
            onSelectDocument = { documentId ->
                controller.selectRoutingDocument(documentId)
                showDocumentPicker.value = false
            },
        )
    }
    if (showEditorStatusDetails.value) {
        EditorStatusDetailsDialog(
            document = selectedDocument,
            validation = routing.validation,
            write = routing.write,
            metrics = editorMetrics.value,
            onDismiss = { showEditorStatusDetails.value = false },
        )
    }
}

@Composable
private fun RoutingWorkspaceLoading(
    isLoading: Boolean,
    error: String?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (isLoading) {
                CircularProgressIndicator(color = WebPanelPalette.Accent)
            }
            Text(
                text = error ?: if (isLoading) {
                    "Загружаем routing-конфигурации с Xkeen UI…"
                } else {
                    "Ожидаем подтверждённое состояние Xkeen UI…"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = if (error != null) WebPanelPalette.Error else WebPanelPalette.Text,
                textAlign = TextAlign.Center,
            )
            if (error != null) {
                OutlinedButton(onClick = onRetry) {
                    Text("Повторить")
                }
            }
        }
    }
}

@Composable
private fun RoutingDocumentPage(
    document: RoutingDocument,
    onValueChange: (String) -> Unit,
    onMetricsChange: (EditorMetrics) -> Unit,
    onEditorReady: (AdvancedJsonEditorView) -> Unit,
    onRetry: () -> Unit,
) {
    when {
        document.isLoading -> DocumentLoadMessage(
            title = "Загружаем ${document.title}",
            message = "Получаем JSON/JSONC с Xkeen UI…",
            showProgress = true,
        )

        !document.isLoaded -> DocumentLoadMessage(
            title = document.title,
            message = document.loadError ?: "Сделайте длинный свайп ещё раз или повторите загрузку.",
            actionLabel = "Повторить",
            onAction = onRetry,
        )

        else -> JsonEditor(
            value = document.draftContent,
            onValueChange = onValueChange,
            onMetricsChange = onMetricsChange,
            onEditorReady = onEditorReady,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun DocumentLoadMessage(
    title: String,
    message: String,
    showProgress: Boolean = false,
    actionLabel: String? = null,
    onAction: () -> Unit = {},
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (showProgress) {
            CircularProgressIndicator(
                modifier = Modifier.size(28.dp),
                color = WebPanelPalette.Border,
                strokeWidth = 2.dp,
            )
            Spacer(Modifier.height(14.dp))
        }
        Text(
            text = title,
            color = WebPanelPalette.TextStrong,
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = message,
            color = WebPanelPalette.Muted,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        if (actionLabel != null) {
            Spacer(Modifier.height(14.dp))
            Text(
                text = actionLabel,
                modifier = Modifier
                    .background(WebPanelPalette.SurfaceRaised, RoundedCornerShape(12.dp))
                    .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.32f), RoundedCornerShape(12.dp))
                    .clickable(onClick = onAction)
                    .padding(horizontal = 16.dp, vertical = 9.dp),
                color = WebPanelPalette.TextBlue,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun DocumentToolbar(
    document: RoutingDocument,
    documents: List<RoutingDocument>,
    validation: RoutingValidation,
    isValidationInFlight: Boolean,
    isWriteInFlight: Boolean,
    onOpenDocumentPicker: () -> Unit,
    isFindVisible: Boolean,
    findQuery: String,
    findResult: EditorTextSearchResult,
    findFocusRequester: FocusRequester,
    onOpenFind: () -> Unit,
    onFindQueryChange: (String) -> Unit,
    onFindPrevious: () -> Unit,
    onFindNext: () -> Unit,
    onCloseFind: () -> Unit,
    onValidate: () -> Unit,
    onRevert: () -> Unit,
    onSave: () -> Unit,
    onApply: () -> Unit,
) {
    val currentIndex = documents.indexOfFirst { it.id == document.id }.coerceAtLeast(0)

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
            if (isFindVisible) {
                SearchToolbarField(
                    value = findQuery,
                    onValueChange = onFindQueryChange,
                    modifier = Modifier
                        .weight(1f)
                        .focusRequester(findFocusRequester),
                    onSearch = onFindNext,
                )
                if (findQuery.isNotBlank()) {
                    Text(
                        text = findResult.selectedMatch?.let { "$it/${findResult.matchCount}" }
                            ?: "0/${findResult.matchCount}",
                        modifier = Modifier.padding(horizontal = 4.dp),
                        color = WebPanelPalette.Muted,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                    )
                }
                EditorToolbarButton(Icons.Outlined.KeyboardArrowUp, "Предыдущее совпадение", onFindPrevious)
                EditorToolbarButton(Icons.Outlined.KeyboardArrowDown, "Следующее совпадение", onFindNext)
                EditorToolbarButton(Icons.Outlined.Close, "Закрыть поиск", onCloseFind)
            } else {
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clickable(onClick = onOpenDocumentPicker)
                        .padding(start = 9.dp, end = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = document.title,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = "  ${currentIndex + 1}/${documents.size}  ▾",
                        style = MaterialTheme.typography.labelMedium,
                        color = WebPanelPalette.Muted,
                    )
                }
                EditorToolbarButton(Icons.Outlined.Search, "Поиск в файле", onOpenFind)
                EditorToolbarButton(
                    icon = Icons.AutoMirrored.Outlined.FactCheck,
                    description = if (isValidationInFlight) "Проверка выполняется" else "Проверить",
                    onClick = onValidate,
                    accent = isValidationInFlight,
                    enabled = !isValidationInFlight && !isWriteInFlight,
                )
                EditorToolbarButton(Icons.Outlined.SettingsBackupRestore, "Откатить", onRevert)
                EditorToolbarButton(
                    icon = Icons.Outlined.Save,
                    description = "Сохранить",
                    onClick = onSave,
                    accent = document.hasUnsavedChanges,
                    enabled = !isWriteInFlight,
                )
                EditorToolbarButton(
                    icon = Icons.Outlined.DoneAll,
                    description = "Применить",
                    onClick = onApply,
                    accent = document.hasDraftChanges,
                    enabled = !isWriteInFlight,
                )
            }
        }
    }
}

@Composable
private fun SearchToolbarField(
    value: String,
    onValueChange: (String) -> Unit,
    onSearch: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(12.dp)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier
            .height(36.dp)
            .background(
                brush = Brush.horizontalGradient(
                    listOf(
                        WebPanelPalette.SurfaceRaised.copy(alpha = 0.96f),
                        WebPanelPalette.Surface.copy(alpha = 0.96f),
                    ),
                ),
                shape = shape,
            )
            .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.30f), shape),
        textStyle = MaterialTheme.typography.bodyMedium.copy(
            color = WebPanelPalette.TextStrong,
            fontFamily = FontFamily.Monospace,
        ),
        singleLine = true,
        cursorBrush = SolidColor(WebPanelPalette.TextBlue),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch() }),
        decorationBox = { innerTextField ->
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Icon(
                    imageVector = Icons.Outlined.Search,
                    contentDescription = null,
                    tint = WebPanelPalette.TextBlue.copy(alpha = 0.78f),
                    modifier = Modifier.size(16.dp),
                )
                Box(modifier = Modifier.weight(1f)) {
                    if (value.isEmpty()) {
                        Text(
                            text = "Поиск в файле",
                            color = WebPanelPalette.Muted,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                        )
                    }
                    innerTextField()
                }
            }
        },
    )
}

@Composable
private fun RoutingDocumentPickerDialog(
    documents: List<RoutingDocument>,
    selectedDocumentId: String,
    onDismiss: () -> Unit,
    onSelectDocument: (String) -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "РОУТИНГ XRAY",
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
                text = "Доступно файлов: ${documents.size}",
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
                documents.forEachIndexed { index, item ->
                    val selected = item.id == selectedDocumentId
                    val shape = RoundedCornerShape(12.dp)
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                color = if (selected) {
                                    WebPanelPalette.Accent
                                } else {
                                    WebPanelPalette.Surface
                                },
                                shape = shape,
                            )
                            .border(
                                width = 1.dp,
                                color = if (selected) {
                                    WebPanelPalette.Border.copy(alpha = 0.72f)
                                } else {
                                    WebPanelPalette.AccentMiddle.copy(alpha = 0.28f)
                                },
                                shape = shape,
                            )
                            .clickable { onSelectDocument(item.id) }
                            .padding(horizontal = 13.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(11.dp),
                    ) {
                        Text(
                            text = (index + 1).toString().padStart(2, '0'),
                            color = if (selected) {
                                WebPanelPalette.TextStrong
                            } else {
                                WebPanelPalette.Muted
                            },
                            style = MaterialTheme.typography.labelMedium,
                            fontFamily = FontFamily.Monospace,
                        )
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = item.title,
                                color = WebPanelPalette.TextStrong,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Bold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = item.path,
                                color = if (selected) {
                                    WebPanelPalette.TextBlue
                                } else {
                                    WebPanelPalette.Muted
                                },
                                style = MaterialTheme.typography.labelSmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (selected) {
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                OutlinedButton(onClick = onDismiss) {
                    Text("Закрыть")
                }
            }
        }
    }
}

@Composable
private fun EditorToolbarButton(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
    accent: Boolean = false,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(10.dp)
    val accentColor = WebPanelPalette.Border
    Box(
        modifier = Modifier
            .size(34.dp)
            .padding(2.dp)
            .shadow(if (accent) 4.dp else 2.dp, shape)
            .background(
                brush = Brush.verticalGradient(
                    if (accent) {
                        listOf(Color(0xFF102C5E), Color(0xFF081436))
                    } else {
                        listOf(WebPanelPalette.SurfaceRaised, WebPanelPalette.Surface)
                    },
                ),
                shape = shape,
            )
            .border(
                width = 1.dp,
                brush = Brush.linearGradient(
                    if (accent) {
                        listOf(
                            Color.White.copy(alpha = 0.12f),
                            WebPanelPalette.Border.copy(alpha = 0.56f),
                            WebPanelPalette.Border.copy(alpha = 0.20f),
                        )
                    } else {
                        listOf(
                            Color.White.copy(alpha = 0.08f),
                            WebPanelPalette.Border.copy(alpha = 0.20f),
                        )
                    },
                ),
                shape = shape,
            )
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = description,
            tint = if (accent) accentColor else WebPanelPalette.TextBlue.copy(
                alpha = if (enabled) 1f else 0.38f,
            ),
            modifier = Modifier.size(19.dp),
        )
    }
}

@Composable
private fun JsonEditor(
    value: String,
    onValueChange: (String) -> Unit,
    onMetricsChange: (EditorMetrics) -> Unit,
    onEditorReady: (AdvancedJsonEditorView) -> Unit,
    modifier: Modifier = Modifier,
) {
    val editorView = remember { mutableStateOf<AdvancedJsonEditorView?>(null) }
    val showGoToLine = rememberSaveable { mutableStateOf(false) }
    val requestedLine = rememberSaveable { mutableStateOf(1) }
    val requestedLineCount = rememberSaveable { mutableStateOf(1) }

    AndroidView(
        factory = { context ->
            AdvancedJsonEditorView(context).also { view ->
                editorView.value = view
                onEditorReady(view)
            }
        },
        update = { view ->
            view.onTextChanged = onValueChange
            view.onMetricsChanged = onMetricsChange
            view.onRequestGoToLine = { currentLine, totalLines ->
                requestedLine.value = currentLine
                requestedLineCount.value = totalLines
                showGoToLine.value = true
            }
            view.setDocumentText(value)
        },
        modifier = modifier
            .fillMaxWidth()
            .background(JsonEditorPalette.Background),
    )

    if (showGoToLine.value) {
        GoToLineDialog(
            currentLine = requestedLine.value,
            totalLines = requestedLineCount.value,
            onDismiss = { showGoToLine.value = false },
            onGoToLine = { line ->
                showGoToLine.value = false
                editorView.value?.goToLine(line)
            },
        )
    }
}

@Composable
private fun GoToLineDialog(
    currentLine: Int,
    totalLines: Int,
    onDismiss: () -> Unit,
    onGoToLine: (Int) -> Unit,
) {
    val input = rememberSaveable(currentLine, totalLines) {
        mutableStateOf(currentLine.toString())
    }
    val requestedLine = input.value.toIntOrNull()
    val isValid = requestedLine != null && requestedLine in 1..totalLines
    val submit: () -> Unit = {
        if (isValid) onGoToLine(requireNotNull(requestedLine))
    }

    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "Переход по документу",
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "Введите номер строки от 1 до $totalLines.",
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedTextField(
                value = input.value,
                onValueChange = { value -> input.value = value.filter(Char::isDigit).take(9) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Строка") },
                supportingText = if (input.value.isNotEmpty() && !isValid) {
                    { Text("Допустимый диапазон: 1–$totalLines") }
                } else {
                    null
                },
                isError = input.value.isNotEmpty() && !isValid,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Number,
                    imeAction = ImeAction.Go,
                ),
                keyboardActions = KeyboardActions(onGo = { submit() }),
                singleLine = true,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                OutlinedButton(onClick = onDismiss) {
                    Text("Отмена")
                }
                Spacer(Modifier.width(10.dp))
                Button(
                    onClick = submit,
                    enabled = isValid,
                ) {
                    Text("Перейти")
                }
            }
        }
    }
}

internal object JsonEditorPalette {
    // Mirrors the xkeen-dark Monaco theme from web ui/monaco_shared.js.
    val Background = Color(0xFF01030A)
    val Foreground = Color(0xFFD4D4D4)
    val LineNumber = Color(0xFF64748B)
    val Cursor = Color(0xFF60A5FA)
    val IndentGuide = Color(0xFF172033)
    val Comment = Color(0xFF6A9955)
    val Keyword = Color(0xFF569CD6)
    val String = Color(0xFFCE9178)
    val Number = Color(0xFFB5CEA8)
    val Property = Color(0xFF9CDCFE)
    val Punctuation = Color(0xFFD4D4D4)
    val BracketDepth = listOf(
        Color(0xFFFFD700),
        Color(0xFFC586C0),
        Color(0xFF4FC1FF),
    )
    val Selection = TextSelectionColors(
        handleColor = Cursor,
        backgroundColor = Color(0x501D4ED8),
    )
    val SearchMatch = Color(0xB3345790)
}

internal fun highlightJsonc(source: String): AnnotatedString = buildAnnotatedString {
    append(source)
    var index = 0
    var bracketDepth = 0

    while (index < source.length) {
        val keyword = source.jsonKeywordAt(index)
        when {
            source.startsWith("//", index) -> {
                val end = source.indexOf('\n', index).takeIf { it >= 0 } ?: source.length
                addJsonStyle(JsonEditorPalette.Comment, index, end)
                index = end
            }

            source.startsWith("/*", index) -> {
                val closing = source.indexOf("*/", index + 2)
                val end = if (closing >= 0) closing + 2 else source.length
                addJsonStyle(JsonEditorPalette.Comment, index, end)
                index = end
            }

            source[index] == '"' -> {
                val end = source.jsonStringEnd(index)
                val nextToken = source.indexOfFirstNonWhitespace(end)
                val color = if (nextToken < source.length && source[nextToken] == ':') {
                    JsonEditorPalette.Property
                } else {
                    JsonEditorPalette.String
                }
                addJsonStyle(color, index, end)
                index = end
            }

            source[index] == '-' || source[index].isDigit() -> {
                val end = source.jsonNumberEnd(index)
                val startsNumber = source[index].isDigit() ||
                    (index + 1 < source.length && source[index] == '-' && source[index + 1].isDigit())
                if (startsNumber) {
                    addJsonStyle(JsonEditorPalette.Number, index, end)
                    index = end
                } else {
                    index += 1
                }
            }

            keyword != null -> {
                addJsonStyle(JsonEditorPalette.Keyword, index, index + keyword.length)
                index += keyword.length
            }

            source[index] == '{' || source[index] == '[' -> {
                val color = JsonEditorPalette.BracketDepth[bracketDepth % JsonEditorPalette.BracketDepth.size]
                addJsonStyle(color, index, index + 1)
                bracketDepth += 1
                index += 1
            }

            source[index] == '}' || source[index] == ']' -> {
                bracketDepth = (bracketDepth - 1).coerceAtLeast(0)
                val color = JsonEditorPalette.BracketDepth[bracketDepth % JsonEditorPalette.BracketDepth.size]
                addJsonStyle(color, index, index + 1)
                index += 1
            }

            source[index] == ':' || source[index] == ',' -> {
                addJsonStyle(JsonEditorPalette.Punctuation, index, index + 1)
                index += 1
            }

            else -> index += 1
        }
    }
}

private fun AnnotatedString.Builder.addJsonStyle(color: Color, start: Int, end: Int) {
    addStyle(SpanStyle(color = color), start, end)
}

private fun String.jsonStringEnd(start: Int): Int {
    var index = start + 1
    var escaped = false
    while (index < length) {
        val char = this[index]
        if (!escaped && char == '"') return index + 1
        escaped = !escaped && char == '\\'
        if (char != '\\') escaped = false
        index += 1
    }
    return length
}

private fun String.indexOfFirstNonWhitespace(start: Int): Int {
    var index = start
    while (index < length && this[index].isWhitespace()) index += 1
    return index
}

private fun String.jsonNumberEnd(start: Int): Int {
    var index = start
    if (index < length && this[index] == '-') index += 1
    while (index < length && this[index].isDigit()) index += 1
    if (index < length && this[index] == '.') {
        index += 1
        while (index < length && this[index].isDigit()) index += 1
    }
    if (index < length && (this[index] == 'e' || this[index] == 'E')) {
        index += 1
        if (index < length && (this[index] == '+' || this[index] == '-')) index += 1
        while (index < length && this[index].isDigit()) index += 1
    }
    return index
}

private val JsonKeywords = listOf("true", "false", "null")

private fun String.jsonKeywordAt(index: Int): String? =
    JsonKeywords.firstOrNull { keyword ->
        startsWith(keyword, index) &&
            (index == 0 || !this[index - 1].isLetterOrDigit()) &&
            (index + keyword.length == length || !this[index + keyword.length].isLetterOrDigit())
    }

@Composable
private fun RoutingValidationDiagnosticsPanel(
    validation: RoutingValidation,
    isValidationInFlight: Boolean,
    write: RoutingWriteState,
) {
    val diagnostics = validation.diagnostics
    if (!isValidationInFlight && diagnostics.isEmpty() && write.phase == RoutingWritePhase.Idle) return

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(WebPanelPalette.Surface)
            .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.32f))
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (isValidationInFlight) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 2.dp,
                    color = WebPanelPalette.TextBlue,
                )
                Text(
                    text = if (validation.isPending) {
                        validation.message
                    } else {
                        "Завершаем проверку предыдущего черновика…"
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = WebPanelPalette.Text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (write.phase != RoutingWritePhase.Idle) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (write.isPending) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        color = WebPanelPalette.TextBlue,
                    )
                }
                Text(
                    text = when (write.phase) {
                        RoutingWritePhase.Conflict -> "КОНФЛИКТ"
                        RoutingWritePhase.Failure -> "ОШИБКА"
                        RoutingWritePhase.Success -> "СЕРВЕР"
                        RoutingWritePhase.Saving -> "SAVE"
                        RoutingWritePhase.Applying -> "APPLY"
                        RoutingWritePhase.Idle -> ""
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = when (write.phase) {
                        RoutingWritePhase.Conflict -> WebPanelPalette.Warning
                        RoutingWritePhase.Failure -> WebPanelPalette.Error
                        RoutingWritePhase.Success -> WebPanelPalette.Success
                        else -> WebPanelPalette.TextBlue
                    },
                    fontWeight = FontWeight.Bold,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = write.message,
                        style = MaterialTheme.typography.bodySmall,
                        color = WebPanelPalette.Text,
                    )
                    write.code?.let { code ->
                        Text(
                            text = "код: $code",
                            style = MaterialTheme.typography.labelSmall,
                            color = WebPanelPalette.Muted,
                        )
                    }
                }
            }
        }
        if (diagnostics.isNotEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 116.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                diagnostics.forEach { diagnostic ->
                    RoutingDiagnosticRow(diagnostic)
                }
            }
        }
    }
}

@Composable
private fun RoutingDiagnosticRow(diagnostic: RoutingDiagnostic) {
    val sourceLabel = when (diagnostic.source) {
        RoutingDiagnosticSource.LocalSyntax -> "ЛОКАЛЬНО"
        RoutingDiagnosticSource.Server -> "XRAY"
        RoutingDiagnosticSource.Transport -> "СЕТЬ"
    }
    val severityColor = when (diagnostic.severity) {
        RoutingDiagnosticSeverity.Info -> WebPanelPalette.TextBlue
        RoutingDiagnosticSeverity.Warning -> WebPanelPalette.Warning
        RoutingDiagnosticSeverity.Error -> WebPanelPalette.Error
    }
    val metadata = listOfNotNull(
        diagnostic.code?.let { "код: $it" },
        diagnostic.phase?.let { "этап: $it" },
        diagnostic.locationLabel,
    ).joinToString(" · ")

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = sourceLabel,
            style = MaterialTheme.typography.labelSmall,
            color = severityColor,
            fontWeight = FontWeight.Bold,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = diagnostic.message,
                style = MaterialTheme.typography.bodySmall,
                color = WebPanelPalette.Text,
            )
            if (metadata.isNotBlank()) {
                Text(
                    text = metadata,
                    style = MaterialTheme.typography.labelSmall,
                    color = WebPanelPalette.Muted,
                )
            }
            diagnostic.hint?.let { hint ->
                Text(
                    text = hint,
                    style = MaterialTheme.typography.labelSmall,
                    color = WebPanelPalette.Muted,
                )
            }
        }
    }
}

@Composable
private fun EditorStatusBar(
    document: RoutingDocument,
    validation: RoutingValidation,
    write: RoutingWriteState,
    metrics: EditorMetrics,
    onClick: () -> Unit,
) {
    val presentation = editorStatusPresentation(document, validation, write)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(28.dp)
            .background(
                Brush.horizontalGradient(
                    listOf(
                        WebPanelPalette.Surface,
                        Color(0xFF081436),
                        WebPanelPalette.Surface,
                    ),
                ),
            )
            .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.16f))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .background(presentation.color, CircleShape),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = presentation.text,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.labelMedium,
            color = WebPanelPalette.Text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = "${metrics.characterCount} зн · ${metrics.wordCount} сл · " +
                "${metrics.cursor.line}:${metrics.cursor.column}/${metrics.lineCount}",
            style = MaterialTheme.typography.labelSmall,
            color = WebPanelPalette.Muted,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
        )
    }
}

private data class EditorStatusPresentation(
    val text: String,
    val color: Color,
)

private fun editorStatusPresentation(
    document: RoutingDocument,
    validation: RoutingValidation,
    write: RoutingWriteState,
): EditorStatusPresentation {
    val text = when {
        document.isLoading -> "Загрузка с Xkeen UI…"
        document.loadError != null -> document.loadError
        write.isPending || write.phase in setOf(
            RoutingWritePhase.Conflict,
            RoutingWritePhase.Failure,
            RoutingWritePhase.Success,
        ) -> write.message
        validation.state in setOf(
            RoutingValidationState.Validating,
            RoutingValidationState.Invalid,
            RoutingValidationState.Valid,
        ) -> validation.displayMessage
        document.hasUnsavedChanges -> "Изменения не сохранены"
        document.hasDraftChanges -> "Черновик сохранён"
        document.modifiedAtEpochSeconds != null -> if (document.usesJsonc) "server · JSONC" else "server · JSON"
        else -> "${document.revisionLabel} · опубликовано"
    }
    val color = when {
        write.phase == RoutingWritePhase.Conflict -> WebPanelPalette.Warning
        write.phase == RoutingWritePhase.Failure -> WebPanelPalette.Error
        write.phase == RoutingWritePhase.Success -> WebPanelPalette.Success
        write.isPending -> WebPanelPalette.TextBlue
        else -> when (validation.state) {
            RoutingValidationState.Invalid -> WebPanelPalette.Error
            RoutingValidationState.Validating -> WebPanelPalette.TextBlue
            RoutingValidationState.Valid -> WebPanelPalette.Success
            RoutingValidationState.Dirty -> WebPanelPalette.Warning
            RoutingValidationState.Idle -> WebPanelPalette.Muted
        }
    }
    return EditorStatusPresentation(text, color)
}

@Composable
private fun EditorStatusDetailsDialog(
    document: RoutingDocument,
    validation: RoutingValidation,
    write: RoutingWriteState,
    metrics: EditorMetrics,
    onDismiss: () -> Unit,
) {
    val presentation = editorStatusPresentation(document, validation, write)
    val diagnostic = validation.primaryDiagnostic
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "СТАТУС РЕДАКТОРА",
                color = presentation.color,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.7.sp,
            )
            Text(
                text = document.title,
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            StatusDetailLine("Состояние", presentation.text)
            diagnostic?.let { item ->
                StatusDetailLine(
                    "Источник проверки",
                    when (item.source) {
                        RoutingDiagnosticSource.Server -> "Сервер Xkeen UI / Xray"
                        RoutingDiagnosticSource.Transport -> "Соединение с сервером"
                        RoutingDiagnosticSource.LocalSyntax -> "Локальная предварительная проверка"
                    },
                )
                item.locationLabel?.let { location ->
                    StatusDetailLine("Место ошибки", location)
                }
                item.code?.let { code ->
                    StatusDetailLine("Код проверки", code)
                }
            }
            StatusDetailLine("Символов", metrics.characterCount.toString())
            StatusDetailLine("Слов", metrics.wordCount.toString())
            StatusDetailLine(
                "Текущая позиция курсора",
                "строка ${metrics.cursor.line}, столбец ${metrics.cursor.column}",
            )
            StatusDetailLine("Строк", metrics.lineCount.toString())
            Button(
                onClick = onDismiss,
                modifier = Modifier.align(Alignment.End),
            ) {
                Text("Закрыть")
            }
        }
    }
}

@Composable
private fun StatusDetailLine(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = label,
            color = WebPanelPalette.Muted,
            style = MaterialTheme.typography.labelSmall,
        )
        Text(
            text = value,
            color = WebPanelPalette.Text,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
internal fun ModulePlaceholderScreen(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .padding(28.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(text = title, style = MaterialTheme.typography.headlineSmall)
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
internal fun LogsWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val logs = state.logs
    val entries = remember(logs.entries, logs.filter) {
        logs.entries.filter { entry ->
            when (logs.filter) {
                LogFilter.All -> true
                LogFilter.Service -> entry.source.startsWith("xray-") || entry.source == "service"
                LogFilter.Routing -> entry.source == "routing"
                LogFilter.Errors -> entry.level == LogLevel.Error
            }
        }
    }
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        TitleBlock(
            eyebrow = "Xray transport",
            title = "Логи Xray",
            subtitle = logs.statusMessage,
        )
        CompactStatusRow(
            items = listOf(
                logsConnectionChip(logs.connection, logs.reconnectAttempt),
                statusChip(if (logs.hasLoadedHistory) "история загружена" else "ждём историю"),
            ),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            LogFilter.entries.forEach { filter ->
                FilterChip(
                    selected = logs.filter == filter,
                    onClick = { controller.updateLogFilter(filter) },
                    label = { Text(logFilterLabel(filter)) },
                )
            }
        }
        if (entries.isEmpty()) {
            SectionCard(
                title = "Нет записей",
                supporting = if (logs.connection == LogsConnectionState.Connected) {
                    "Xray ещё не записал события в доступные log-файлы."
                } else {
                    "История появится после подключения; экран не нужно перезапускать."
                },
            ) {}
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(entries, key = { entry -> entry.id.ifBlank { "local:${entry.time}:${entry.message}" } }) { entry ->
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = WebPanelPalette.Surface,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(7.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = entry.time,
                                    color = WebPanelPalette.Muted,
                                    style = MaterialTheme.typography.labelSmall,
                                    fontFamily = FontFamily.Monospace,
                                )
                                Text(
                                    text = logSourceLabel(entry.source),
                                    color = WebPanelPalette.TextBlue,
                                    style = MaterialTheme.typography.labelSmall,
                                )
                                StatusChip(logLevelChip(entry.level))
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = entry.message,
                                color = if (entry.level == LogLevel.Error) WebPanelPalette.Error else WebPanelPalette.Text,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun ShellWorkspaceScreen(
    state: CompanionUiState,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .padding(14.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Text(
            text = "xkeen@${state.dashboard.instanceLabel.lowercase().replace(' ', '-')}:~$",
            color = WebPanelPalette.Success,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
        )
        state.logs.entries.forEach { entry ->
            Text(
                text = "${entry.time}  [${entry.source}]  ${entry.message}",
                color = if (entry.level == LogLevel.Error) WebPanelPalette.Error else WebPanelPalette.Text,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                lineHeight = 17.sp,
            )
        }
    }
}
