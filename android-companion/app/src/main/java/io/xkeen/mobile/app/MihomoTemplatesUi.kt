package io.xkeen.mobile.app

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.launch

@Composable
internal fun MihomoTemplatesWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val templates = state.mihomoTemplates
    val config = state.mihomoConfig
    val scope = rememberCoroutineScope()
    val applyTemplateName = remember { mutableStateOf<String?>(null) }

    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshMihomoTemplates()
    }
    LaunchedEffect(state.dashboard.endpoint, config.hasLoaded) {
        if (!config.hasLoaded) controller.refreshMihomoConfig()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background),
    ) {
        Surface(color = WebPanelPalette.Surface, shadowElevation = 5.dp) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(
                    Icons.AutoMirrored.Outlined.Article,
                    contentDescription = null,
                    tint = WebPanelPalette.TextBlue,
                )
                Text(
                    text = "Шаблоны Mihomo",
                    modifier = Modifier.weight(1f),
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                IconButton(
                    onClick = { scope.launch { controller.refreshMihomoTemplates(force = true) } },
                    enabled = !templates.isBusy,
                ) {
                    Icon(Icons.Outlined.Refresh, contentDescription = "Обновить список шаблонов")
                }
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                templates.isLoadingList && !templates.hasLoaded -> CircularProgressIndicator(
                    color = WebPanelPalette.Accent,
                    modifier = Modifier.align(Alignment.Center),
                )

                templates.error != null && !templates.hasLoaded -> Column(
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        text = templates.error,
                        color = WebPanelPalette.Error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    OutlinedButton(
                        onClick = { scope.launch { controller.refreshMihomoTemplates(force = true) } },
                    ) {
                        Text("Повторить")
                    }
                }

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(9.dp),
                ) {
                    item {
                        Text(
                            text = "Шаблон можно просмотреть и передать в редактор config.yaml. Серверный конфиг не меняется до проверки и сохранения в разделе «Роутинг Mihomo».",
                            color = WebPanelPalette.Muted,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(horizontal = 2.dp, vertical = 2.dp),
                        )
                    }
                    templates.error?.let { error ->
                        item {
                            Surface(
                                color = Color(0xFF341014),
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    text = error,
                                    color = WebPanelPalette.Error,
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.padding(10.dp),
                                )
                            }
                        }
                    }
                    if (templates.hasLoaded && templates.templates.isEmpty()) {
                        item {
                            Surface(
                                color = WebPanelPalette.Surface,
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    text = "В /opt/etc/mihomo/templates пока нет YAML-шаблонов. Добавить их можно непосредственно на Xkeen-узле.",
                                    color = WebPanelPalette.Muted,
                                    style = MaterialTheme.typography.bodyMedium,
                                    modifier = Modifier.padding(16.dp),
                                )
                            }
                        }
                    }
                    items(templates.templates, key = MihomoTemplate::name) { template ->
                        val selected = templates.selectedName == template.name
                        MihomoTemplateCard(
                            template = template,
                            selected = selected,
                            selectedContent = templates.selectedContent,
                            isBusy = templates.isBusy,
                            onSelect = {
                                scope.launch {
                                    controller.loadMihomoTemplate(template.name, force = selected)
                                }
                            },
                            onClose = controller::closeMihomoTemplatePreview,
                            onApply = { applyTemplateName.value = template.name },
                        )
                    }
                }
            }
        }

        Surface(color = WebPanelPalette.BackgroundDeep) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (templates.isBusy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        color = WebPanelPalette.TextBlue,
                    )
                }
                Text(
                    text = templates.message,
                    color = if (templates.error != null) WebPanelPalette.Error else WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }

    applyTemplateName.value?.let { name ->
        XkeenDialog(onDismissRequest = { applyTemplateName.value = null }) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Загрузить шаблон в редактор?", style = MaterialTheme.typography.titleMedium)
                Text(
                    text = if (config.hasChanges) {
                        "Шаблон $name заменит несохранённые изменения в редакторе config.yaml. Серверный файл пока не изменится."
                    } else {
                        "Шаблон $name заменит текст в редакторе config.yaml. Серверный файл пока не изменится."
                    },
                    color = WebPanelPalette.Muted,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    OutlinedButton(onClick = { applyTemplateName.value = null }) { Text("Отмена") }
                    Button(
                        onClick = {
                            applyTemplateName.value = null
                            controller.applySelectedMihomoTemplateToEditor()
                        },
                        modifier = Modifier.padding(start = 8.dp),
                        enabled = config.hasLoaded && !config.isBusy,
                    ) {
                        Text("В редактор")
                    }
                }
            }
        }
    }
}

@Composable
private fun MihomoTemplateCard(
    template: MihomoTemplate,
    selected: Boolean,
    selectedContent: String,
    isBusy: Boolean,
    onSelect: () -> Unit,
    onClose: () -> Unit,
    onApply: () -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    Surface(
        color = if (selected) WebPanelPalette.SurfaceRaised else WebPanelPalette.Surface,
        shape = shape,
        modifier = Modifier
            .fillMaxWidth()
            .then(if (selected) Modifier.border(1.dp, WebPanelPalette.Border, shape) else Modifier)
            .clickable(enabled = !isBusy, onClick = onSelect),
    ) {
        Column(
            modifier = Modifier.padding(13.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    Icons.AutoMirrored.Outlined.Article,
                    contentDescription = null,
                    tint = if (selected) WebPanelPalette.TextBlue else WebPanelPalette.Muted,
                )
                Text(
                    text = template.name,
                    modifier = Modifier.weight(1f),
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = if (selected) "ОТКРЫТ" else "ПРОСМОТР",
                    color = if (selected) WebPanelPalette.Success else WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
                if (selected) {
                    IconButton(
                        onClick = onClose,
                        enabled = !isBusy,
                        modifier = Modifier.size(36.dp),
                    ) {
                        Icon(
                            Icons.Outlined.Close,
                            contentDescription = "Закрыть просмотр шаблона",
                        )
                    }
                }
            }
            if (selected) {
                Text(
                    text = selectedContent.ifEmpty { "Пустой YAML-шаблон" },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 360.dp)
                        .background(WebPanelPalette.BackgroundDeep, RoundedCornerShape(8.dp))
                        .verticalScroll(rememberScrollState())
                        .padding(10.dp),
                    color = WebPanelPalette.Text,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
                Button(
                    onClick = onApply,
                    enabled = !isBusy,
                    modifier = Modifier.align(Alignment.End),
                ) {
                    Text("Загрузить в редактор")
                }
            }
        }
    }
}
