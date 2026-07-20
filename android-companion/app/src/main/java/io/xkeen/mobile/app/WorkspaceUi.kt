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
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.FullscreenExit
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
    isFullscreen: Boolean,
    onFullscreenChange: (Boolean) -> Unit,
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
    val workflowPrompt = rememberSaveable(selectedDocument.id) {
        mutableStateOf<RoutingWorkflowPrompt?>(null)
    }
    val workflowStep = routingWorkflowStep(selectedDocument, routing.validation)
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
            isFullscreen = isFullscreen,
            onFullscreenChange = onFullscreenChange,
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
            onSave = {
                if (workflowStep == RoutingWorkflowStep.Validate) {
                    focusManager.clearFocus(force = true)
                    workflowPrompt.value = RoutingWorkflowPrompt.ValidateBeforeSave
                } else {
                    scope.launch { controller.saveRouting() }
                }
            },
            onApply = {
                when (workflowStep) {
                    RoutingWorkflowStep.Validate -> {
                        focusManager.clearFocus(force = true)
                        workflowPrompt.value = RoutingWorkflowPrompt.ValidateBeforeApply
                    }

                    RoutingWorkflowStep.Save -> {
                        focusManager.clearFocus(force = true)
                        workflowPrompt.value = RoutingWorkflowPrompt.SaveBeforeApply
                    }

                    RoutingWorkflowStep.Apply -> controller.requestRoutingApply()
                    RoutingWorkflowStep.Complete -> Unit
                }
            },
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
    workflowPrompt.value?.let { prompt ->
        RoutingWorkflowDialog(
            prompt = prompt,
            onDismiss = { workflowPrompt.value = null },
            onConfirm = {
                workflowPrompt.value = null
                when (prompt.requiredStep) {
                    RoutingWorkflowStep.Validate -> scope.launch { controller.validateRouting() }
                    RoutingWorkflowStep.Save -> scope.launch { controller.saveRouting() }
                    RoutingWorkflowStep.Apply,
                    RoutingWorkflowStep.Complete,
                    -> Unit
                }
            },
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

        else -> StructuredTextEditor(
            value = document.draftContent,
            language = StructuredTextLanguage.Jsonc,
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
    isFullscreen: Boolean,
    onFullscreenChange: (Boolean) -> Unit,
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
    val workflowStep = routingWorkflowStep(document, validation)

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
                    icon = if (isFullscreen) Icons.Outlined.FullscreenExit else Icons.Outlined.Fullscreen,
                    description = if (isFullscreen) "Выйти из полноэкранного режима" else "Открыть редактор на весь экран",
                    onClick = { onFullscreenChange(!isFullscreen) },
                )
                EditorToolbarButton(
                    icon = Icons.AutoMirrored.Outlined.FactCheck,
                    description = if (isValidationInFlight) "Проверка выполняется" else "Проверить",
                    onClick = onValidate,
                    accent = isValidationInFlight || workflowStep == RoutingWorkflowStep.Validate,
                    accentColor = if (workflowStep == RoutingWorkflowStep.Validate) {
                        WebPanelPalette.Warning
                    } else {
                        WebPanelPalette.TextBlue
                    },
                    enabled = !isValidationInFlight && !isWriteInFlight,
                )
                EditorToolbarButton(Icons.Outlined.SettingsBackupRestore, "Откатить", onRevert)
                EditorToolbarButton(
                    icon = Icons.Outlined.Save,
                    description = "Сохранить",
                    onClick = onSave,
                    accent = workflowStep == RoutingWorkflowStep.Save,
                    accentColor = WebPanelPalette.Warning,
                    enabled = !isWriteInFlight && document.hasUnsavedChanges,
                )
                EditorToolbarButton(
                    icon = Icons.Outlined.DoneAll,
                    description = "Применить",
                    onClick = onApply,
                    accent = workflowStep == RoutingWorkflowStep.Apply,
                    accentColor = WebPanelPalette.Warning,
                    enabled = !isWriteInFlight && document.hasDraftChanges,
                )
            }
        }
    }
}

@Composable
internal fun SearchToolbarField(
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

private enum class RoutingWorkflowPrompt(
    val title: String,
    val message: String,
    val actionLabel: String,
    val requiredStep: RoutingWorkflowStep,
) {
    ValidateBeforeSave(
        title = "Сначала проверьте конфигурацию",
        message = "Сохранить можно только тот черновик, который сервер Xray подтвердил для текущего текста.",
        actionLabel = "Проверить",
        requiredStep = RoutingWorkflowStep.Validate,
    ),
    ValidateBeforeApply(
        title = "Перед применением нужна проверка",
        message = "Текущие изменения ещё не подтверждены сервером. Выполните проверку, затем сохраните черновик.",
        actionLabel = "Проверить",
        requiredStep = RoutingWorkflowStep.Validate,
    ),
    SaveBeforeApply(
        title = "Сначала сохраните черновик",
        message = "Проверка уже пройдена. Сохраните подтверждённый текст на сервере, после этого его можно применить.",
        actionLabel = "Сохранить",
        requiredStep = RoutingWorkflowStep.Save,
    ),
}

@Composable
private fun RoutingWorkflowDialog(
    prompt: RoutingWorkflowPrompt,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(13.dp),
        ) {
            Text(
                text = "ПОРЯДОК ИЗМЕНЕНИЙ",
                color = WebPanelPalette.Warning,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.7.sp,
            )
            Text(
                text = prompt.title,
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = prompt.message,
                color = WebPanelPalette.Text,
                style = MaterialTheme.typography.bodyMedium,
            )
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WebPanelPalette.Surface, RoundedCornerShape(14.dp))
                    .border(
                        1.dp,
                        WebPanelPalette.Border.copy(alpha = 0.24f),
                        RoundedCornerShape(14.dp),
                    )
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                WorkflowStepRow(1, "Проверить на сервере", prompt.requiredStep, RoutingWorkflowStep.Validate)
                WorkflowStepRow(2, "Сохранить проверенный черновик", prompt.requiredStep, RoutingWorkflowStep.Save)
                WorkflowStepRow(3, "Применить и перезапустить Xkeen", prompt.requiredStep, RoutingWorkflowStep.Apply)
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedButton(onClick = onDismiss) {
                    Text("Отмена")
                }
                Spacer(Modifier.width(9.dp))
                Button(onClick = onConfirm) {
                    Text(prompt.actionLabel)
                }
            }
        }
    }
}

@Composable
private fun WorkflowStepRow(
    number: Int,
    label: String,
    requiredStep: RoutingWorkflowStep,
    step: RoutingWorkflowStep,
) {
    val isRequired = requiredStep == step
    val isComplete = step.ordinal < requiredStep.ordinal
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Box(
            modifier = Modifier
                .size(22.dp)
                .background(
                    color = when {
                        isComplete -> WebPanelPalette.Success.copy(alpha = 0.20f)
                        isRequired -> WebPanelPalette.Warning.copy(alpha = 0.24f)
                        else -> WebPanelPalette.SurfaceRaised
                    },
                    shape = CircleShape,
                )
                .border(
                    1.dp,
                    when {
                        isComplete -> WebPanelPalette.Success.copy(alpha = 0.62f)
                        isRequired -> WebPanelPalette.Warning.copy(alpha = 0.72f)
                        else -> WebPanelPalette.Border.copy(alpha = 0.18f)
                    },
                    CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = number.toString(),
                color = when {
                    isComplete -> WebPanelPalette.Success
                    isRequired -> WebPanelPalette.Warning
                    else -> WebPanelPalette.Muted
                },
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
        }
        Text(
            text = label,
            color = if (isRequired) WebPanelPalette.TextStrong else WebPanelPalette.Muted,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = if (isRequired) FontWeight.Bold else FontWeight.Normal,
        )
    }
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
internal fun EditorToolbarButton(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
    accent: Boolean = false,
    accentColor: Color = WebPanelPalette.Border,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier = Modifier
            .size(34.dp)
            .padding(2.dp)
            .shadow(if (accent) 4.dp else 2.dp, shape)
            .background(
                brush = Brush.verticalGradient(
                    if (accent) {
                        listOf(
                            accentColor.copy(alpha = 0.24f),
                            WebPanelPalette.Surface,
                        )
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
                            accentColor.copy(alpha = 0.68f),
                            accentColor.copy(alpha = 0.22f),
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
internal fun StructuredTextEditor(
    value: String,
    language: StructuredTextLanguage,
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
                view.language = language
                editorView.value = view
                onEditorReady(view)
            }
        },
        update = { view ->
            view.language = language
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

internal enum class StructuredTextLanguage(val label: String) {
    Jsonc("JSON / JSONC"),
    List("LIST"),
    Yaml("YAML"),
}

private val PortsListNumberPattern = Regex("[0-9]+(?::[0-9]+)?")

internal fun highlightStructuredText(
    source: String,
    language: StructuredTextLanguage,
): AnnotatedString = when (language) {
    StructuredTextLanguage.Jsonc -> highlightJsonc(source)
    StructuredTextLanguage.List -> highlightList(source)
    StructuredTextLanguage.Yaml -> highlightYaml(source)
}

internal fun highlightList(source: String): AnnotatedString = buildAnnotatedString {
    append(source)
    var lineStart = 0
    while (lineStart <= source.length) {
        val lineEnd = source.indexOf('\n', lineStart).takeIf { it >= 0 } ?: source.length
        var contentStart = lineStart
        while (contentStart < lineEnd && source[contentStart].isWhitespace()) contentStart += 1
        if (contentStart < lineEnd) {
            val commentStart = source.indexOf('#', contentStart).takeIf { it in contentStart until lineEnd }
            val contentEnd = commentStart ?: lineEnd
            val trimmedEnd = source.trimmedEnd(contentStart, contentEnd)
            if (trimmedEnd > contentStart) {
                val token = source.substring(contentStart, trimmedEnd)
                val color = if (token.matches(PortsListNumberPattern)) {
                    JsonEditorPalette.Number
                } else {
                    JsonEditorPalette.String
                }
                addJsonStyle(color, contentStart, trimmedEnd)
            }
            if (commentStart != null) {
                addJsonStyle(JsonEditorPalette.Comment, commentStart, lineEnd)
            }
        }
        if (lineEnd == source.length) break
        lineStart = lineEnd + 1
    }
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

/**
 * Lightweight YAML tokenization for the mobile editor. It deliberately keeps comments and quoted
 * scalars intact and only styles plain scalars after the mapping/list punctuation has been found.
 * Server-side Mihomo validation remains authoritative.
 */
internal fun highlightYaml(source: String): AnnotatedString = buildAnnotatedString {
    append(source)
    var lineStart = 0
    while (lineStart <= source.length) {
        val lineEnd = source.indexOf('\n', lineStart).takeIf { it >= 0 } ?: source.length
        highlightYamlLine(source, lineStart, lineEnd)
        if (lineEnd == source.length) break
        lineStart = lineEnd + 1
    }
}

private fun AnnotatedString.Builder.highlightYamlLine(source: String, start: Int, end: Int) {
    var cursor = start
    while (cursor < end && source[cursor].isWhitespace()) cursor += 1
    if (cursor >= end) return

    if (source[cursor] == '-') {
        addJsonStyle(JsonEditorPalette.Punctuation, cursor, cursor + 1)
        cursor += 1
        while (cursor < end && source[cursor].isWhitespace()) cursor += 1
    }

    val commentStart = source.yamlCommentStart(cursor, end)
    val contentEnd = commentStart.takeIf { it >= 0 } ?: end
    if (commentStart >= 0) {
        addJsonStyle(JsonEditorPalette.Comment, commentStart, end)
    }
    if (cursor >= contentEnd) return

    val colon = source.yamlMappingColon(cursor, contentEnd)
    if (colon >= 0) {
        val keyEnd = source.trimmedEnd(cursor, colon)
        if (keyEnd > cursor) addJsonStyle(JsonEditorPalette.Property, cursor, keyEnd)
        addJsonStyle(JsonEditorPalette.Punctuation, colon, colon + 1)
        cursor = colon + 1
    }
    while (cursor < contentEnd && source[cursor].isWhitespace()) cursor += 1
    if (cursor >= contentEnd) return

    var tokenStart = cursor
    var quote: Char? = null
    var escaped = false
    while (cursor <= contentEnd) {
        val char = source.getOrNull(cursor)
        val atEnd = cursor == contentEnd
        if (!atEnd && quote != null) {
            if (!escaped && char == quote) {
                cursor += 1
                addJsonStyle(JsonEditorPalette.String, tokenStart, cursor)
                tokenStart = cursor
                quote = null
                continue
            }
            escaped = quote == '"' && !escaped && char == '\\'
            if (char != '\\') escaped = false
            cursor += 1
            continue
        }
        if (!atEnd && (char == '"' || char == '\'')) {
            styleYamlPlainToken(source, tokenStart, cursor)
            quote = char
            tokenStart = cursor
            cursor += 1
            continue
        }
        if (atEnd || char?.isWhitespace() == true || char == ',' || char == '[' || char == ']' || char == '{' || char == '}') {
            styleYamlPlainToken(source, tokenStart, cursor)
            if (!atEnd && char != null && !char.isWhitespace()) {
                addJsonStyle(JsonEditorPalette.Punctuation, cursor, cursor + 1)
            }
            cursor += 1
            tokenStart = cursor
            continue
        }
        cursor += 1
    }
    if (quote != null && tokenStart < contentEnd) {
        addJsonStyle(JsonEditorPalette.String, tokenStart, contentEnd)
    }
}

private fun AnnotatedString.Builder.styleYamlPlainToken(source: String, start: Int, end: Int) {
    if (start >= end) return
    val token = source.substring(start, end).trim()
    if (token.isEmpty()) return
    val tokenStart = start + source.substring(start, end).indexOfFirst { !it.isWhitespace() }.coerceAtLeast(0)
    val color = when {
        token.startsWith("&") || token.startsWith("*") || token.startsWith("!") -> JsonEditorPalette.Keyword
        token.equals("true", true) || token.equals("false", true) ||
            token.equals("null", true) || token == "~" -> JsonEditorPalette.Keyword
        token.toDoubleOrNull() != null -> JsonEditorPalette.Number
        else -> JsonEditorPalette.String
    }
    addJsonStyle(color, tokenStart, tokenStart + token.length)
}

private fun String.yamlCommentStart(start: Int, end: Int): Int {
    var quote: Char? = null
    var escaped = false
    for (index in start until end) {
        val char = this[index]
        if (quote != null) {
            if (!escaped && char == quote) quote = null
            escaped = quote == '"' && !escaped && char == '\\'
            if (char != '\\') escaped = false
        } else if (char == '"' || char == '\'') {
            quote = char
        } else if (char == '#' && (index == start || this[index - 1].isWhitespace())) {
            return index
        }
    }
    return -1
}

private fun String.yamlMappingColon(start: Int, end: Int): Int {
    var quote: Char? = null
    var depth = 0
    for (index in start until end) {
        val char = this[index]
        if (quote != null) {
            if (char == quote && (index == start || this[index - 1] != '\\')) quote = null
            continue
        }
        when (char) {
            '"', '\'' -> quote = char
            '[', '{' -> depth += 1
            ']', '}' -> depth = (depth - 1).coerceAtLeast(0)
            ':' -> if (depth == 0 && (index + 1 == end || this[index + 1].isWhitespace())) return index
        }
    }
    return -1
}

private fun String.trimmedEnd(start: Int, end: Int): Int {
    var result = end
    while (result > start && this[result - 1].isWhitespace()) result -= 1
    return result
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

    EditorMetricsStatusBar(
        statusText = presentation.text,
        statusColor = presentation.color,
        metrics = metrics,
        onClick = onClick,
    )
}

@Composable
internal fun EditorMetricsStatusBar(
    statusText: String,
    statusColor: Color,
    metrics: EditorMetrics,
    onClick: () -> Unit,
) {

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
                .background(statusColor, CircleShape),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = statusText,
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
    val workflowStep = routingWorkflowStep(document, validation)
    val text = when {
        document.isLoading -> "Загрузка с Xkeen UI…"
        document.loadError != null -> document.loadError
        write.isPending || write.phase in setOf(
            RoutingWritePhase.Conflict,
            RoutingWritePhase.Failure,
            RoutingWritePhase.Success,
        ) -> write.message
        validation.state == RoutingValidationState.Validating -> validation.displayMessage
        validation.state == RoutingValidationState.Invalid -> validation.displayMessage
        workflowStep == RoutingWorkflowStep.Validate -> "Шаг 1 из 3 · Проверьте конфигурацию"
        workflowStep == RoutingWorkflowStep.Save -> "Шаг 2 из 3 · Сохраните проверенный черновик"
        workflowStep == RoutingWorkflowStep.Apply -> "Шаг 3 из 3 · Примените изменения"
        validation.state == RoutingValidationState.Valid -> validation.displayMessage
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
        workflowStep != RoutingWorkflowStep.Complete -> WebPanelPalette.Warning
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
