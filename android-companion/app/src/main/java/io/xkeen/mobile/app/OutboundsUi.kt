package io.xkeen.mobile.app

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.launch

@Composable
internal fun OutboundsWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val outbounds = state.outbounds
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var showFragmentPicker by rememberSaveable { mutableStateOf(false) }
    var showDiscardPrompt by rememberSaveable { mutableStateOf(false) }
    var showSavePrompt by rememberSaveable { mutableStateOf(false) }
    val filteredNodes = remember(outbounds.nodes, query) {
        val needle = query.trim().lowercase()
        if (needle.isBlank()) outbounds.nodes else outbounds.nodes.filter { node ->
            listOf(
                node.displayName,
                node.tag,
                node.protocol,
                node.transport,
                node.security,
                node.host,
            ).any { needle in it.lowercase() }
        }
    }

    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshOutbounds()
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 10.dp,
            end = 10.dp,
            top = 8.dp,
            bottom = 14.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            TitleBlock(
                eyebrow = "Xray · 04 outbounds",
                title = "Прокси",
                subtitle = outbounds.message,
            )
        }

        item {
            OutboundsFragmentSelector(
                state = outbounds,
                onOpen = { if (!outbounds.isBusy) showFragmentPicker = true },
                onRefresh = { scope.launch { controller.refreshOutbounds(force = true) } },
            )
        }

        if (outbounds.hasLoaded) {
            item {
                ProxyPoolSummary(
                    state = outbounds,
                    onPingAll = { scope.launch { controller.pingAllOutbounds() } },
                )
            }


            item {
                OutboundEditorEntryCard(
                    state = outbounds,
                    onOpen = { scope.launch { controller.openOutboundsEditor() } },
                )
            }

            if (outbounds.nodes.size > 3) {
                item {
                    CompactProxySearchField(
                        value = query,
                        onValueChange = { query = it },
                    )
                }
            }
        }

        if (outbounds.isLoading && !outbounds.hasLoaded) {
            item { OutboundsLoadingState() }
        } else if (outbounds.hasLoaded && filteredNodes.isEmpty()) {
            item {
                OutboundsEmptyState(
                    text = if (query.isBlank()) {
                        "В этом фрагменте нет proxy-узлов."
                    } else {
                        "По запросу «$query» ничего не найдено."
                    },
                )
            }
        } else {
            items(filteredNodes.chunked(2), key = { row -> row.joinToString("|") { it.key } }) { row ->
                BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
                    val useGrid = maxWidth >= 320.dp
                    if (useGrid) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            row.forEach { node ->
                                OutboundNodeCard(
                                    node = node,
                                    pinging = node.key in outbounds.pingingNodeKeys,
                                    enabled = !outbounds.isLoading && !outbounds.isPingingAll,
                                    onPing = { scope.launch { controller.pingOutbound(node.key) } },
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            if (row.size == 1) Spacer(Modifier.weight(1f))
                        }
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            row.forEach { node ->
                                OutboundNodeCard(
                                    node = node,
                                    pinging = node.key in outbounds.pingingNodeKeys,
                                    enabled = !outbounds.isLoading && !outbounds.isPingingAll,
                                    onPing = { scope.launch { controller.pingOutbound(node.key) } },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                    }
                }
            }
        }

        outbounds.error?.let { error ->
            item { OutboundsErrorCard(error) }
        }
    }

    if (showFragmentPicker) {
        OutboundsFragmentPickerDialog(
            state = outbounds,
            onDismiss = { showFragmentPicker = false },
            onSelect = { filename ->
                showFragmentPicker = false
                scope.launch { controller.selectOutboundsFragment(filename) }
            },
        )
    }


    if (outbounds.editor.isOpen) {
        OutboundLinkEditorDialog(
            state = outbounds,
            onUrlChange = controller::updateOutboundDraftUrl,
            onTagChange = controller::updateOutboundDraftTag,
            onNormalize = controller::normalizeOutboundDraft,
            onRestartChange = controller::updateOutboundsRestartAfterSave,
            onDismiss = {
                if (outbounds.editor.hasChanges) showDiscardPrompt = true else controller.closeOutboundsEditor()
            },
            onSave = { showSavePrompt = true },
        )
    }

    if (showDiscardPrompt) {
        OutboundEditorConfirmDialog(
            eyebrow = "НЕСОХРАНЁННЫЕ ИЗМЕНЕНИЯ",
            title = "Закрыть редактор?",
            message = "Изменения proxy-ссылки существуют только в памяти приложения и будут потеряны.",
            confirmLabel = "Закрыть без сохранения",
            destructive = true,
            onDismiss = { showDiscardPrompt = false },
            onConfirm = {
                showDiscardPrompt = false
                controller.closeOutboundsEditor()
            },
        )
    }

    if (showSavePrompt) {
        val editor = outbounds.editor
        OutboundEditorConfirmDialog(
            eyebrow = "ЗАПИСЬ OUTBOUNDS",
            title = if (editor.isExistingLink) "Заменить proxy-ссылку?" else "Добавить proxy-ссылку?",
            message = buildString {
                append("Файл ${outbounds.selectedFragment} будет проверен на внешние изменения и сохранён с автоматическим backup на сервере.")
                if (editor.restartAfterSave) append(" После записи Xkeen будет перезапущен.")
            },
            confirmLabel = if (editor.restartAfterSave) "Сохранить и перезапустить" else "Сохранить",
            destructive = false,
            onDismiss = { showSavePrompt = false },
            onConfirm = {
                showSavePrompt = false
                scope.launch { controller.saveOutboundLink() }
            },
        )
    }
}

@Composable
private fun CompactProxySearchField(
    value: String,
    onValueChange: (String) -> Unit,
) {
    val shape = RoundedCornerShape(11.dp)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = WebPanelPalette.TextStrong),
        cursorBrush = SolidColor(WebPanelPalette.Border),
        decorationBox = { innerTextField ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 40.dp)
                    .background(WebPanelPalette.Panel, shape)
                    .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f), shape)
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Icon(
                    Icons.Outlined.Search,
                    contentDescription = null,
                    tint = WebPanelPalette.Muted,
                    modifier = Modifier.size(17.dp),
                )
                Box(modifier = Modifier.weight(1f)) {
                    if (value.isBlank()) {
                        Text(
                            "Найти по стране, тегу или протоколу",
                            color = WebPanelPalette.Muted,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    innerTextField()
                }
            }
        },
    )
}

@Composable
private fun OutboundsFragmentSelector(
    state: OutboundsState,
    onOpen: () -> Unit,
    onRefresh: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.24f)),
    ) {
        Column(modifier = Modifier.padding(horizontal = 9.dp, vertical = 7.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .clickable(onClick = onOpen)
                        .padding(vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Outlined.Hub,
                        contentDescription = null,
                        tint = WebPanelPalette.TextBlue,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = state.selectedFragment.ifBlank { "04_outbounds.json" },
                        modifier = Modifier.weight(1f),
                        color = WebPanelPalette.TextStrong,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Icon(
                        Icons.Outlined.KeyboardArrowDown,
                        contentDescription = "Выбрать файл",
                        tint = WebPanelPalette.Muted,
                        modifier = Modifier.size(19.dp),
                    )
                }
                IconButton(
                    onClick = onRefresh,
                    enabled = !state.isBusy,
                    modifier = Modifier.size(34.dp),
                ) {
                    if (state.isLoading) {
                        CircularProgressIndicator(modifier = Modifier.size(17.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Обновить", modifier = Modifier.size(19.dp))
                    }
                }
            }
            state.activePath.takeIf(String::isNotBlank)?.let { path ->
                Text(
                    text = path,
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ProxyPoolSummary(
    state: OutboundsState,
    onPingAll: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = Color(0xFF071229),
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .background(WebPanelPalette.AccentDeep, RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = state.nodes.size.toString(),
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = if (state.nodes.size == 1) "ОДИН ПРОКСИ" else "ПУЛ ПРОКСИ",
                    color = WebPanelPalette.Border,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.5.sp,
                )
                Text(
                    text = if (state.nodes.size == 1) {
                        "Проверка задержки узла"
                    } else {
                        "Проверка задержки всех узлов"
                    },
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            CompactPoolPingButton(
                onClick = onPingAll,
                enabled = state.nodes.isNotEmpty() && !state.isBusy,
                loading = state.isPingingAll,
            )
        }
    }
}

@Composable
private fun CompactPoolPingButton(
    enabled: Boolean,
    loading: Boolean,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    val container = if (enabled) WebPanelPalette.Border else WebPanelPalette.SurfaceRaised
    Row(
        modifier = Modifier
            .height(34.dp)
            .background(container, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                strokeWidth = 1.5.dp,
                color = WebPanelPalette.Background,
            )
        } else {
            Icon(
                Icons.Outlined.Bolt,
                contentDescription = null,
                modifier = Modifier.size(15.dp),
                tint = if (enabled) WebPanelPalette.Background else WebPanelPalette.Muted,
            )
        }
        Text(
            "Ping",
            color = if (enabled) WebPanelPalette.Background else WebPanelPalette.Muted,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun CompactOutlinedAction(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(9.dp)
    Row(
        modifier = Modifier
            .height(32.dp)
            .border(1.dp, WebPanelPalette.Muted.copy(alpha = if (enabled) 0.72f else 0.28f), shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            color = if (enabled) WebPanelPalette.Border else WebPanelPalette.MutedDeep,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun OutboundEditorEntryCard(
    state: OutboundsState,
    onOpen: () -> Unit,
) {
    val isPool = state.nodes.size > 1
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(
            1.dp,
            if (isPool) WebPanelPalette.Warning.copy(alpha = 0.28f) else WebPanelPalette.Border.copy(alpha = 0.18f),
        ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(34.dp)
                    .background(
                        if (isPool) Color(0xFF3A2A0B) else WebPanelPalette.AccentDeep,
                        RoundedCornerShape(10.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = when {
                        isPool -> Icons.Outlined.Lock
                        state.nodes.isEmpty() -> Icons.Outlined.Add
                        else -> Icons.Outlined.Edit
                    },
                    contentDescription = null,
                    tint = if (isPool) WebPanelPalette.Warning else WebPanelPalette.TextBlue,
                    modifier = Modifier.size(18.dp),
                )
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = when {
                        isPool -> "Single-link режим защищён"
                        state.nodes.isEmpty() -> "Добавить proxy-ссылку"
                        else -> "Редактировать proxy-ссылку"
                    },
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    text = if (isPool) {
                        "Пул не будет перезаписан одиночной ссылкой."
                    } else {
                        "Preview и normalize выполняются локально до отправки на сервер."
                    },
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            CompactOutlinedAction(
                onClick = onOpen,
                enabled = !state.isBusy,
                label = if (isPool) "Почему?" else if (state.nodes.isEmpty()) "Добавить" else "Править",
            )
        }
    }
}

@Composable
private fun OutboundLinkEditorDialog(
    state: OutboundsState,
    onUrlChange: (String) -> Unit,
    onTagChange: (String) -> Unit,
    onNormalize: () -> Unit,
    onRestartChange: (Boolean) -> Unit,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
) {
    val editor = state.editor
    var revealLink by rememberSaveable { mutableStateOf(false) }
    XkeenDialog(onDismissRequest = { if (!editor.isSaving) onDismiss() }) {
        Column(
            modifier = Modifier
                .heightIn(max = 720.dp)
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "XRAY · ${state.selectedFragment}",
                color = WebPanelPalette.Border,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.7.sp,
            )
            Text(
                text = if (editor.isExistingLink) "Редактирование прокси" else "Новый прокси",
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Black,
            )

            if (editor.isLoading) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 34.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("Читаем конфигурацию…", color = WebPanelPalette.Muted)
                }
            } else if (!editor.canEdit) {
                EditorMessageCard(
                    message = editor.error ?: "Этот фрагмент недоступен для single-link редактора.",
                    error = true,
                )
                Text(
                    text = "Подписки и генератор пула будут добавлены отдельным мобильным слоем.",
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    OutlinedButton(onClick = onDismiss) { Text("Закрыть") }
                }
            } else {
                Text(
                    text = "PROXY URL",
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                )
                OutlinedTextField(
                    value = editor.draftUrl,
                    onValueChange = onUrlChange,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !editor.isSaving,
                    minLines = 3,
                    maxLines = 6,
                    shape = RoundedCornerShape(14.dp),
                    visualTransformation = if (revealLink) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    placeholder = { Text("vless://… / trojan://… / vmess://… / ss://… / hy2://…") },
                    trailingIcon = {
                        IconButton(onClick = { revealLink = !revealLink }) {
                            Icon(
                                imageVector = if (revealLink) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                contentDescription = if (revealLink) "Скрыть ссылку" else "Показать ссылку",
                            )
                        }
                    },
                )

                OutlinedTextField(
                    value = editor.draftTag,
                    onValueChange = onTagChange,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !editor.isSaving,
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    label = { Text("Outbound tag") },
                    supportingText = { Text("До 64 символов: A–Z, 0–9, _, ., :, -") },
                )

                OutboundPreviewPanel(editor.preview)

                editor.message?.let { EditorMessageCard(it, error = false) }
                editor.error?.let { EditorMessageCard(it, error = true) }

                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = Color(0xFF071229),
                    border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.16f)),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = !editor.isSaving) { onRestartChange(!editor.restartAfterSave) }
                            .padding(horizontal = 12.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                "Перезапустить Xkeen",
                                color = WebPanelPalette.TextStrong,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                "Применить новую конфигурацию сразу после записи",
                                color = WebPanelPalette.Muted,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                        Switch(
                            checked = editor.restartAfterSave,
                            onCheckedChange = onRestartChange,
                            enabled = !editor.isSaving,
                        )
                    }
                }

                Text(
                    text = "Ссылка и её секреты находятся только в памяти процесса. Preview показывает чувствительные поля в маскированном виде.",
                    color = WebPanelPalette.MutedDeep,
                    style = MaterialTheme.typography.labelSmall,
                )

                HorizontalDivider(color = WebPanelPalette.Border.copy(alpha = 0.14f))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(9.dp, Alignment.End),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedButton(onClick = onDismiss, enabled = !editor.isSaving) {
                        Text("Отмена")
                    }
                    OutlinedButton(
                        onClick = onNormalize,
                        enabled = editor.draftUrl.isNotBlank() && !editor.isSaving,
                    ) {
                        Text("Normalize")
                    }
                    Button(onClick = onSave, enabled = editor.canSave && editor.hasChanges) {
                        if (editor.isSaving) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(if (editor.isSaving) "Сохраняем" else "Сохранить")
                    }
                }
            }
        }
    }
}

@Composable
private fun OutboundPreviewPanel(preview: OutboundLinkPreview) {
    if (!preview.hasContent) {
        Surface(
            shape = RoundedCornerShape(14.dp),
            color = WebPanelPalette.Surface,
            border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.12f)),
        ) {
            Text(
                text = "Вставьте ссылку — здесь появится локальный preview до отправки на сервер.",
                modifier = Modifier.padding(12.dp),
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        return
    }
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = Color(0xFF071229),
        border = BorderStroke(
            1.dp,
            if (preview.isValid) WebPanelPalette.Success.copy(alpha = 0.32f) else WebPanelPalette.Error.copy(alpha = 0.42f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                ProxyBadge(preview.scheme.ifBlank { "?" }, Color(0xFF1D4E89))
                preview.transport.takeIf(String::isNotBlank)?.let { ProxyBadge(it, Color(0xFF155E75)) }
                preview.security.takeIf(String::isNotBlank)?.let { ProxyBadge(it, Color(0xFF713F12)) }
                Spacer(Modifier.weight(1f))
                Text(
                    text = if (preview.isValid) "ГОТОВО" else "ОШИБКА",
                    color = if (preview.isValid) WebPanelPalette.Success else WebPanelPalette.Error,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                )
            }
            preview.fields.forEach { field ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        text = field.label,
                        modifier = Modifier.weight(0.36f),
                        color = WebPanelPalette.Muted,
                        style = MaterialTheme.typography.labelSmall,
                    )
                    Text(
                        text = field.value,
                        modifier = Modifier.weight(0.64f),
                        color = WebPanelPalette.Text,
                        style = MaterialTheme.typography.labelMedium,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            preview.errors.forEach { message ->
                Text("• $message", color = WebPanelPalette.Error, style = MaterialTheme.typography.bodySmall)
            }
            preview.warnings.forEach { message ->
                Text("• $message", color = WebPanelPalette.Warning, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun EditorMessageCard(message: String, error: Boolean) {
    val color = if (error) WebPanelPalette.Error else WebPanelPalette.Border
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = color.copy(alpha = 0.10f),
        border = BorderStroke(1.dp, color.copy(alpha = 0.30f)),
    ) {
        Text(
            text = message,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            color = if (error) WebPanelPalette.Error else WebPanelPalette.TextBlue,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun OutboundEditorConfirmDialog(
    eyebrow: String,
    title: String,
    message: String,
    confirmLabel: String,
    destructive: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                eyebrow,
                color = if (destructive) WebPanelPalette.Error else WebPanelPalette.Border,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
            Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
            Text(message, color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodyMedium)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(9.dp, Alignment.End),
            ) {
                OutlinedButton(onClick = onDismiss) { Text("Отмена") }
                Button(onClick = onConfirm) { Text(confirmLabel) }
            }
        }
    }
}

@Composable
private fun OutboundNodeCard(
    node: OutboundNode,
    pinging: Boolean,
    enabled: Boolean,
    onPing: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(12.dp)
    val border = WebPanelPalette.Border.copy(alpha = 0.20f)
    val latency = node.latency
    Surface(
        modifier = modifier.height(110.dp),
        shape = shape,
        color = Color(0xFF090F1D),
        border = BorderStroke(1.dp, border),
    ) {
        Column(
            modifier = Modifier.padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(
                modifier = Modifier.height(32.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Text(
                    text = outboundCountryFlag(node),
                    modifier = Modifier.padding(top = 1.dp),
                    fontSize = 15.sp,
                )
                Spacer(Modifier.width(5.dp))
                Text(
                    text = node.displayName,
                    modifier = Modifier.weight(1f),
                    color = WebPanelPalette.TextStrong,
                    fontSize = 13.sp,
                    lineHeight = 16.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                ProxyBadge(node.protocol.ifBlank { "proxy" }, Color(0xFF1D4E89))
                node.transport.takeIf(String::isNotBlank)?.let { ProxyBadge(it, Color(0xFF155E75)) }
                node.security.takeIf(String::isNotBlank)?.let { ProxyBadge(it, Color(0xFF713F12)) }
            }

            Text(
                text = node.endpoint.ifBlank { node.tag },
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )

            Spacer(Modifier.weight(1f))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = when {
                            pinging -> "Проверяем…"
                            latency?.delayMillis != null -> "${latency.delayMillis} мс"
                            latency?.status == "error" -> "Нет ответа"
                            else -> "Не проверен"
                        },
                        color = when {
                            pinging -> WebPanelPalette.Warning
                            latency?.delayMillis != null -> latencyColor(latency.delayMillis)
                            latency?.status == "error" -> WebPanelPalette.Error
                            else -> WebPanelPalette.Muted
                        },
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .border(1.dp, border.copy(alpha = 0.62f), CircleShape)
                        .clickable(enabled = enabled && !pinging, onClick = onPing),
                    contentAlignment = Alignment.Center,
                ) {
                    if (pinging) {
                        CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp)
                    } else {
                        Icon(
                            Icons.Outlined.Bolt,
                            contentDescription = "Проверить задержку ${node.displayName}",
                            tint = WebPanelPalette.TextBlue,
                            modifier = Modifier.size(15.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ProxyBadge(text: String, color: Color) {
    Text(
        text = text.lowercase(),
        modifier = Modifier
            .background(color.copy(alpha = 0.72f), RoundedCornerShape(999.dp))
            .padding(horizontal = 5.dp, vertical = 2.dp),
        color = WebPanelPalette.TextBlue,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
    )
}

@Composable
private fun OutboundsLoadingState() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 36.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(10.dp))
        Text("Загружаем proxy-фрагмент…", color = WebPanelPalette.Muted)
    }
}

@Composable
private fun OutboundsEmptyState(text: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.16f)),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                Icons.Outlined.Hub,
                contentDescription = null,
                tint = WebPanelPalette.Muted,
                modifier = Modifier.size(20.dp),
            )
            Text(text, color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun OutboundsErrorCard(error: String) {
    Surface(
        color = WebPanelPalette.Error.copy(alpha = 0.10f),
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, WebPanelPalette.Error.copy(alpha = 0.42f)),
    ) {
        Text(
            text = error,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            color = WebPanelPalette.Error,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun OutboundsFragmentPickerDialog(
    state: OutboundsState,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(11.dp),
        ) {
            Text(
                "OUTBOUNDS XRAY",
                color = WebPanelPalette.Border,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
            Text("Выберите proxy-фрагмент", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 360.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                state.fragments.forEach { fragment ->
                    val selected = fragment.name == state.selectedFragment
                    val shape = RoundedCornerShape(12.dp)
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(if (selected) WebPanelPalette.Accent else WebPanelPalette.Surface, shape)
                            .border(1.dp, WebPanelPalette.Border.copy(alpha = if (selected) 0.62f else 0.18f), shape)
                            .clickable { onSelect(fragment.name) }
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            fragment.name,
                            modifier = Modifier.weight(1f),
                            color = WebPanelPalette.TextStrong,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (selected) {
                            Text("ОТКРЫТ", color = Color(0xFFDBEAFE), style = MaterialTheme.typography.labelSmall)
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

private fun latencyColor(delayMillis: Long): Color = when {
    delayMillis < 120 -> WebPanelPalette.Success
    delayMillis < 300 -> WebPanelPalette.Warning
    else -> WebPanelPalette.Error
}

private fun outboundCountryFlag(node: OutboundNode): String {
    val text = "${node.displayName} ${node.tag} ${node.host}".lowercase()
    return countryFlags.entries.firstOrNull { (aliases, _) -> aliases.any(text::contains) }?.value ?: "🌐"
}

private val countryFlags = mapOf(
    listOf("netherlands", "amsterdam", "нидерланд") to "🇳🇱",
    listOf("germany", "frankfurt", "герман") to "🇩🇪",
    listOf("sweden", "stockholm", "швец") to "🇸🇪",
    listOf("united states", "new york", "usa", "сша") to "🇺🇸",
    listOf("india", "mumbai", "индия") to "🇮🇳",
    listOf("spain", "madrid", "испан") to "🇪🇸",
    listOf("turkey", "istanbul", "турц") to "🇹🇷",
    listOf("israel", "tel aviv", "израил") to "🇮🇱",
    listOf("kazakhstan", "almaty", "казах") to "🇰🇿",
    listOf("bulgaria", "sofia", "болгар") to "🇧🇬",
    listOf("france", "paris", "франц") to "🇫🇷",
    listOf("united kingdom", "london", "britain", "англи") to "🇬🇧",
    listOf("singapore", "сингапур") to "🇸🇬",
    listOf("japan", "tokyo", "япон") to "🇯🇵",
)
