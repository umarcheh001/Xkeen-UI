package io.xkeen.mobile.app

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.NavigateBefore
import androidx.compose.material.icons.automirrored.outlined.NavigateNext
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.xkeen.mobile.ui.theme.WebPanelPalette
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@Composable
internal fun XrayDatWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val dat = state.xrayDat
    val scope = rememberCoroutineScope()
    var showFilePicker by remember { mutableStateOf(false) }

    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshXrayDatCatalog()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        XrayDatHeader(
            isLoading = dat.isLoadingCatalog || dat.isLoadingTags,
            onRefresh = { scope.launch { controller.refreshXrayDatCatalog(force = true) } },
        )
        XrayDatKindSelector(
            selected = dat.selectedKind,
            enabled = !dat.isLoadingCatalog && !dat.isLoadingTags && !dat.isLoadingItems,
            onSelect = { kind -> scope.launch { controller.selectXrayDatKind(kind) } },
        )
        XrayDatFileSelector(
            file = dat.selectedFile,
            enabled = dat.files.any { it.kind == dat.selectedKind } && !dat.isLoadingTags && !dat.isLoadingItems,
            onClick = { showFilePicker = true },
        )

        val blockingMessage = dat.catalogError ?: dat.geodatMessage.takeIf { dat.geodatInstalled == false }
        if (blockingMessage != null) {
            XrayDatNotice(blockingMessage, error = dat.catalogError != null)
        }

        when {
            dat.isLoadingCatalog && dat.files.isEmpty() -> XrayDatCenteredLoading("Ищем DAT-файлы…")
            dat.selectedFile == null -> XrayDatEmpty("Для ${dat.selectedKind.displayName} нет доступных файлов.")
            dat.geodatInstalled == false -> XrayDatEmpty("Просмотрщик работает через xk-geodat. Установите его в веб-панели и обновите экран.")
            dat.selectedTag == null -> XrayDatTagsPane(dat, controller, scope)
            else -> XrayDatItemsPane(dat, controller, scope)
        }
    }

    if (showFilePicker) {
        XrayDatFilePickerDialog(
            files = dat.files.filter { it.kind == dat.selectedKind },
            selectedPath = dat.selectedFilePath,
            onDismiss = { showFilePicker = false },
            onSelect = { path ->
                showFilePicker = false
                scope.launch { controller.selectXrayDatFile(path) }
            },
        )
    }
}

@Composable
private fun XrayDatHeader(isLoading: Boolean, onRefresh: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                "DAT Explorer",
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                "Только просмотр GeoIP / GeoSite",
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        XrayDatIconAction(Icons.Outlined.Refresh, "Обновить", !isLoading, onRefresh, loading = isLoading)
    }
}

@Composable
private fun XrayDatKindSelector(
    selected: XrayDatKind,
    enabled: Boolean,
    onSelect: (XrayDatKind) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        XrayDatKind.entries.forEach { kind ->
            val active = kind == selected
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(32.dp)
                    .background(
                        if (active) WebPanelPalette.AccentDeep else WebPanelPalette.Panel,
                        RoundedCornerShape(8.dp),
                    )
                    .border(
                        1.dp,
                        (if (active) WebPanelPalette.Border else WebPanelPalette.MutedDeep).copy(alpha = 0.55f),
                        RoundedCornerShape(8.dp),
                    )
                    .clickable(enabled = enabled && !active) { onSelect(kind) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    kind.displayName,
                    color = if (active) WebPanelPalette.TextStrong else WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

@Composable
private fun XrayDatFileSelector(file: XrayDatFile?, enabled: Boolean, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick),
        shape = RoundedCornerShape(9.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.16f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    file?.name ?: "DAT-файл не выбран",
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    file?.let(::xrayDatFileMeta) ?: "—",
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(Icons.Outlined.KeyboardArrowDown, null, tint = WebPanelPalette.Muted, modifier = Modifier.size(17.dp))
        }
    }
}

@Composable
private fun ColumnScope.XrayDatTagsPane(
    dat: XrayDatState,
    controller: CompanionController,
    scope: CoroutineScope,
) {
    XrayDatSearchField(
        value = dat.valueQuery,
        onValueChange = controller::updateXrayDatValueQuery,
        placeholder = if (dat.selectedKind == XrayDatKind.GeoIp) "Найти IP по тегам" else "Найти домен по тегам",
        enabled = !dat.isLookingUpValue && !dat.isLoadingTags,
        onSearch = { scope.launch { controller.lookupXrayDatValue() } },
        loading = dat.isLookingUpValue,
    )
    XrayDatSearchField(
        value = dat.tagQuery,
        onValueChange = controller::updateXrayDatTagQuery,
        placeholder = "Фильтр тегов",
        enabled = !dat.isLoadingTags,
    )

    val lookupMatches = dat.lookupMatches
    val visible = lookupMatches ?: dat.visibleTags
    val status = when {
        dat.isLoadingTags -> "Читаем теги…"
        dat.lookupError != null -> dat.lookupError
        dat.tagsError != null -> dat.tagsError
        lookupMatches != null -> "Совпадений: ${lookupMatches.size}"
        else -> "Теги: ${visible.size} из ${dat.tags.size}"
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            status.orEmpty(),
            modifier = Modifier.weight(1f),
            color = if (dat.lookupError != null || dat.tagsError != null) WebPanelPalette.Error else WebPanelPalette.Muted,
            style = MaterialTheme.typography.labelSmall,
        )
        if (lookupMatches != null) {
            Text(
                "Сбросить",
                modifier = Modifier.clickable { controller.updateXrayDatValueQuery("") }.padding(4.dp),
                color = WebPanelPalette.TextBlue,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
            )
        }
    }

    if (dat.isLoadingTags && dat.tags.isEmpty()) {
        XrayDatCenteredLoading("Читаем DAT…")
    } else if (visible.isEmpty()) {
        XrayDatEmpty(if (lookupMatches != null) "Значение не найдено ни в одном теге." else "Совпадений по тегам нет.")
    } else {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            items(visible, key = { it.name }) { tag ->
                XrayDatTagRow(tag) { scope.launch { controller.selectXrayDatTag(tag.name) } }
            }
        }
    }
}

@Composable
private fun XrayDatTagRow(tag: XrayDatTag, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(8.dp),
        color = Color(0xFF071229),
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.12f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                tag.name,
                modifier = Modifier.weight(1f),
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            tag.count?.let {
                Text("$it", color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
                Spacer(Modifier.width(6.dp))
            }
            Icon(Icons.AutoMirrored.Outlined.NavigateNext, null, tint = WebPanelPalette.Muted, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun ColumnScope.XrayDatItemsPane(
    dat: XrayDatState,
    controller: CompanionController,
    scope: CoroutineScope,
) {
    val clipboard = LocalClipboardManager.current
    val tag = dat.selectedTag.orEmpty()

    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        XrayDatIconAction(Icons.AutoMirrored.Outlined.ArrowBack, "К тегам", !dat.isLoadingItems, {
            controller.closeXrayDatTag()
        })
        Column(modifier = Modifier.weight(1f)) {
            Text(tag, color = WebPanelPalette.TextStrong, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                dat.itemTotal?.let { "Элементов: $it" } ?: "Содержимое тега",
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }

    XrayDatSearchField(
        value = dat.itemQuery,
        onValueChange = controller::updateXrayDatItemQuery,
        placeholder = if (dat.selectedKind == XrayDatKind.GeoIp) "CIDR или IP во всём теге" else "Домен во всём теге",
        enabled = !dat.isLoadingItems,
        onSearch = { scope.launch { controller.searchXrayDatItems() } },
        onClear = if (dat.isItemSearch) ({ scope.launch { controller.clearXrayDatItemSearch() } }) else null,
        loading = dat.isLoadingItems,
    )

    if (dat.selectedKind == XrayDatKind.GeoIp) {
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            XrayDatMiniChip("Все", !dat.isItemSearch, !dat.isLoadingItems) {
                scope.launch { controller.clearXrayDatItemSearch() }
            }
            XrayDatMiniChip("IPv4", dat.itemQuery == ".", !dat.isLoadingItems) {
                controller.updateXrayDatItemQuery(".")
                scope.launch { controller.searchXrayDatItems() }
            }
            XrayDatMiniChip("IPv6", dat.itemQuery == ":", !dat.isLoadingItems) {
                controller.updateXrayDatItemQuery(":")
                scope.launch { controller.searchXrayDatItems() }
            }
        }
    }

    val status = when {
        dat.itemsError != null -> dat.itemsError
        dat.isLoadingItems -> "Загрузка…"
        dat.isItemSearch -> "Найдено ${dat.items.size} • просмотрено ${dat.searchViewed}${dat.itemTotal?.let { " из $it" }.orEmpty()}"
        dat.itemTotal != null -> "${dat.itemOffset + 1}–${dat.itemOffset + dat.items.size} из ${dat.itemTotal}"
        else -> "Элементов на странице: ${dat.items.size}"
    }
    Text(
        status.orEmpty(),
        color = if (dat.itemsError != null) WebPanelPalette.Error else WebPanelPalette.Muted,
        style = MaterialTheme.typography.labelSmall,
    )

    if (dat.items.isEmpty() && dat.isLoadingItems) {
        XrayDatCenteredLoading("Читаем тег…")
    } else if (dat.items.isEmpty()) {
        XrayDatEmpty(if (dat.itemsError != null) dat.itemsError else "Элементы не найдены.")
    } else {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            items(dat.items, key = { "${it.type}:${it.value}" }) { item ->
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(7.dp),
                    color = Color(0xFF071229),
                    border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.10f)),
                ) {
                    Row(
                        modifier = Modifier.padding(start = 9.dp, end = 4.dp, top = 5.dp, bottom = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            item.value,
                            modifier = Modifier.weight(1f),
                            color = WebPanelPalette.TextStrong,
                            style = MaterialTheme.typography.labelMedium,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        XrayDatIconAction(Icons.Outlined.ContentCopy, "Копировать", true, {
                            clipboard.setText(AnnotatedString(item.value))
                        }, border = false)
                    }
                }
            }
        }
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        XrayDatIconAction(Icons.AutoMirrored.Outlined.NavigateBefore, "Назад", dat.canLoadPreviousPage && !dat.isLoadingItems, {
            scope.launch { controller.previousXrayDatPage() }
        })
        Text(
            if (dat.isItemSearch) "Поиск" else "Страница ${dat.itemOffset / dat.itemLimit + 1}",
            modifier = Modifier.padding(horizontal = 12.dp),
            color = WebPanelPalette.Muted,
            style = MaterialTheme.typography.labelSmall,
        )
        XrayDatIconAction(Icons.AutoMirrored.Outlined.NavigateNext, "Далее", dat.canLoadNextPage && !dat.isLoadingItems, {
            scope.launch { controller.nextXrayDatPage() }
        })
    }
}

@Composable
private fun XrayDatSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    onSearch: (() -> Unit)? = null,
    onClear: (() -> Unit)? = null,
    loading: Boolean = false,
) {
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodySmall.copy(color = WebPanelPalette.TextStrong),
        cursorBrush = SolidColor(WebPanelPalette.Border),
        keyboardOptions = KeyboardOptions(imeAction = if (onSearch != null) ImeAction.Search else ImeAction.Done),
        keyboardActions = KeyboardActions(onSearch = { onSearch?.invoke() }),
        modifier = Modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Row(
                modifier = Modifier.fillMaxWidth().height(36.dp).background(WebPanelPalette.Surface, shape).border(1.dp, WebPanelPalette.Border.copy(alpha = 0.16f), shape).padding(start = 8.dp, end = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Icon(Icons.Outlined.Search, null, tint = WebPanelPalette.Muted, modifier = Modifier.size(15.dp))
                Box(modifier = Modifier.weight(1f)) {
                    if (value.isBlank()) Text(placeholder, color = WebPanelPalette.MutedDeep, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    inner()
                }
                when {
                    loading -> CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 1.5.dp, color = WebPanelPalette.Border)
                    onClear != null -> XrayDatIconAction(Icons.Outlined.Close, "Очистить", enabled, onClear, border = false)
                    onSearch != null -> XrayDatIconAction(Icons.Outlined.Search, "Найти", enabled && value.isNotBlank(), onSearch, border = false)
                }
            }
        },
    )
}

@Composable
private fun XrayDatMiniChip(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .height(26.dp)
            .background(if (selected) WebPanelPalette.AccentDeep else Color.Transparent, RoundedCornerShape(7.dp))
            .border(1.dp, (if (selected) WebPanelPalette.Border else WebPanelPalette.MutedDeep).copy(alpha = 0.45f), RoundedCornerShape(7.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = if (selected) WebPanelPalette.TextStrong else WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun XrayDatIconAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    enabled: Boolean,
    onClick: () -> Unit,
    loading: Boolean = false,
    border: Boolean = true,
) {
    val tint = if (enabled) WebPanelPalette.TextBlue else WebPanelPalette.MutedDeep
    val modifier = Modifier.size(28.dp)
        .then(if (border) Modifier.border(1.dp, tint.copy(alpha = 0.30f), RoundedCornerShape(8.dp)) else Modifier)
        .clickable(enabled = enabled, onClick = onClick)
    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        if (loading) CircularProgressIndicator(modifier = Modifier.size(13.dp), strokeWidth = 1.5.dp, color = tint)
        else Icon(icon, description, tint = tint, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun XrayDatNotice(message: String, error: Boolean) {
    val color = if (error) WebPanelPalette.Error else WebPanelPalette.Warning
    Surface(shape = RoundedCornerShape(8.dp), color = color.copy(alpha = 0.08f), border = BorderStroke(1.dp, color.copy(alpha = 0.24f))) {
        Text(message, modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), color = color, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun XrayDatCenteredLoading(message: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 1.8.dp, color = WebPanelPalette.Border)
        Spacer(Modifier.width(7.dp))
        Text(message, color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun XrayDatEmpty(message: String?) {
    Surface(shape = RoundedCornerShape(9.dp), color = WebPanelPalette.Panel, border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.12f))) {
        Text(message.orEmpty(), modifier = Modifier.fillMaxWidth().padding(12.dp), color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun XrayDatFilePickerDialog(
    files: List<XrayDatFile>,
    selectedPath: String,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Text("Выберите DAT-файл", color = WebPanelPalette.TextStrong, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("Файлы обнаружены на роутере автоматически.", color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall)
            LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                items(files, key = { it.path }) { file ->
                    val selected = file.path == selectedPath
                    Surface(
                        modifier = Modifier.fillMaxWidth().clickable { onSelect(file.path) },
                        shape = RoundedCornerShape(8.dp),
                        color = if (selected) WebPanelPalette.AccentDeep else WebPanelPalette.Panel,
                        border = BorderStroke(1.dp, (if (selected) WebPanelPalette.Border else WebPanelPalette.MutedDeep).copy(alpha = 0.35f)),
                    ) {
                        Column(modifier = Modifier.padding(horizontal = 9.dp, vertical = 7.dp)) {
                            Text(file.name, color = WebPanelPalette.TextStrong, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                            Text(xrayDatFileMeta(file), color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            Text("Закрыть", modifier = Modifier.align(Alignment.End).clickable(onClick = onDismiss).padding(8.dp), color = WebPanelPalette.TextBlue, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
        }
    }
}

private fun xrayDatFileMeta(file: XrayDatFile): String = buildList {
    file.sizeBytes?.let { add(xrayDatFileSize(it)) }
    file.modifiedAtEpochSeconds?.let { add(xrayDatTimeFormatter.format(Instant.ofEpochSecond(it))) }
    if (isEmpty()) add(file.path)
}.joinToString(" • ")

private fun xrayDatFileSize(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

private val xrayDatTimeFormatter: DateTimeFormatter = DateTimeFormatter
    .ofPattern("dd.MM.yyyy · HH:mm")
    .withZone(ZoneId.systemDefault())
