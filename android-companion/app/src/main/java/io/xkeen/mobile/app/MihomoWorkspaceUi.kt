package io.xkeen.mobile.app

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FactCheck
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.FullscreenExit
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.launch

@Composable
internal fun MihomoRoutingWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    isFullscreen: Boolean,
    onFullscreenChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val config = state.mihomoConfig
    val scope = rememberCoroutineScope()
    val editorView = remember { mutableStateOf<AdvancedJsonEditorView?>(null) }
    val metrics = remember(config.activeProfile) { mutableStateOf(EditorMetrics()) }
    val showFind = rememberSaveable { mutableStateOf(false) }
    val findQuery = rememberSaveable { mutableStateOf("") }
    val findResult = remember { mutableStateOf(EditorTextSearchResult()) }
    val confirmRestart = rememberSaveable { mutableStateOf(false) }
    val showStatusDetails = rememberSaveable { mutableStateOf(false) }
    val findFocusRequester = remember { FocusRequester() }

    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshMihomoConfig()
    }
    LaunchedEffect(showFind.value) {
        if (showFind.value) findFocusRequester.requestFocus()
    }
    LaunchedEffect(config.editorHighlight?.token, editorView.value) {
        val highlight = config.editorHighlight ?: return@LaunchedEffect
        val editor = editorView.value ?: return@LaunchedEffect
        editor.highlightImportedRange(highlight.start, highlight.end)
        controller.consumeMihomoEditorHighlight(highlight.token)
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
                            color = WebPanelPalette.Muted,
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 4.dp),
                            maxLines = 1,
                        )
                    }
                    EditorToolbarButton(Icons.Outlined.KeyboardArrowUp, "Предыдущее совпадение", onClick = {
                        findResult.value = editorView.value?.findText(findQuery.value, false)
                            ?: EditorTextSearchResult()
                    })
                    EditorToolbarButton(Icons.Outlined.KeyboardArrowDown, "Следующее совпадение", onClick = {
                        findResult.value = editorView.value?.findText(findQuery.value, true)
                            ?: EditorTextSearchResult()
                    })
                    EditorToolbarButton(Icons.Outlined.Close, "Закрыть поиск", onClick = {
                        editorView.value?.clearSearchHighlight()
                        showFind.value = false
                        findQuery.value = ""
                        findResult.value = EditorTextSearchResult()
                    })
                } else {
                    PersistentEditorToolbarContent(
                        layoutId = EditorToolbarLayoutId.MihomoConfig,
                        title = config.activeProfile,
                        detail = "YAML",
                        onTitleClick = null,
                        editor = editorView.value,
                        editorMetrics = metrics.value,
                        editorActionsEnabled = config.hasLoaded && !config.isBusy,
                        searchDescription = "Поиск в YAML",
                        onSearchClick = { showFind.value = true },
                        searchEnabled = config.hasLoaded,
                    ) {
                        EditorToolbarButton(
                            icon = if (isFullscreen) Icons.Outlined.FullscreenExit else Icons.Outlined.Fullscreen,
                            description = if (isFullscreen) "Выйти из полноэкранного режима" else "Открыть редактор на весь экран",
                            onClick = { onFullscreenChange(!isFullscreen) },
                        )
                        EditorToolbarButton(
                            icon = Icons.AutoMirrored.Outlined.FactCheck,
                            description = "Проверить YAML через Mihomo",
                            onClick = { scope.launch { controller.validateMihomoConfig() } },
                            accent = config.operation == MihomoConfigOperationPhase.Validating ||
                                (config.hasChanges && !config.isCurrentContentValid),
                            accentColor = if (config.hasChanges && !config.isCurrentContentValid) {
                                WebPanelPalette.Warning
                            } else {
                                WebPanelPalette.TextBlue
                            },
                            enabled = config.hasLoaded && !config.isBusy,
                        )
                        EditorToolbarButton(
                            Icons.Outlined.SettingsBackupRestore,
                            "Откатить локальные изменения",
                            controller::revertMihomoConfig,
                            enabled = config.hasChanges && !config.isBusy,
                        )
                        EditorToolbarButton(
                            icon = Icons.Outlined.Save,
                            description = "Сохранить проверенный YAML",
                            onClick = { scope.launch { controller.saveMihomoConfig(restart = false) } },
                            accent = config.hasChanges && config.isCurrentContentValid,
                            accentColor = WebPanelPalette.Warning,
                            enabled = config.hasChanges && config.isCurrentContentValid && !config.isBusy,
                        )
                        EditorToolbarButton(
                            icon = Icons.Outlined.DoneAll,
                            description = "Применить YAML и перезапустить Mihomo",
                            onClick = { confirmRestart.value = true },
                            accent = config.hasChanges && config.isCurrentContentValid,
                            accentColor = WebPanelPalette.Warning,
                            enabled = config.hasChanges && config.isCurrentContentValid && !config.isBusy,
                        )
                    }
                }
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                config.operation == MihomoConfigOperationPhase.Loading -> CircularProgressIndicator(
                    color = WebPanelPalette.Accent,
                    modifier = Modifier.align(Alignment.Center),
                )

                !config.hasLoaded -> Column(
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(config.message, color = WebPanelPalette.Error)
                    OutlinedButton(onClick = { scope.launch { controller.refreshMihomoConfig(force = true) } }) {
                        Text("Повторить")
                    }
                }

                else -> StructuredTextEditor(
                    value = config.content,
                    language = StructuredTextLanguage.Yaml,
                    onValueChange = controller::updateMihomoConfig,
                    onMetricsChange = { metrics.value = it },
                    onEditorReady = { editorView.value = it },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }

        if (config.operation == MihomoConfigOperationPhase.Failure && config.validationLog.isNotBlank()) {
            Surface(
                color = Color(0xFF341014),
                modifier = Modifier.border(1.dp, WebPanelPalette.Error.copy(alpha = 0.28f)),
            ) {
                Text(
                    text = config.validationLog,
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                )
            }
        }
        EditorMetricsStatusBar(
            statusText = config.message,
            statusColor = config.statusColor(),
            metrics = metrics.value,
            onClick = { showStatusDetails.value = true },
        )
    }

    if (showStatusDetails.value) {
        MihomoEditorStatusDialog(
            config = config,
            metrics = metrics.value,
            onDismiss = { showStatusDetails.value = false },
        )
    }

    if (confirmRestart.value) {
        XkeenDialog(onDismissRequest = { confirmRestart.value = false }) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Применить YAML и перезапустить Mihomo?", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Сервер создаст резервную копию активного профиля. Конфигурация уже прошла mihomo -t.",
                    color = WebPanelPalette.Muted,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    OutlinedButton(onClick = { confirmRestart.value = false }) { Text("Отмена") }
                    Button(
                        onClick = {
                            confirmRestart.value = false
                            scope.launch { controller.saveMihomoConfig(restart = true) }
                        },
                        modifier = Modifier.padding(start = 8.dp),
                    ) { Text("Применить") }
                }
            }
        }
    }
}

private fun MihomoConfigState.statusColor(): Color = when {
    operation == MihomoConfigOperationPhase.Failure -> WebPanelPalette.Error
    operation == MihomoConfigOperationPhase.Success -> WebPanelPalette.Success
    operation in setOf(
        MihomoConfigOperationPhase.Loading,
        MihomoConfigOperationPhase.Validating,
        MihomoConfigOperationPhase.Saving,
        MihomoConfigOperationPhase.Restarting,
    ) -> WebPanelPalette.TextBlue
    hasChanges -> WebPanelPalette.Warning
    else -> WebPanelPalette.Muted
}

@Composable
private fun MihomoEditorStatusDialog(
    config: MihomoConfigState,
    metrics: EditorMetrics,
    onDismiss: () -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "СТАТУС РЕДАКТОРА",
                color = config.statusColor(),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = config.activeProfile,
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            MihomoStatusDetail("Состояние", config.message)
            MihomoStatusDetail("Формат", "server · YAML")
            if (config.validationLog.isNotBlank()) {
                MihomoStatusDetail("Проверка Mihomo", config.validationLog)
            }
            MihomoStatusDetail("Символов", metrics.characterCount.toString())
            MihomoStatusDetail("Слов", metrics.wordCount.toString())
            MihomoStatusDetail(
                "Текущая позиция курсора",
                "строка ${metrics.cursor.line}, столбец ${metrics.cursor.column}",
            )
            MihomoStatusDetail("Строк", metrics.lineCount.toString())
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
private fun MihomoStatusDetail(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
        Text(value, color = WebPanelPalette.Text, style = MaterialTheme.typography.bodyMedium)
    }
}
