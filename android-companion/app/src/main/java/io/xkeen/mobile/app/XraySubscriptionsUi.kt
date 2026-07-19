package io.xkeen.mobile.app

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Subscriptions
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.xkeen.mobile.ui.theme.WebPanelPalette
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.launch

@Composable
internal fun XraySubscriptionsWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val subscriptions = state.xraySubscriptions
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var showHelp by rememberSaveable { mutableStateOf(false) }
    var showAdvancedHelp by rememberSaveable { mutableStateOf(false) }
    var diagnosticsId by rememberSaveable { mutableStateOf<String?>(null) }
    var deleteId by rememberSaveable { mutableStateOf<String?>(null) }
    var showDiscardPrompt by rememberSaveable { mutableStateOf(false) }
    var showSavePrompt by rememberSaveable { mutableStateOf(false) }
    val filtered = remember(subscriptions.items, query) {
        val needle = query.trim().lowercase()
        if (needle.isBlank()) subscriptions.items else subscriptions.items.filter { item ->
            listOf(item.name, item.tag, item.id, item.outputFile).any { needle in it.lowercase() }
        }
    }

    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshXraySubscriptions()
    }

    LazyColumn(
        modifier = modifier.fillMaxSize().background(WebPanelPalette.Background),
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
                eyebrow = "Xray · managed outbounds",
                title = "Подписки",
                subtitle = subscriptions.message,
            )
        }
        item {
            XraySubscriptionsToolbar(
                state = subscriptions,
                onHelp = { showHelp = true },
                onRefreshDue = { scope.launch { controller.refreshDueXraySubscriptions() } },
                onAdd = controller::openNewXraySubscription,
            )
        }
        if (subscriptions.items.size > 4) {
            item {
                SubscriptionSearchField(value = query, onValueChange = { query = it })
            }
        }
        if (subscriptions.isLoading && !subscriptions.hasLoaded) {
            item { SubscriptionLoadingCard() }
        } else if (subscriptions.hasLoaded && filtered.isEmpty()) {
            item {
                SubscriptionEmptyCard(
                    if (query.isBlank()) "Подписок пока нет. Добавьте HTTP(S) источник." else "По запросу ничего не найдено.",
                )
            }
        } else {
            items(filtered, key = XraySubscriptionRecord::id) { item ->
                XraySubscriptionCard(
                    item = item,
                    refreshing = item.id in subscriptions.refreshingIds,
                    deleting = item.id in subscriptions.deletingIds,
                    enabled = !subscriptions.isBusy,
                    onEdit = { controller.openXraySubscription(item.id) },
                    onRefresh = { scope.launch { controller.refreshXraySubscription(item.id) } },
                    onDiagnostics = { diagnosticsId = item.id },
                    onDelete = { deleteId = item.id },
                )
            }
        }
        subscriptions.error?.let { message ->
            item { SubscriptionMessageCard(message, error = true) }
        }
    }

    if (subscriptions.editor.isOpen) {
        XraySubscriptionEditorDialog(
            state = subscriptions,
            controller = controller,
            onAdvancedHelp = { showAdvancedHelp = true },
            onDismiss = {
                if (subscriptions.editor.hasChanges) showDiscardPrompt = true else controller.closeXraySubscriptionEditor()
            },
            onSave = { showSavePrompt = true },
        )
    }

    if (showHelp) {
        XraySubscriptionsHelpDialog(onDismiss = { showHelp = false })
    }
    if (showAdvancedHelp) {
        XraySubscriptionsAdvancedHelpDialog(onDismiss = { showAdvancedHelp = false })
    }
    diagnosticsId?.let { id ->
        subscriptions.items.firstOrNull { it.id == id }?.let { item ->
            XraySubscriptionDiagnosticsDialog(item = item, onDismiss = { diagnosticsId = null })
        } ?: run { diagnosticsId = null }
    }
    deleteId?.let { id ->
        val item = subscriptions.items.firstOrNull { it.id == id }
        if (item != null) {
            SubscriptionConfirmDialog(
                title = "Удалить подписку?",
                message = "${item.name}: запись и ${item.outputFile.ifBlank { "generated-фрагмент" }} будут удалены. Routing и observatory пересоберутся из оставшихся подписок.",
                confirmLabel = "Удалить",
                destructive = true,
                onDismiss = { deleteId = null },
                onConfirm = {
                    deleteId = null
                    scope.launch { controller.deleteXraySubscription(id) }
                },
            )
        } else {
            deleteId = null
        }
    }
    if (showDiscardPrompt) {
        SubscriptionConfirmDialog(
            title = "Закрыть редактор?",
            message = "Несохранённые настройки подписки и preview будут потеряны.",
            confirmLabel = "Закрыть",
            destructive = true,
            onDismiss = { showDiscardPrompt = false },
            onConfirm = {
                showDiscardPrompt = false
                controller.closeXraySubscriptionEditor()
            },
        )
    }
    if (showSavePrompt) {
        val editor = subscriptions.editor
        SubscriptionConfirmDialog(
            title = if (editor.draft.id.isBlank()) "Добавить подписку?" else "Сохранить подписку?",
            message = buildString {
                append("Настройки будут записаны на сервере.")
                if (editor.refreshAfterSave) append(" Затем источник будет скачан и generated-фрагмент обновлён.")
                if (editor.refreshAfterSave && editor.restartAfterMutation) append(" Xkeen перезапустится только при реальных изменениях.")
            },
            confirmLabel = "Сохранить",
            destructive = false,
            onDismiss = { showSavePrompt = false },
            onConfirm = {
                showSavePrompt = false
                scope.launch { controller.saveXraySubscription() }
            },
        )
    }
}

@Composable
private fun XraySubscriptionsToolbar(
    state: XraySubscriptionsState,
    onHelp: () -> Unit,
    onRefreshDue: () -> Unit,
    onAdd: () -> Unit,
) {
    val now = System.currentTimeMillis() / 1000
    val due = state.items.count { it.enabled && (it.nextUpdateEpochSeconds ?: Long.MAX_VALUE) <= now }
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.18f)),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Box(
                modifier = Modifier.size(34.dp).background(WebPanelPalette.AccentDeep, RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    state.items.size.toString(),
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("ИСТОЧНИКИ", color = WebPanelPalette.Border, style = MaterialTheme.typography.labelSmall)
                Text(
                    if (due > 0) "Просрочено: $due" else "Расписание в норме",
                    color = if (due > 0) WebPanelPalette.Warning else WebPanelPalette.Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            SubscriptionIconAction(Icons.Outlined.HelpOutline, "Справка", true, onHelp)
            SubscriptionTextAction(
                label = if (state.isRefreshingDue) "…" else "Due",
                enabled = !state.isBusy,
                onClick = onRefreshDue,
            )
            SubscriptionIconAction(Icons.Outlined.Add, "Добавить подписку", !state.isBusy, onAdd, primary = true)
        }
    }
}

@Composable
private fun XraySubscriptionCard(
    item: XraySubscriptionRecord,
    refreshing: Boolean,
    deleting: Boolean,
    enabled: Boolean,
    onEdit: () -> Unit,
    onRefresh: () -> Unit,
    onDiagnostics: () -> Unit,
    onDelete: () -> Unit,
) {
    val now = System.currentTimeMillis() / 1000
    val due = item.enabled && (item.nextUpdateEpochSeconds ?: Long.MAX_VALUE) <= now
    val statusColor = when (item.lastOk) {
        true -> WebPanelPalette.Success
        false -> WebPanelPalette.Error
        null -> WebPanelPalette.Muted
    }
    val status = when {
        refreshing -> "ОБНОВЛЯЕМ"
        deleting -> "УДАЛЯЕМ"
        item.lastOk == true -> "OK · ${item.lastCount}"
        item.lastOk == false -> "ОШИБКА"
        else -> "ОЖИДАЕТ"
    }
    Surface(
        modifier = Modifier.fillMaxWidth().height(96.dp).clickable(enabled = enabled, onClick = onEdit),
        shape = RoundedCornerShape(12.dp),
        color = Color(0xFF090F1D),
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.20f)),
    ) {
        Column(
            modifier = Modifier.padding(9.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Outlined.Subscriptions, null, tint = WebPanelPalette.TextBlue, modifier = Modifier.size(16.dp))
                Text(
                    item.name.ifBlank { item.tag.ifBlank { item.id } },
                    modifier = Modifier.weight(1f),
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(status, color = statusColor, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(item.tag, color = WebPanelPalette.TextBlue, style = MaterialTheme.typography.labelMedium)
                Text("${item.intervalHours} ч", color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
                if (!item.enabled) Text("авто выкл.", color = WebPanelPalette.MutedDeep, style = MaterialTheme.typography.labelSmall)
                if (due) Text("due", color = WebPanelPalette.Warning, style = MaterialTheme.typography.labelSmall)
            }
            Spacer(Modifier.weight(1f))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    subscriptionScheduleText(item, now),
                    modifier = Modifier.weight(1f),
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                SubscriptionIconAction(Icons.Outlined.Refresh, "Обновить", enabled, onRefresh, loading = refreshing)
                SubscriptionIconAction(Icons.Outlined.Info, "Диагностика", true, onDiagnostics)
                SubscriptionIconAction(Icons.Outlined.Edit, "Редактировать", enabled, onEdit)
                SubscriptionIconAction(Icons.Outlined.Delete, "Удалить", enabled, onDelete, danger = true)
            }
        }
    }
}

@Composable
private fun XraySubscriptionEditorDialog(
    state: XraySubscriptionsState,
    controller: CompanionController,
    onAdvancedHelp: () -> Unit,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
) {
    val editor = state.editor
    val draft = editor.draft
    val preview = editor.preview
    val scope = rememberCoroutineScope()
    var revealUrl by rememberSaveable { mutableStateOf(false) }
    XkeenDialog(onDismissRequest = { if (!editor.isSaving && !editor.isPreviewing) onDismiss() }) {
        Column(
            modifier = Modifier.heightIn(max = 720.dp).verticalScroll(rememberScrollState()).imePadding().padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Text(
                "XRAY · SUBSCRIPTIONS",
                color = WebPanelPalette.Border,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                if (draft.id.isBlank()) "Новая подписка" else "Редактирование подписки",
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            SubscriptionCompactField(
                label = "URL",
                value = draft.url,
                onValueChange = { value -> controller.updateXraySubscriptionDraft { it.copy(url = value) } },
                enabled = !editor.isPreviewing && !editor.isSaving,
                secure = !revealUrl,
                minHeight = 54,
                trailing = {
                    SubscriptionIconAction(
                        if (revealUrl) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                        if (revealUrl) "Скрыть URL" else "Показать URL",
                        true,
                        { revealUrl = !revealUrl },
                    )
                },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SubscriptionCompactField(
                    label = "Название",
                    value = draft.name,
                    onValueChange = { value -> controller.updateXraySubscriptionDraft { it.copy(name = value) } },
                    enabled = !editor.isPreviewing && !editor.isSaving,
                    modifier = Modifier.weight(1f),
                )
                SubscriptionCompactField(
                    label = "Tag prefix",
                    value = draft.tag,
                    onValueChange = { value -> controller.updateXraySubscriptionDraft { it.copy(tag = value) } },
                    enabled = !editor.isPreviewing && !editor.isSaving,
                    modifier = Modifier.weight(1f),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                SubscriptionPrimaryAction(
                    label = if (editor.isPreviewing) "Проверяем…" else "Preview",
                    enabled = draft.validationError == null && !editor.isPreviewing && !editor.isSaving,
                    onClick = { scope.launch { controller.previewXraySubscription() } },
                )
                draft.validationError?.let {
                    Text(it, modifier = Modifier.weight(1f), color = WebPanelPalette.Error, style = MaterialTheme.typography.labelSmall)
                } ?: Text(
                    if (editor.previewIsCurrent) "Preview актуален" else "Без изменений на сервере",
                    modifier = Modifier.weight(1f),
                    color = if (editor.previewIsCurrent) WebPanelPalette.Success else WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
            }

            preview?.let {
                SubscriptionPreviewSummary(preview = it, current = editor.previewIsCurrent)
                it.nodes.withIndex().chunked(2).take(3).forEach { row ->
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        row.forEach { indexed ->
                            val excluded = indexed.value.key in draft.excludedNodeKeys
                            SubscriptionPreviewNodeCard(
                                node = indexed.value,
                                excluded = excluded,
                                enabled = !editor.isPreviewing && !editor.isSaving,
                                onToggle = { controller.toggleXraySubscriptionNode(indexed.value.key) },
                                modifier = Modifier.weight(1f),
                            )
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
                if (it.nodes.size > 6) {
                    Text("Ещё узлов: ${it.nodes.size - 6}. Полный список доступен после сохранения во фрагменте Outbounds.", color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                SubscriptionCompactField(
                    label = "Интервал, ч",
                    value = draft.intervalHours,
                    onValueChange = { value -> controller.updateXraySubscriptionDraft { it.copy(intervalHours = value.filter(Char::isDigit).take(3)) } },
                    enabled = !editor.isPreviewing && !editor.isSaving,
                    keyboardType = KeyboardType.Number,
                    modifier = Modifier.width(94.dp),
                )
                preview?.profileUpdateIntervalHours?.let { hours ->
                    SubscriptionTextAction(
                        label = "Провайдер: $hours ч",
                        enabled = !editor.isSaving,
                        onClick = { controller.updateXraySubscriptionDraft { it.copy(intervalHours = hours.toString()) } },
                        modifier = Modifier.align(Alignment.Bottom),
                        height = 38.dp,
                    )
                }
                Spacer(Modifier.weight(1f))
                SubscriptionTinyToggle(
                    title = "Авто",
                    checked = draft.enabled,
                    enabled = !editor.isSaving,
                    onCheckedChange = { value -> controller.updateXraySubscriptionDraft { it.copy(enabled = value) } },
                )
            }

            Surface(
                shape = RoundedCornerShape(10.dp),
                color = Color(0xFF071229),
                border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.16f)),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().clickable(onClick = controller::toggleXraySubscriptionAdvanced).padding(horizontal = 9.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Дополнительно", modifier = Modifier.weight(1f), color = WebPanelPalette.TextStrong, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                    SubscriptionIconAction(Icons.Outlined.HelpOutline, "Справка", true, onAdvancedHelp)
                    Icon(if (editor.advancedExpanded) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown, null, tint = WebPanelPalette.Muted, modifier = Modifier.size(17.dp))
                }
            }

            if (editor.advancedExpanded) {
                SubscriptionCompactField("Фильтр имени · regex", draft.nameFilter, { value -> controller.updateXraySubscriptionDraft { it.copy(nameFilter = value) } }, !editor.isSaving)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SubscriptionCompactField("Тип · regex", draft.typeFilter, { value -> controller.updateXraySubscriptionDraft { it.copy(typeFilter = value) } }, !editor.isSaving, modifier = Modifier.weight(1f))
                    SubscriptionCompactField("Транспорт · regex", draft.transportFilter, { value -> controller.updateXraySubscriptionDraft { it.copy(transportFilter = value) } }, !editor.isSaving, modifier = Modifier.weight(1f))
                }
                SubscriptionOptionRow(
                    title = "Пинг observatory",
                    subtitle = "Добавить prefix в subjectSelector",
                    checked = draft.pingEnabled,
                    enabled = !editor.isSaving,
                    onCheckedChange = { value -> controller.updateXraySubscriptionDraft { it.copy(pingEnabled = value) } },
                )
                SubscriptionOptionRow(
                    title = "Служебный пул",
                    subtitle = "Синхронизировать leastPing routing",
                    checked = draft.routingAutoRule,
                    enabled = !editor.isSaving,
                    onCheckedChange = { value -> controller.updateXraySubscriptionDraft { it.copy(routingAutoRule = value) } },
                )
                if (draft.routingAutoRule) {
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        XraySubscriptionRoutingMode.entries.forEach { mode ->
                            SubscriptionChoiceChip(
                                label = when (mode) {
                                    XraySubscriptionRoutingMode.SubscriptionOnly -> "Только"
                                    else -> mode.displayName
                                },
                                selected = draft.routingMode == mode,
                                onClick = { controller.updateXraySubscriptionDraft { it.copy(routingMode = mode) } },
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }

            editor.message?.let { SubscriptionMessageCard(it, error = false) }
            editor.error?.let { SubscriptionMessageCard(it, error = true) }
            SubscriptionOptionRow(
                title = "Обновить сразу",
                subtitle = "После сохранения скачать источник",
                checked = editor.refreshAfterSave,
                enabled = !editor.isSaving,
                onCheckedChange = controller::updateXraySubscriptionRefreshAfterSave,
            )
            if (editor.refreshAfterSave) {
                SubscriptionOptionRow(
                    title = "Перезапустить Xkeen",
                    subtitle = "Только если конфигурация изменилась",
                    checked = editor.restartAfterMutation,
                    enabled = !editor.isSaving,
                    onCheckedChange = controller::updateXraySubscriptionRestart,
                )
            }
            Text(
                "URL хранится на сервере Xkeen UI и не сохраняется локально в приложении. Подробные routing/balancer настройки остаются доступны в веб-панели.",
                color = WebPanelPalette.MutedDeep,
                style = MaterialTheme.typography.labelSmall,
            )
            HorizontalDivider(color = WebPanelPalette.Border.copy(alpha = 0.14f))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.End)) {
                SubscriptionTextAction("Отмена", !editor.isSaving, onDismiss)
                SubscriptionPrimaryAction(if (editor.isSaving) "Сохраняем…" else "Сохранить", editor.canSave, onSave)
            }
        }
    }
}

@Composable
private fun SubscriptionPreviewSummary(preview: XraySubscriptionPreview, current: Boolean) {
    val color = if (current && preview.errors.isEmpty()) WebPanelPalette.Success else WebPanelPalette.Warning
    Surface(shape = RoundedCornerShape(10.dp), color = Color(0xFF071229), border = BorderStroke(1.dp, color.copy(alpha = 0.28f))) {
        Row(modifier = Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text("${preview.count} из ${preview.sourceCount.coerceAtLeast(preview.count)} узлов", color = WebPanelPalette.TextStrong, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                Text(listOf(preview.sourceFormat, preview.fetchMode).filter(String::isNotBlank).joinToString(" · "), color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
            }
            if (preview.filteredOutCount > 0) Text("скрыто ${preview.filteredOutCount}", color = WebPanelPalette.Warning, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun SubscriptionPreviewNodeCard(
    node: OutboundNode,
    excluded: Boolean,
    enabled: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.height(84.dp),
        shape = RoundedCornerShape(10.dp),
        color = if (excluded) WebPanelPalette.Surface.copy(alpha = 0.65f) else Color(0xFF071229),
        border = BorderStroke(1.dp, (if (excluded) WebPanelPalette.Warning else WebPanelPalette.Border).copy(alpha = 0.22f)),
    ) {
        Column(modifier = Modifier.padding(7.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(node.protocol.ifBlank { "proxy" }, color = WebPanelPalette.TextBlue, style = MaterialTheme.typography.labelSmall)
                Spacer(Modifier.weight(1f))
                Box(modifier = Modifier.size(22.dp).clickable(enabled = enabled, onClick = onToggle), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Close, if (excluded) "Вернуть узел" else "Исключить узел", tint = if (excluded) WebPanelPalette.Warning else WebPanelPalette.Muted, modifier = Modifier.size(14.dp))
                }
            }
            Text(node.displayName, color = if (excluded) WebPanelPalette.Muted else WebPanelPalette.TextStrong, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.weight(1f))
            Text(node.endpoint, color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun SubscriptionCompactField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    secure: Boolean = false,
    minHeight: Int = 38,
    keyboardType: KeyboardType = KeyboardType.Text,
    trailing: (@Composable () -> Unit)? = null,
) {
    val shape = RoundedCornerShape(9.dp)
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = enabled,
            singleLine = minHeight < 50,
            textStyle = MaterialTheme.typography.bodySmall.copy(color = if (enabled) WebPanelPalette.TextStrong else WebPanelPalette.Muted),
            cursorBrush = SolidColor(WebPanelPalette.Border),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            visualTransformation = if (secure) PasswordVisualTransformation() else VisualTransformation.None,
            decorationBox = { inner ->
                Row(
                    modifier = Modifier.fillMaxWidth().heightIn(min = minHeight.dp).background(WebPanelPalette.Surface, shape).border(1.dp, WebPanelPalette.Border.copy(alpha = 0.18f), shape).padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(modifier = Modifier.weight(1f)) { inner() }
                    trailing?.invoke()
                }
            },
        )
    }
}

@Composable
private fun SubscriptionOptionRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Surface(shape = RoundedCornerShape(10.dp), color = Color(0xFF071229), border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.14f))) {
        Row(modifier = Modifier.fillMaxWidth().clickable(enabled = enabled) { onCheckedChange(!checked) }.padding(horizontal = 9.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(title, color = WebPanelPalette.TextStrong, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                Text(subtitle, color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
            }
            SubscriptionToggle(checked = checked, enabled = enabled, onCheckedChange = onCheckedChange)
        }
    }
}

@Composable
private fun SubscriptionTinyToggle(
    title: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(modifier = Modifier.clickable(enabled = enabled) { onCheckedChange(!checked) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(title, color = WebPanelPalette.TextStrong, style = MaterialTheme.typography.labelLarge)
        SubscriptionToggle(checked, enabled, onCheckedChange)
    }
}

@Composable
private fun SubscriptionToggle(
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    XkeenCompactSwitch(
        checked = checked,
        enabled = enabled,
        onCheckedChange = onCheckedChange,
    )
}

@Composable
private fun SubscriptionChoiceChip(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val color = if (selected) WebPanelPalette.Border else WebPanelPalette.Muted
    Box(modifier = modifier.height(30.dp).background(if (selected) WebPanelPalette.AccentDeep else Color.Transparent, RoundedCornerShape(8.dp)).border(1.dp, color.copy(alpha = 0.45f), RoundedCornerShape(8.dp)).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(label, color = if (selected) WebPanelPalette.TextStrong else WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun SubscriptionSearchField(value: String, onValueChange: (String) -> Unit) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        textStyle = MaterialTheme.typography.bodySmall.copy(color = WebPanelPalette.TextStrong),
        cursorBrush = SolidColor(WebPanelPalette.Border),
        decorationBox = { inner ->
            Row(modifier = Modifier.fillMaxWidth().height(38.dp).background(WebPanelPalette.Panel, RoundedCornerShape(10.dp)).border(1.dp, WebPanelPalette.Border.copy(alpha = 0.18f), RoundedCornerShape(10.dp)).padding(horizontal = 9.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Outlined.Search, null, tint = WebPanelPalette.Muted, modifier = Modifier.size(16.dp))
                Box(modifier = Modifier.weight(1f)) {
                    if (value.isBlank()) Text("Найти по имени или tag", color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall)
                    inner()
                }
            }
        },
    )
}

@Composable
private fun SubscriptionIconAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    enabled: Boolean,
    onClick: () -> Unit,
    primary: Boolean = false,
    danger: Boolean = false,
    loading: Boolean = false,
) {
    val tint = when {
        !enabled -> WebPanelPalette.MutedDeep
        danger -> WebPanelPalette.Error
        primary -> WebPanelPalette.Background
        else -> WebPanelPalette.TextBlue
    }
    Box(
        modifier = Modifier.size(28.dp).background(if (primary) WebPanelPalette.Border else Color.Transparent, RoundedCornerShape(8.dp)).border(1.dp, if (primary) Color.Transparent else tint.copy(alpha = 0.35f), RoundedCornerShape(8.dp)).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) CircularProgressIndicator(modifier = Modifier.size(13.dp), strokeWidth = 1.5.dp, color = tint)
        else Icon(icon, description, tint = tint, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun SubscriptionTextAction(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    height: Dp = 30.dp,
) {
    Box(modifier = modifier.height(height).border(1.dp, WebPanelPalette.Muted.copy(alpha = if (enabled) 0.55f else 0.22f), RoundedCornerShape(8.dp)).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 9.dp), contentAlignment = Alignment.Center) {
        Text(label, color = if (enabled) WebPanelPalette.TextBlue else WebPanelPalette.MutedDeep, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun SubscriptionPrimaryAction(label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(modifier = Modifier.height(30.dp).background(if (enabled) WebPanelPalette.Border else WebPanelPalette.SurfaceRaised, RoundedCornerShape(8.dp)).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
        Text(label, color = if (enabled) WebPanelPalette.Background else WebPanelPalette.MutedDeep, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun SubscriptionMessageCard(message: String, error: Boolean) {
    val color = if (error) WebPanelPalette.Error else WebPanelPalette.Border
    Surface(shape = RoundedCornerShape(10.dp), color = color.copy(alpha = 0.08f), border = BorderStroke(1.dp, color.copy(alpha = 0.24f))) {
        Text(message, modifier = Modifier.padding(horizontal = 9.dp, vertical = 7.dp), color = if (error) WebPanelPalette.Error else WebPanelPalette.TextBlue, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun SubscriptionLoadingCard() {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(8.dp))
        Text("Загружаем подписки…", color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun SubscriptionEmptyCard(message: String) {
    Surface(shape = RoundedCornerShape(12.dp), color = WebPanelPalette.Panel, border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.16f))) {
        Text(message, modifier = Modifier.fillMaxWidth().padding(18.dp), color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun XraySubscriptionsHelpDialog(onDismiss: () -> Unit) {
    SubscriptionInfoDialog(
        title = "Как работают подписки",
        lines = listOf(
            "Preview скачивает и проверяет источник, но ничего не сохраняет и не перезапускает.",
            "Сохранение записывает настройки. Generated-фрагмент создаётся только при «Обновить сразу», вручную или по расписанию.",
            "Tag prefix используется для generated tags и observatory. Подробное управление routing и balancers доступно в веб-панели.",
        ),
        onDismiss = onDismiss,
    )
}

@Composable
private fun XraySubscriptionsAdvancedHelpDialog(onDismiss: () -> Unit) {
    SubscriptionInfoDialog(
        title = "Дополнительные настройки",
        lines = listOf(
            "Фильтры — регистронезависимые regex по имени, протоколу и транспорту.",
            "Безопасно сохраняет явные proxy-правила; Жёстко переносит совместимые auto-правила в pool; Только подписка использует generated nodes.",
            "Редкие настройки user balancers и Entware mark сохраняются при редактировании, но меняются в веб-панели.",
        ),
        onDismiss = onDismiss,
    )
}

@Composable
private fun XraySubscriptionDiagnosticsDialog(item: XraySubscriptionRecord, onDismiss: () -> Unit) {
    val lines = buildList {
        item.lastError?.let { add("Ошибка: $it") }
        item.warnings.forEach { add("Предупреждение: $it") }
        item.errors.forEach { add("Узел: $it") }
        if (isEmpty()) add("Последнее обновление прошло без ошибок и предупреждений.")
        add("Формат: ${item.sourceFormat ?: "—"} · загрузка: ${item.fetchMode ?: "—"}")
        add("Узлы: ${item.lastCount} из ${item.sourceCount.coerceAtLeast(item.lastCount)} · скрыто ${item.filteredOutCount}")
    }
    SubscriptionInfoDialog(title = item.name.ifBlank { item.tag }, lines = lines, onDismiss = onDismiss)
}

@Composable
private fun SubscriptionInfoDialog(title: String, lines: List<String>, onDismiss: () -> Unit) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, color = WebPanelPalette.TextStrong, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            lines.forEach { Text("• $it", color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall) }
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                SubscriptionTextAction("Закрыть", true, onDismiss)
            }
        }
    }
}

@Composable
private fun SubscriptionConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    destructive: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text(title, color = if (destructive) WebPanelPalette.Error else WebPanelPalette.TextStrong, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(message, color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall)
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.End)) {
                SubscriptionTextAction("Отмена", true, onDismiss)
                if (destructive) {
                    Box(modifier = Modifier.height(30.dp).background(WebPanelPalette.Error, RoundedCornerShape(8.dp)).clickable(onClick = onConfirm).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                        Text(confirmLabel, color = Color.White, style = MaterialTheme.typography.labelLarge)
                    }
                } else SubscriptionPrimaryAction(confirmLabel, true, onConfirm)
            }
        }
    }
}

private fun subscriptionScheduleText(item: XraySubscriptionRecord, now: Long): String = when {
    !item.enabled -> "Автообновление выключено"
    item.nextUpdateEpochSeconds == null -> "Следующее обновление не запланировано"
    item.nextUpdateEpochSeconds <= now -> "Пора обновить"
    else -> "Следующее: ${subscriptionTimeFormatter.format(Instant.ofEpochSecond(item.nextUpdateEpochSeconds))}"
}

private val subscriptionTimeFormatter: DateTimeFormatter = DateTimeFormatter
    .ofPattern("dd.MM · HH:mm")
    .withZone(ZoneId.systemDefault())
