package io.xkeen.mobile.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ClearAll
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.FullscreenExit
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.launch

@Composable
internal fun TerminalWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    isFullscreen: Boolean,
    onFullscreenChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val isImeVisible = WindowInsets.ime.getBottom(density) > 0
    val terminalView = remember { mutableStateOf<XkeenTerminalWebView?>(null) }
    val connectionState = remember(state.dashboard.endpoint) { mutableStateOf("idle") }
    val statusMessage = remember(state.dashboard.endpoint) {
        mutableStateOf("Терминал готовит защищённую PTY-сессию…")
    }
    val searchQuery = rememberSaveable { mutableStateOf("") }
    val showFind = rememberSaveable { mutableStateOf(false) }
    val confirmNewSession = rememberSaveable { mutableStateOf(false) }

    BackHandler(enabled = !isImeVisible && (showFind.value || isFullscreen)) {
        if (showFind.value) {
            searchQuery.value = ""
            showFind.value = false
        } else {
            onFullscreenChange(false)
        }
    }

    val requestConnection: (String?, Long, Int, Int) -> Unit = { sessionId, sequence, columns, rows ->
        connectionState.value = "connecting"
        statusMessage.value = if (sessionId == null) "Запрашиваем новую PTY-сессию…" else "Восстанавливаем PTY-сессию…"
        scope.launch {
            try {
                val spec = controller.issueTerminalConnection(sessionId, sequence, columns, rows)
                terminalView.value?.connect(spec)
            } catch (error: Exception) {
                val message = when (error) {
                    is CompanionTransportException -> error.failure.userMessage
                    else -> error.message?.takeIf(String::isNotBlank)
                        ?: "Не удалось подключить терминал."
                }
                connectionState.value = "error"
                statusMessage.value = message
                terminalView.value?.connectionRequestFailed(message)
            }
        }
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
                        value = searchQuery.value,
                        onValueChange = { searchQuery.value = it },
                        onSearch = { terminalView.value?.find(searchQuery.value, forward = true) },
                        modifier = Modifier.weight(1f),
                    )
                    EditorToolbarButton(
                        Icons.Outlined.KeyboardArrowUp,
                        "Предыдущее совпадение",
                        onClick = { terminalView.value?.find(searchQuery.value, forward = false) },
                        enabled = searchQuery.value.isNotBlank(),
                    )
                    EditorToolbarButton(
                        Icons.Outlined.KeyboardArrowDown,
                        "Следующее совпадение",
                        onClick = { terminalView.value?.find(searchQuery.value, forward = true) },
                        enabled = searchQuery.value.isNotBlank(),
                    )
                    EditorToolbarButton(Icons.Outlined.Close, "Закрыть поиск", onClick = {
                        searchQuery.value = ""
                        showFind.value = false
                        terminalView.value?.focusTerminal()
                    })
                } else {
                    Row(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .padding(start = 9.dp, end = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "Терминал",
                            color = WebPanelPalette.TextStrong,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = "  PTY",
                            color = WebPanelPalette.Muted,
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                    EditorToolbarButton(
                        icon = if (isFullscreen) Icons.Outlined.FullscreenExit else Icons.Outlined.Fullscreen,
                        description = if (isFullscreen) {
                            "Выйти из полноэкранного терминала"
                        } else {
                            "Открыть терминал на весь экран"
                        },
                        onClick = { onFullscreenChange(!isFullscreen) },
                    )
                    EditorToolbarButton(Icons.Outlined.Refresh, "Переподключить терминал", onClick = {
                        terminalView.value?.reconnect()
                    })
                    EditorToolbarButton(Icons.Outlined.Add, "Новая PTY-сессия", onClick = {
                        confirmNewSession.value = true
                    })
                    EditorToolbarButton(Icons.Outlined.ClearAll, "Очистить экран", onClick = {
                        terminalView.value?.clearTerminal()
                    })
                    EditorToolbarButton(Icons.Outlined.ContentCopy, "Копировать выделение", onClick = {
                        terminalView.value?.copySelection()
                    })
                    EditorToolbarButton(Icons.Outlined.ContentPaste, "Вставить из буфера", onClick = {
                        terminalView.value?.pasteClipboard()
                    })
                    EditorToolbarButton(Icons.Outlined.Search, "Поиск в терминале", onClick = {
                        showFind.value = true
                    })
                }
            }
        }

        AndroidView(
            factory = { context ->
                XkeenTerminalWebView(context, state.dashboard.endpoint).also { view ->
                    terminalView.value = view
                    view.onTerminalReady = { columns, rows ->
                        val (sessionId, sequence) = view.resumeSnapshot()
                        requestConnection(sessionId, sequence, columns, rows)
                    }
                    view.onConnectionRequested = requestConnection
                    view.onTerminalStateChanged = { terminalState, message ->
                        connectionState.value = terminalState
                        statusMessage.value = message
                    }
                }
            },
            update = { view ->
                view.onConnectionRequested = requestConnection
                view.onTerminalStateChanged = { terminalState, message ->
                    connectionState.value = terminalState
                    statusMessage.value = message
                }
            },
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(Color(0xFF01030A)),
        )

        TerminalConnectionStatus(
            connectionState = connectionState.value,
            statusMessage = statusMessage.value,
        )

        TerminalQuickKeys(
            onInterrupt = { terminalView.value?.sendInterrupt() },
            onInput = { terminalView.value?.sendInput(it) },
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            terminalView.value?.release()
            terminalView.value = null
        }
    }

    if (confirmNewSession.value) {
        XkeenDialog(onDismissRequest = { confirmNewSession.value = false }) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Закрыть текущую PTY-сессию?", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Запущенные в foreground процессы получат завершение сессии. После этого откроется новый shell.",
                    color = WebPanelPalette.Muted,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    OutlinedButton(onClick = { confirmNewSession.value = false }) { Text("Отмена") }
                    Button(
                        onClick = {
                            confirmNewSession.value = false
                            terminalView.value?.newSession()
                        },
                        modifier = Modifier.padding(start = 8.dp),
                    ) { Text("Новая сессия") }
                }
            }
        }
    }
}

@Composable
private fun TerminalConnectionStatus(
    connectionState: String,
    statusMessage: String,
) {
    Surface(color = Color(0xFF071120)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(28.dp)
                .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.16f))
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = when (connectionState) {
                    "connected" -> "●"
                    "connecting", "reconnecting" -> "◐"
                    "error" -> "●"
                    else -> "○"
                },
                color = when (connectionState) {
                    "connected" -> WebPanelPalette.Success
                    "error" -> WebPanelPalette.Error
                    else -> WebPanelPalette.Muted
                },
                style = MaterialTheme.typography.labelSmall,
            )
            Text(
                text = statusMessage,
                color = WebPanelPalette.Text,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun TerminalQuickKeys(
    onInterrupt: () -> Unit,
    onInput: (String) -> Unit,
) {
    val scrollState = rememberScrollState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp)
            .background(WebPanelPalette.BackgroundDeep)
            .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.14f))
            .padding(horizontal = 4.dp, vertical = 3.dp)
            .horizontalScroll(scrollState),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TerminalKey("CTRL+C", 68.dp, onInterrupt)
        TerminalKey("TAB", 48.dp) { onInput("\t") }
        TerminalKey("ESC", 48.dp) { onInput("\u001b") }
        TerminalKey("←", 42.dp) { onInput("\u001b[D") }
        TerminalKey("↑", 42.dp) { onInput("\u001b[A") }
        TerminalKey("↓", 42.dp) { onInput("\u001b[B") }
        TerminalKey("→", 42.dp) { onInput("\u001b[C") }
        TerminalKey("|", 42.dp) { onInput("|") }
        TerminalKey("/", 42.dp) { onInput("/") }
        TerminalKey("-", 42.dp) { onInput("-") }
        TerminalKey("HOME", 60.dp) { onInput("\u001b[H") }
        TerminalKey("END", 54.dp) { onInput("\u001b[F") }
        TerminalKey("PG↑", 54.dp) { onInput("\u001b[5~") }
        TerminalKey("PG↓", 54.dp) { onInput("\u001b[6~") }
        TerminalKey("DEL", 52.dp) { onInput("\u001b[3~") }
        TerminalKey("CTRL+L", 68.dp) { onInput("\u000c") }
    }
}

@Composable
private fun TerminalKey(
    label: String,
    width: Dp,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(7.dp)
    Box(
        modifier = Modifier
            .width(width)
            .fillMaxHeight()
            .background(WebPanelPalette.SurfaceRaised, shape)
            .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f), shape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = WebPanelPalette.TextBlue,
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}
