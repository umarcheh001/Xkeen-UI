package io.xkeen.mobile.app

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.withContext

@Composable
internal fun LogsWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val logs = state.logs
    var projection by remember { mutableStateOf(XrayLogsProjection(emptyList(), 0)) }
    val listState = rememberLazyListState()
    val clipboard = LocalClipboardManager.current
    val filterSignature = "${logs.streamFilter}|${logs.levelFilter}|${logs.useRegex}|${logs.searchQuery}"
    var showSettings by rememberSaveable { mutableStateOf(false) }
    var copiedCount by rememberSaveable { mutableStateOf<Int?>(null) }
    var lastSeenTailId by rememberSaveable { mutableStateOf<String?>(null) }
    var appliedFilterSignature by rememberSaveable { mutableStateOf(filterSignature) }

    LaunchedEffect(
        logs.entries,
        logs.streamFilter,
        logs.levelFilter,
        logs.searchQuery,
        logs.useRegex,
    ) {
        if (logs.searchQuery.isNotBlank()) delay(140)
        val updatedProjection = withContext(Dispatchers.Default) { logs.projectXrayLogs() }
        projection = updatedProjection
        if (appliedFilterSignature != filterSignature) {
            lastSeenTailId = updatedProjection.entries.lastOrNull()?.xrayViewerIdentity()
            appliedFilterSignature = filterSignature
        }
    }

    LaunchedEffect(
        projection.entries.lastOrNull()?.id,
        projection.entries.size,
        logs.followNewest,
    ) {
        if (logs.followNewest && projection.entries.isNotEmpty()) {
            listState.scrollToItem(projection.entries.lastIndex)
            lastSeenTailId = projection.entries.last().xrayViewerIdentity()
        }
    }
    LaunchedEffect(listState, logs.followNewest, projection.entries.size) {
        if (!logs.followNewest) return@LaunchedEffect
        snapshotFlow {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index
            listState.isScrollInProgress && lastVisible != null && lastVisible < projection.entries.lastIndex
        }
            .distinctUntilChanged()
            .collect { scrolledAway ->
                if (scrolledAway) controller.setXrayLogsFollowNewest(false)
            }
    }
    LaunchedEffect(copiedCount) {
        if (copiedCount != null) {
            delay(1_500)
            copiedCount = null
        }
    }
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        XrayLogsHeader(
            logs = logs,
            canCopy = projection.entries.isNotEmpty(),
            onPauseToggle = { controller.setXrayLogsPausedByUser(!logs.isPausedByUser) },
            onFollowToggle = { controller.setXrayLogsFollowNewest(!logs.followNewest) },
            onCopy = {
                val payload = projection.entries.toXrayLogsClipboardPayload()
                runCatching { clipboard.setText(AnnotatedString(payload.text)) }
                    .onSuccess { copiedCount = payload.entryCount }
            },
            onSettings = { showSettings = true },
        )

        XrayLogsStreamSelector(
            logs = logs,
            onSelect = controller::updateXrayLogStreamFilter,
        )
        XrayLogsLevelSelector(
            selected = logs.levelFilter,
            onSelect = controller::updateXrayLogLevelFilter,
        )
        XrayLogsSearchField(
            value = logs.searchQuery,
            regex = logs.useRegex,
            error = projection.regexError,
            onValueChange = controller::updateXrayLogSearchQuery,
            onRegexToggle = { controller.setXrayLogRegexEnabled(!logs.useRegex) },
            onClear = { controller.updateXrayLogSearchQuery("") },
        )

        XrayLogsMetaRow(
            shown = projection.entries.size,
            total = projection.totalXrayEntries,
            unseen = projection.entries.unseenXrayEntriesAfter(lastSeenTailId),
            copiedCount = copiedCount,
            followNewest = logs.followNewest,
            onJumpToNewest = {
                controller.setXrayLogsFollowNewest(true)
            },
        )

        XrayLogsNotice(logs = logs)

        if (projection.entries.isEmpty()) {
            XrayLogsEmptyState(logs, projection.regexError)
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                itemsIndexed(
                    items = projection.entries,
                    key = { index, entry -> entry.viewerKey(index) },
                ) { index, entry ->
                    XrayLogEntryRow(
                        entry = entry,
                        ordinal = index + 1,
                        compact = logs.compactRows,
                    )
                }
            }
        }
    }

    if (showSettings) {
        XrayLogsSettingsDialog(
            logs = logs,
            onDismiss = { showSettings = false },
            onLimitChange = controller::updateXrayLogsDisplayLimit,
            onCompactRowsChange = controller::setXrayLogsCompactRows,
            onFollowNewestChange = controller::setXrayLogsFollowNewest,
            onClear = {
                controller.clearXrayLogsView()
                showSettings = false
            },
        )
    }
}

@Composable
private fun XrayLogsHeader(
    logs: LogsState,
    canCopy: Boolean,
    onPauseToggle: () -> Unit,
    onFollowToggle: () -> Unit,
    onCopy: () -> Unit,
    onSettings: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = "Логи Xray",
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Box(
                    Modifier
                        .size(7.dp)
                        .background(xrayLogsConnectionColor(logs), CircleShape),
                )
                Text(
                    text = xrayLogsConnectionLabel(logs),
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        XrayLogsIconAction(
            icon = if (logs.isPausedByUser) Icons.Outlined.PlayArrow else Icons.Outlined.Pause,
            description = if (logs.isPausedByUser) "Продолжить обновление" else "Пауза",
            selected = logs.isPausedByUser,
            onClick = onPauseToggle,
        )
        Spacer(Modifier.width(5.dp))
        XrayLogsIconAction(
            icon = Icons.Outlined.ArrowDownward,
            description = "Следовать за новыми записями",
            selected = logs.followNewest,
            onClick = onFollowToggle,
        )
        Spacer(Modifier.width(5.dp))
        XrayLogsIconAction(
            icon = Icons.Outlined.ContentCopy,
            description = "Копировать видимые записи",
            enabled = canCopy,
            onClick = onCopy,
        )
        Spacer(Modifier.width(5.dp))
        XrayLogsIconAction(
            icon = Icons.Outlined.Tune,
            description = "Настройки просмотра",
            onClick = onSettings,
        )
    }
}

@Composable
private fun XrayLogsStreamSelector(
    logs: LogsState,
    onSelect: (XrayLogStreamFilter) -> Unit,
) {
    val counts = remember(logs.entries) {
        mapOf(
            XrayLogStreamFilter.All to logs.entries.count {
                it.source.equals("xray", true) || it.source.startsWith("xray-", true)
            },
            XrayLogStreamFilter.Access to logs.entries.count { it.source.equals("xray-access", true) },
            XrayLogStreamFilter.Error to logs.entries.count { it.source.equals("xray-error", true) },
        )
    }
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        XrayLogStreamFilter.entries.forEach { filter ->
            val available = when (filter) {
                XrayLogStreamFilter.All -> null
                XrayLogStreamFilter.Access -> logs.streamAvailability["access"]
                XrayLogStreamFilter.Error -> logs.streamAvailability["error"]
            }
            XrayLogsSegment(
                label = when (filter) {
                    XrayLogStreamFilter.All -> "ВСЕ"
                    XrayLogStreamFilter.Access -> "ACCESS"
                    XrayLogStreamFilter.Error -> "ERROR"
                },
                count = counts[filter] ?: 0,
                selected = logs.streamFilter == filter,
                available = available,
                modifier = Modifier.weight(1f),
                onClick = { onSelect(filter) },
            )
        }
    }
}

@Composable
private fun XrayLogsLevelSelector(
    selected: XrayLogLevelFilter,
    onSelect: (XrayLogLevelFilter) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        XrayLogLevelFilter.entries.forEach { filter ->
            val color = when (filter) {
                XrayLogLevelFilter.Info -> WebPanelPalette.Border
                XrayLogLevelFilter.Warning -> WebPanelPalette.Warning
                XrayLogLevelFilter.Error -> WebPanelPalette.Error
                XrayLogLevelFilter.All -> WebPanelPalette.TextBlue
            }
            XrayLogsLevelChip(
                label = when (filter) {
                    XrayLogLevelFilter.All -> "ВСЕ"
                    XrayLogLevelFilter.Info -> "INFO"
                    XrayLogLevelFilter.Warning -> "WARN"
                    XrayLogLevelFilter.Error -> "ERROR"
                },
                color = color,
                selected = selected == filter,
                modifier = Modifier.weight(1f),
                onClick = { onSelect(filter) },
            )
        }
    }
}

@Composable
private fun XrayLogsSearchField(
    value: String,
    regex: Boolean,
    error: String?,
    onValueChange: (String) -> Unit,
    onRegexToggle: () -> Unit,
    onClear: () -> Unit,
) {
    val shape = RoundedCornerShape(8.dp)
    val borderColor = if (error != null) WebPanelPalette.Error else WebPanelPalette.Border
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodySmall.copy(color = WebPanelPalette.TextStrong),
            cursorBrush = SolidColor(WebPanelPalette.Border),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = {}),
            modifier = Modifier.fillMaxWidth(),
            decorationBox = { inner ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(36.dp)
                        .background(WebPanelPalette.Surface, shape)
                        .border(1.dp, borderColor.copy(alpha = if (error != null) 0.65f else 0.18f), shape)
                        .padding(start = 8.dp, end = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Icon(Icons.Outlined.Search, null, tint = WebPanelPalette.Muted, modifier = Modifier.size(15.dp))
                    Box(modifier = Modifier.weight(1f)) {
                        if (value.isBlank()) {
                            Text(
                                text = if (regex) "Поиск по Regex" else "Поиск по журналу",
                                color = WebPanelPalette.MutedDeep,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 1,
                            )
                        }
                        inner()
                    }
                    XrayLogsRegexButton(selected = regex, onClick = onRegexToggle)
                    if (value.isNotEmpty()) {
                        XrayLogsIconAction(
                            icon = Icons.Outlined.Close,
                            description = "Очистить поиск",
                            border = false,
                            size = 26,
                            onClick = onClear,
                        )
                    }
                }
            },
        )
        if (error != null) {
            Text(error, color = WebPanelPalette.Error, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun XrayLogsMetaRow(
    shown: Int,
    total: Int,
    unseen: Int,
    copiedCount: Int?,
    followNewest: Boolean,
    onJumpToNewest: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = if (copiedCount != null) {
                "Скопировано: $copiedCount из $shown"
            } else {
                "Показано: $shown из $total"
            },
            modifier = Modifier.weight(1f),
            color = if (copiedCount != null) WebPanelPalette.Success else WebPanelPalette.Muted,
            style = MaterialTheme.typography.labelSmall,
        )
        Text(
            text = if (followNewest) {
                "авто · в конец"
            } else if (unseen > 0) {
                "$unseen новых · в конец"
            } else {
                "перейти в конец"
            },
            modifier = Modifier
                .clickable(enabled = !followNewest, onClick = onJumpToNewest)
                .padding(horizontal = 3.dp, vertical = 2.dp),
            color = if (followNewest) WebPanelPalette.Success else WebPanelPalette.TextBlue,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun XrayLogsNotice(logs: LogsState) {
    val unavailable = when (logs.streamFilter) {
        XrayLogStreamFilter.All -> logs.streamAvailability.isNotEmpty() && logs.streamAvailability.values.any { !it }
        XrayLogStreamFilter.Access -> logs.streamAvailability["access"] == false
        XrayLogStreamFilter.Error -> logs.streamAvailability["error"] == false
    }
    val needsNotice = unavailable || logs.connection == LogsConnectionState.Reconnecting ||
        logs.connection == LogsConnectionState.AuthRequired
    if (!needsNotice) return

    val error = logs.connection == LogsConnectionState.AuthRequired
    val color = if (error) WebPanelPalette.Error else WebPanelPalette.Warning
    val message = if (unavailable && logs.connection == LogsConnectionState.Connected) {
        when (logs.streamFilter) {
            XrayLogStreamFilter.Access -> "access.log пока недоступен на узле."
            XrayLogStreamFilter.Error -> "error.log пока недоступен на узле."
            XrayLogStreamFilter.All -> if (logs.streamAvailability.values.none { it }) {
                "Файлы Xray-логов пока недоступны на узле."
            } else {
                "Один из файлов Xray-логов пока недоступен на узле."
            }
        }
    } else {
        logs.statusMessage
    }
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = color.copy(alpha = 0.07f),
        border = BorderStroke(1.dp, color.copy(alpha = 0.22f)),
    ) {
        Text(
            text = message,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 5.dp),
            color = color,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ColumnScope.XrayLogsEmptyState(logs: LogsState, regexError: String?) {
    val message = when {
        regexError != null -> "Исправьте выражение, чтобы продолжить поиск."
        logs.searchQuery.isNotBlank() || logs.levelFilter != XrayLogLevelFilter.All -> "По текущему фильтру записей нет."
        logs.streamFilter == XrayLogStreamFilter.Access && logs.streamAvailability["access"] == false -> "access.log недоступен или ещё не создан."
        logs.streamFilter == XrayLogStreamFilter.Error && logs.streamAvailability["error"] == false -> "error.log недоступен или ещё не создан."
        logs.streamFilter == XrayLogStreamFilter.All &&
            logs.streamAvailability.isNotEmpty() &&
            logs.streamAvailability.values.none { it } -> "Файлы Xray-логов недоступны или ещё не созданы."
        logs.connection == LogsConnectionState.Connecting -> "Загружаем историю Xray-логов…"
        logs.isPausedByUser -> "История пуста. Нажмите ▶, чтобы начать загрузку."
        else -> "Новых записей пока нет. Экран обновится автоматически."
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .weight(1f),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
            color = WebPanelPalette.Panel,
            border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.12f)),
        ) {
            Text(
                text = message,
                modifier = Modifier.padding(16.dp),
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun XrayLogEntryRow(
    entry: LogEntry,
    ordinal: Int,
    compact: Boolean,
) {
    var expanded by rememberSaveable(entry.id, entry.message) { mutableStateOf(false) }
    val severity = xrayLogLevelColor(entry.level)
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded },
        shape = RoundedCornerShape(8.dp),
        color = Color(0xFF071229),
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.10f)),
    ) {
        Row(modifier = Modifier.height(IntrinsicSize.Min)) {
            Box(
                Modifier
                    .width(2.dp)
                    .fillMaxHeight()
                    .background(severity),
            )
            Column(
                modifier = Modifier.padding(horizontal = 8.dp, vertical = if (compact) 6.dp else 8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = ordinal.toString(),
                        color = WebPanelPalette.MutedDeep,
                        style = MaterialTheme.typography.labelSmall,
                        fontFamily = FontFamily.Monospace,
                    )
                    Spacer(Modifier.width(7.dp))
                    Text(
                        text = entry.time,
                        color = WebPanelPalette.Muted,
                        style = MaterialTheme.typography.labelSmall,
                        fontFamily = FontFamily.Monospace,
                    )
                    Spacer(Modifier.width(7.dp))
                    Text(
                        text = if (entry.source.equals("xray-access", true)) "ACCESS" else "ERROR",
                        color = if (entry.source.equals("xray-access", true)) WebPanelPalette.TextBlue else WebPanelPalette.Warning,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        text = xrayLogLevelLabel(entry.level),
                        color = severity,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Text(
                    text = entry.displayMessage(),
                    color = if (entry.level == LogLevel.Error) Color(0xFFFECACA) else WebPanelPalette.Text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = if (compact) 11.sp else 12.sp,
                    lineHeight = if (compact) 15.sp else 17.sp,
                    maxLines = if (expanded || !compact) Int.MAX_VALUE else 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun XrayLogsSettingsDialog(
    logs: LogsState,
    onDismiss: () -> Unit,
    onLimitChange: (Int) -> Unit,
    onCompactRowsChange: (Boolean) -> Unit,
    onFollowNewestChange: (Boolean) -> Unit,
    onClear: () -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Настройки журнала",
                        color = WebPanelPalette.TextStrong,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = "Только локальное отображение",
                        color = WebPanelPalette.Muted,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                XrayLogsIconAction(Icons.Outlined.Close, "Закрыть", onClick = onDismiss)
            }

            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Лимит буфера", color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(200, 400, 600).forEach { limit ->
                        XrayLogsSettingsChoice(
                            label = limit.toString(),
                            selected = logs.displayLimit == limit,
                            modifier = Modifier.weight(1f),
                            onClick = { onLimitChange(limit) },
                        )
                    }
                }
            }

            XrayLogsSettingSwitch(
                title = "Компактные строки",
                subtitle = "Сворачивать длинные записи до трёх строк",
                checked = logs.compactRows,
                onCheckedChange = onCompactRowsChange,
            )
            XrayLogsSettingSwitch(
                title = "Автопрокрутка",
                subtitle = "Показывать новые записи в конце журнала",
                checked = logs.followNewest,
                onCheckedChange = onFollowNewestChange,
            )

            OutlinedButton(
                onClick = onClear,
                modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp),
                border = BorderStroke(1.dp, WebPanelPalette.Error.copy(alpha = 0.45f)),
            ) {
                Icon(Icons.Outlined.DeleteOutline, null, tint = WebPanelPalette.Error, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(7.dp))
                Text("Очистить экран", color = WebPanelPalette.Error, style = MaterialTheme.typography.labelMedium)
            }
            Text(
                text = "Файлы на роутере не удаляются. Новые строки продолжат поступать по текущему курсору.",
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.labelSmall,
            )
            Button(
                onClick = onDismiss,
                modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp),
            ) {
                Text("Готово")
            }
        }
    }
}

@Composable
private fun XrayLogsSettingSwitch(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onCheckedChange(!checked) },
        shape = RoundedCornerShape(10.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.14f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, color = WebPanelPalette.TextStrong, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                Text(subtitle, color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
            }
            XkeenCompactSwitch(
                checked = checked,
                enabled = true,
                onCheckedChange = onCheckedChange,
            )
        }
    }
}

@Composable
private fun XrayLogsSegment(
    label: String,
    count: Int,
    selected: Boolean,
    available: Boolean?,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(8.dp)
    Row(
        modifier = modifier
            .height(32.dp)
            .background(if (selected) WebPanelPalette.AccentDeep else WebPanelPalette.Panel, shape)
            .border(
                1.dp,
                (if (selected) WebPanelPalette.Border else WebPanelPalette.MutedDeep).copy(alpha = 0.45f),
                shape,
            )
            .clickable(onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (available != null) {
            Box(
                Modifier
                    .size(5.dp)
                    .background(if (available) WebPanelPalette.Success else WebPanelPalette.MutedDeep, CircleShape),
            )
            Spacer(Modifier.width(4.dp))
        }
        Text(
            text = "$label  $count",
            color = if (selected) WebPanelPalette.TextStrong else WebPanelPalette.Muted,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun XrayLogsLevelChip(
    label: String,
    color: Color,
    selected: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(7.dp)
    Box(
        modifier = modifier
            .height(25.dp)
            .background(if (selected) color.copy(alpha = 0.14f) else Color.Transparent, shape)
            .border(1.dp, color.copy(alpha = if (selected) 0.58f else 0.20f), shape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = if (selected) color else WebPanelPalette.Muted,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun XrayLogsRegexButton(selected: Boolean, onClick: () -> Unit) {
    val color = if (selected) WebPanelPalette.Border else WebPanelPalette.Muted
    Box(
        modifier = Modifier
            .height(26.dp)
            .border(1.dp, color.copy(alpha = 0.35f), RoundedCornerShape(7.dp))
            .background(if (selected) WebPanelPalette.AccentDeep else Color.Transparent, RoundedCornerShape(7.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(".*", color = color, fontFamily = FontFamily.Monospace, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun XrayLogsSettingsChoice(
    label: String,
    selected: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier = modifier
            .height(34.dp)
            .background(if (selected) WebPanelPalette.AccentDeep else WebPanelPalette.Panel, shape)
            .border(1.dp, (if (selected) WebPanelPalette.Border else WebPanelPalette.MutedDeep).copy(alpha = 0.40f), shape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = if (selected) WebPanelPalette.TextStrong else WebPanelPalette.Muted, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun XrayLogsIconAction(
    icon: ImageVector,
    description: String,
    enabled: Boolean = true,
    selected: Boolean = false,
    border: Boolean = true,
    size: Int = 28,
    onClick: () -> Unit,
) {
    val tint = when {
        !enabled -> WebPanelPalette.MutedDeep
        selected -> WebPanelPalette.Border
        else -> WebPanelPalette.TextBlue
    }
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier = Modifier
            .size(size.dp)
            .background(if (selected) WebPanelPalette.AccentDeep.copy(alpha = 0.75f) else Color.Transparent, shape)
            .then(if (border) Modifier.border(1.dp, tint.copy(alpha = 0.28f), shape) else Modifier)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, tint = tint, modifier = Modifier.size(15.dp))
    }
}

private fun xrayLogsConnectionColor(logs: LogsState): Color = when {
    logs.isPausedByUser -> WebPanelPalette.Warning
    logs.connection == LogsConnectionState.Connected -> WebPanelPalette.Success
    logs.connection == LogsConnectionState.AuthRequired -> WebPanelPalette.Error
    logs.connection == LogsConnectionState.Reconnecting -> WebPanelPalette.Warning
    logs.connection == LogsConnectionState.Connecting -> WebPanelPalette.Border
    else -> WebPanelPalette.MutedDeep
}

private fun xrayLogsConnectionLabel(logs: LogsState): String = when {
    logs.isPausedByUser -> "пауза · история сохранена"
    logs.connection == LogsConnectionState.Connected -> "онлайн · обновление каждые 2 с"
    logs.connection == LogsConnectionState.Connecting -> "загружаем историю"
    logs.connection == LogsConnectionState.Reconnecting -> "переподключение ${logs.reconnectAttempt.coerceAtLeast(1)}"
    logs.connection == LogsConnectionState.AuthRequired -> "требуется вход"
    else -> "ожидает подключения"
}

private fun xrayLogLevelColor(level: LogLevel): Color = when (level) {
    LogLevel.Info -> WebPanelPalette.Border
    LogLevel.Warning -> WebPanelPalette.Warning
    LogLevel.Error -> WebPanelPalette.Error
}

private fun xrayLogLevelLabel(level: LogLevel): String = when (level) {
    LogLevel.Info -> "INFO"
    LogLevel.Warning -> "WARN"
    LogLevel.Error -> "ERROR"
}

private fun LogEntry.viewerKey(index: Int): String =
    if (id.isNotBlank()) id else "${xrayViewerIdentity()}:$index"
