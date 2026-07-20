package io.xkeen.mobile.app

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ClearAll
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ContentPaste
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.launch

@Composable
internal fun TerminalWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val terminalView = remember { mutableStateOf<XkeenTerminalWebView?>(null) }
    val connectionState = remember(state.dashboard.endpoint) { mutableStateOf("idle") }
    val statusMessage = remember(state.dashboard.endpoint) {
        mutableStateOf("Терминал готовит защищённую PTY-сессию…")
    }
    val searchQuery = rememberSaveable { mutableStateOf("") }
    val showFind = rememberSaveable { mutableStateOf(false) }
    val confirmNewSession = rememberSaveable { mutableStateOf(false) }

    val requestConnection: (String?, Long, Int, Int) -> Unit = { sessionId, sequence, columns, rows ->
        connectionState.value = "connecting"
        statusMessage.value = if (sessionId == null) "Запрашиваем новую PTY-сессию…" else "Восстанавливаем PTY-сессию…"
        scope.launch {
            try {
                val spec = controller.issueTerminalConnection(sessionId, sequence, columns, rows)
                terminalView.value?.connect(spec)
            } catch (error: Exception) {
                connectionState.value = "error"
                statusMessage.value = when (error) {
                    is CompanionTransportException -> error.failure.userMessage
                    else -> error.message?.takeIf(String::isNotBlank)
                        ?: "Не удалось подключить терминал."
                }
            }
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background),
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

        TerminalQuickKeys(
            onInterrupt = { terminalView.value?.sendInterrupt() },
            onInput = { terminalView.value?.sendInput(it) },
        )

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
                    text = when (connectionState.value) {
                        "connected" -> "●"
                        "connecting", "reconnecting" -> "◐"
                        "error" -> "●"
                        else -> "○"
                    },
                    color = when (connectionState.value) {
                        "connected" -> WebPanelPalette.Success
                        "error" -> WebPanelPalette.Error
                        else -> WebPanelPalette.Muted
                    },
                    style = MaterialTheme.typography.labelSmall,
                )
                Text(
                    text = statusMessage.value,
                    color = WebPanelPalette.Text,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
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
private fun TerminalQuickKeys(
    onInterrupt: () -> Unit,
    onInput: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(38.dp)
            .background(WebPanelPalette.BackgroundDeep)
            .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.14f))
            .padding(horizontal = 4.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TerminalKey("CTRL+C", Modifier.weight(1.35f), onInterrupt)
        TerminalKey("TAB", Modifier.weight(1f)) { onInput("\t") }
        TerminalKey("ESC", Modifier.weight(1f)) { onInput("\u001b") }
        TerminalKey("←", Modifier.weight(0.8f)) { onInput("\u001b[D") }
        TerminalKey("↑", Modifier.weight(0.8f)) { onInput("\u001b[A") }
        TerminalKey("↓", Modifier.weight(0.8f)) { onInput("\u001b[B") }
        TerminalKey("→", Modifier.weight(0.8f)) { onInput("\u001b[C") }
    }
}

@Composable
private fun TerminalKey(
    label: String,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(7.dp)
    Box(
        modifier = modifier
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
