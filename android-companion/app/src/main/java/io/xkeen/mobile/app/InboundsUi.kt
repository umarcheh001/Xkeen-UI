package io.xkeen.mobile.app

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.SettingsInputComponent
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
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
internal fun InboundsWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val inbounds = state.inbounds
    val scope = rememberCoroutineScope()
    val showFragmentPicker = rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshInbounds()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 11.dp),
        verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        TitleBlock(
            eyebrow = "Xray · Inbounds",
            title = "Режим работы",
            subtitle = inbounds.message,
        )

        FragmentSelector(
            state = inbounds,
            onOpen = { if (!inbounds.isLoading && !inbounds.isApplying) showFragmentPicker.value = true },
            onRefresh = { scope.launch { controller.refreshInbounds(force = true) } },
        )

        if (inbounds.isLoading && !inbounds.hasLoaded) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 28.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
                Text("Загружаем состояние сервера…", color = WebPanelPalette.Muted)
            }
        } else {
            InboundsMode.entries.forEach { mode ->
                InboundsModeCard(
                    mode = mode,
                    selected = inbounds.selectedMode == mode,
                    applied = inbounds.appliedMode == mode,
                    enabled = !inbounds.isLoading && !inbounds.isApplying,
                    onClick = { controller.selectInboundsMode(mode) },
                )
            }

            RestartToggle(
                checked = inbounds.restartAfterApply,
                enabled = !inbounds.isApplying,
                onCheckedChange = controller::updateInboundsRestartAfterApply,
            )

            Button(
                onClick = { scope.launch { controller.applyInboundsMode() } },
                enabled = inbounds.hasChanges && !inbounds.isLoading && !inbounds.isApplying,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
            ) {
                if (inbounds.isApplying) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(17.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("Применяем…")
                } else {
                    Text(
                        inbounds.selectedMode?.let { mode ->
                            if (inbounds.hasChanges) "Применить ${mode.displayName}" else "${mode.displayName} уже применён"
                        } ?: "Выберите режим",
                    )
                }
            }
        }

        inbounds.error?.let { error ->
            Surface(
                color = WebPanelPalette.Error.copy(alpha = 0.10f),
                shape = RoundedCornerShape(12.dp),
                border = androidx.compose.foundation.BorderStroke(
                    1.dp,
                    WebPanelPalette.Error.copy(alpha = 0.42f),
                ),
            ) {
                Text(
                    text = error,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                    color = WebPanelPalette.Error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        Text(
            text = "Дополнительные пользовательские inbound-секции сохраняются при переключении пресета.",
            color = WebPanelPalette.MutedDeep,
            style = MaterialTheme.typography.labelSmall,
        )
    }

    if (showFragmentPicker.value) {
        InboundsFragmentPickerDialog(
            state = inbounds,
            onDismiss = { showFragmentPicker.value = false },
            onSelect = { filename ->
                showFragmentPicker.value = false
                scope.launch { controller.selectInboundsFragment(filename) }
            },
        )
    }
}

@Composable
private fun FragmentSelector(
    state: InboundsState,
    onOpen: () -> Unit,
    onRefresh: () -> Unit,
) {
    val shape = RoundedCornerShape(14.dp)
    Surface(
        shape = shape,
        color = WebPanelPalette.Panel,
        border = androidx.compose.foundation.BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f)),
    ) {
        Column(modifier = Modifier.padding(horizontal = 11.dp, vertical = 9.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .clickable(onClick = onOpen)
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Outlined.SettingsInputComponent,
                        contentDescription = null,
                        tint = WebPanelPalette.TextBlue,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = state.selectedFragment.ifBlank { "Inbound-фрагмент" },
                        modifier = Modifier.weight(1f),
                        color = WebPanelPalette.TextStrong,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Icon(
                        Icons.Outlined.KeyboardArrowDown,
                        contentDescription = "Выбрать файл",
                        tint = WebPanelPalette.Muted,
                    )
                }
                IconButton(onClick = onRefresh, enabled = !state.isLoading && !state.isApplying) {
                    if (state.isLoading) {
                        CircularProgressIndicator(modifier = Modifier.size(17.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Обновить")
                    }
                }
            }
            if (state.activePath.isNotBlank()) {
                Text(
                    text = state.activePath,
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
private fun InboundsModeCard(
    mode: InboundsMode,
    selected: Boolean,
    applied: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(14.dp)
    val accent = if (selected) WebPanelPalette.Border else WebPanelPalette.Border.copy(alpha = 0.16f)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (selected) WebPanelPalette.AccentDeep.copy(alpha = 0.72f) else WebPanelPalette.Panel,
                shape,
            )
            .border(1.dp, accent, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 3.dp)
                .size(14.dp)
                .border(1.dp, if (selected) WebPanelPalette.Border else WebPanelPalette.Muted, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) Box(Modifier.size(7.dp).background(WebPanelPalette.Border, CircleShape))
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = mode.displayName,
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                if (mode == InboundsMode.Hybrid) {
                    Spacer(Modifier.width(7.dp))
                    Text(
                        text = "РЕКОМЕНДУЕТСЯ",
                        color = WebPanelPalette.Success,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                    )
                } else if (applied) {
                    Spacer(Modifier.width(7.dp))
                    Text(
                        text = "АКТИВЕН",
                        color = WebPanelPalette.Success,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            Text(
                text = when (mode) {
                    InboundsMode.Hybrid -> "UDP через TProxy, TCP через Redirect. Баланс скорости и совместимости."
                    InboundsMode.TProxy -> "TCP и UDP через TProxy. Максимальная совместимость, но выше нагрузка."
                    InboundsMode.Redirect -> "Только TCP через Redirect. Быстро, но не подходит для игр и стриминга."
                },
                color = if (selected) WebPanelPalette.TextBlue else WebPanelPalette.Muted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun RestartToggle(
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = WebPanelPalette.Panel,
        border = androidx.compose.foundation.BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.18f)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled) { onCheckedChange(!checked) }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "Перезапустить Xkeen",
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "Применить новый режим сразу после сохранения",
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
        }
    }
}

@Composable
private fun InboundsFragmentPickerDialog(
    state: InboundsState,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(11.dp),
        ) {
            Text(
                "INBOUNDS XRAY",
                color = WebPanelPalette.Border,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
            Text("Выберите фрагмент", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
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
                            .padding(horizontal = 12.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            fragment.name,
                            modifier = Modifier.weight(1f),
                            color = WebPanelPalette.TextStrong,
                            fontWeight = FontWeight.Bold,
                        )
                        if (selected) Text("АКТИВЕН", color = Color(0xFFDBEAFE), style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                OutlinedButton(onClick = onDismiss) { Text("Закрыть") }
            }
        }
    }
}
