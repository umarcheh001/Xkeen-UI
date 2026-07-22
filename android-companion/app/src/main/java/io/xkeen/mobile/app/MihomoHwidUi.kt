package io.xkeen.mobile.app

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.launch

@Composable
internal fun MihomoHwidWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val hwid = state.mihomoHwid
    val config = state.mihomoConfig
    val scope = rememberCoroutineScope()
    var diagnosticsExpanded by rememberSaveable { mutableStateOf(false) }
    var confirmApply by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshMihomoConfig()
    }
    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshMihomoHwidDevice()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .imePadding(),
    ) {
        HwidTopBar(
            hwid = hwid,
            onClose = controller::closeMihomoHwidWorkspace,
        )

        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            HwidIdentityCard(
                state = hwid,
                onRefresh = { scope.launch { controller.refreshMihomoHwidDevice(force = true) } },
            )

            HwidInputCard(
                state = hwid,
                onUrlChange = controller::updateMihomoHwidUrl,
                onNameChange = controller::updateMihomoHwidProviderName,
                onIgnoreTlsChange = controller::updateMihomoHwidIgnoreTls,
            )

            if (hwid.error != null) {
                HwidMessageCard(message = hwid.error, tone = WebPanelPalette.Error)
            } else if (hwid.probe != null) {
                HwidProbeSummaryCard(hwid)
            }

            if (hwid.probe != null && hwid.probe.warnings.isNotEmpty()) {
                hwid.probe.warnings.forEach { warning ->
                    HwidMessageCard(message = warning, tone = WebPanelPalette.Warning)
                }
            }

            if (hwid.previewYaml.isNotBlank()) {
                HwidPreviewCard(hwid)
            }

            if (hwid.device != null) {
                HwidDiagnosticsCard(
                    state = hwid,
                    expanded = diagnosticsExpanded,
                    onExpandedChange = { diagnosticsExpanded = it },
                )
            }

            when {
                config.operation == MihomoConfigOperationPhase.Loading && !config.hasLoaded ->
                    HwidMessageCard("Загружаем активный config.yaml для безопасной вставки provider.", WebPanelPalette.TextBlue)

                !config.hasLoaded ->
                    HwidMessageCard(config.message, WebPanelPalette.Error)

                config.hasChanges ->
                    HwidMessageCard(
                        "В редакторе есть несохранённый YAML. Прямое применение отключено, чтобы не потерять черновик; используйте «В редактор».",
                        WebPanelPalette.Warning,
                    )
            }
        }

        HwidBottomActions(
            state = hwid,
            config = config,
            onCancel = controller::closeMihomoHwidWorkspace,
            onProbe = { scope.launch { controller.probeMihomoHwidSubscription() } },
            onInsert = controller::insertMihomoHwidIntoDraft,
            onApply = { confirmApply = true },
        )
    }

    if (confirmApply) {
        XkeenDialog(onDismissRequest = { if (!hwid.isBusy) confirmApply = false }) {
            Column(
                modifier = Modifier.padding(19.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    "Применить HWID-provider?",
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    "Provider будет добавлен в активный config.yaml на роутере, после чего сервер поставит перезапуск xkeen в очередь.",
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    OutlinedButton(onClick = { confirmApply = false }) { Text("Отмена") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = {
                            confirmApply = false
                            scope.launch { controller.applyMihomoHwidAndRestart() }
                        },
                    ) {
                        Text("Применить")
                    }
                }
            }
        }
    }
}

@Composable
private fun HwidTopBar(
    hwid: MihomoHwidState,
    onClose: () -> Unit,
) {
    Surface(color = WebPanelPalette.Surface, shadowElevation = 5.dp) {
        Row(
            modifier = Modifier.fillMaxWidth().height(56.dp).padding(start = 12.dp, end = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .background(
                        brush = Brush.linearGradient(
                            listOf(WebPanelPalette.AccentDeep, Color(0xFF0D5B70)),
                        ),
                        shape = RoundedCornerShape(11.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.Devices, null, tint = WebPanelPalette.TextBlue, modifier = Modifier.size(20.dp))
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    "HWID-подписка",
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    when (hwid.operation) {
                        MihomoHwidOperationPhase.LoadingDevice -> "Mihomo · получаем идентификатор"
                        MihomoHwidOperationPhase.Probing -> "Mihomo · проверяем provider"
                        MihomoHwidOperationPhase.Applying -> "Mihomo · применяем конфигурацию"
                        MihomoHwidOperationPhase.Idle -> "Mihomo · premium provider"
                    },
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                )
            }
            IconButton(onClick = onClose, enabled = !hwid.isBusy) {
                Icon(Icons.Outlined.Close, "Закрыть HWID-подписку", tint = WebPanelPalette.Muted)
            }
        }
    }
}

@Composable
private fun HwidIdentityCard(
    state: MihomoHwidState,
    onRefresh: () -> Unit,
) {
    val device = state.device
    val loading = state.operation == MihomoHwidOperationPhase.LoadingDevice
    val tone = when {
        state.deviceError != null -> WebPanelPalette.Error
        device?.hwid.isNullOrBlank() -> WebPanelPalette.Warning
        else -> WebPanelPalette.Success
    }
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, tone.copy(alpha = 0.26f)),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.linearGradient(
                        listOf(tone.copy(alpha = 0.11f), Color.Transparent, WebPanelPalette.Accent.copy(alpha = 0.06f)),
                    ),
                )
                .padding(13.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).background(tone, CircleShape))
                    Spacer(Modifier.width(7.dp))
                    Text(
                        if (device?.hwid.isNullOrBlank()) "DEVICE IDENTITY" else "DEVICE IDENTITY READY",
                        color = tone,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.weight(1f))
                    IconButton(
                        onClick = onRefresh,
                        enabled = !state.isBusy,
                        modifier = Modifier.size(32.dp),
                    ) {
                        if (loading) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = tone)
                        } else {
                            Icon(Icons.Outlined.Refresh, "Обновить HWID", tint = WebPanelPalette.Muted, modifier = Modifier.size(18.dp))
                        }
                    }
                }
                Text(
                    text = device?.hwid?.ifBlank { "HWID не определён" } ?: if (loading) "Получаем HWID…" else "Нет данных устройства",
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.titleLarge,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    device?.source?.takeIf(String::isNotBlank)?.let { HwidMetaPill(it.hwidSourceLabel()) }
                    device?.format?.takeIf(String::isNotBlank)?.let { HwidMetaPill(it.uppercase()) }
                    device?.deviceModel?.takeIf(String::isNotBlank)?.let { HwidMetaPill(it) }
                    if (device?.matchesRouterMac == true) HwidMetaPill("ROUTER MAC", WebPanelPalette.Success)
                    if (device?.hasManualOverride == true) HwidMetaPill("OVERRIDE", WebPanelPalette.Warning)
                }
                state.deviceError?.let {
                    Text(it, color = WebPanelPalette.Error, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun HwidInputCard(
    state: MihomoHwidState,
    onUrlChange: (String) -> Unit,
    onNameChange: (String) -> Unit,
    onIgnoreTlsChange: (Boolean) -> Unit,
) {
    val sanitizedName = sanitizeMihomoHwidProviderName(state.providerName)
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f)),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            HwidSectionLabel("01", "ПОДПИСКА")
            OutlinedTextField(
                value = state.subscriptionUrl,
                onValueChange = onUrlChange,
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isBusy,
                singleLine = true,
                label = { Text("URL подписки") },
                placeholder = { Text("https://…", color = WebPanelPalette.MutedDeep) },
            )
            OutlinedTextField(
                value = state.providerName,
                onValueChange = onNameChange,
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isBusy,
                singleLine = true,
                label = { Text("Имя provider") },
                placeholder = { Text("например: My_Sub", color = WebPanelPalette.MutedDeep) },
                supportingText = if (state.providerName.isNotBlank() && sanitizedName != state.providerName.trim()) {
                    { Text("В YAML: $sanitizedName") }
                } else {
                    null
                },
            )
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = WebPanelPalette.Surface.copy(alpha = 0.74f),
                border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.14f)),
                modifier = Modifier.clickable(enabled = !state.isBusy) { onIgnoreTlsChange(!state.ignoreTls) },
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 7.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            "Игнорировать TLS",
                            color = WebPanelPalette.TextStrong,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                        )
                        Text(
                            "Только для битого или самоподписанного сертификата",
                            color = WebPanelPalette.Muted,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                    XkeenCompactSwitch(
                        checked = state.ignoreTls,
                        enabled = !state.isBusy,
                        onCheckedChange = onIgnoreTlsChange,
                    )
                }
            }
        }
    }
}

@Composable
private fun HwidProbeSummaryCard(state: MihomoHwidState) {
    val probe = state.probe ?: return
    val tone = if (probe.hasNodes == false) WebPanelPalette.Warning else WebPanelPalette.Success
    Surface(
        shape = RoundedCornerShape(13.dp),
        color = tone.copy(alpha = 0.08f),
        border = BorderStroke(1.dp, tone.copy(alpha = 0.27f)),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(11.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    if (probe.hasNodes == false) Icons.Outlined.Info else Icons.Outlined.CheckCircle,
                    null,
                    tint = tone,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    if (probe.hasNodes == false) "Проверка требует внимания" else "Подписка подтверждена",
                    color = WebPanelPalette.TextStrong,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Text(state.message, color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall)
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                probe.httpStatus?.let { HwidMetaPill("HTTP $it", tone) }
                probe.method?.let { HwidMetaPill(it) }
                probe.timingMillis?.let { HwidMetaPill("${it}ms") }
                probe.nodeCount?.let { HwidMetaPill("$it узлов", if (it > 0) WebPanelPalette.Success else WebPanelPalette.Warning) }
                probe.deviceLimitSummary?.let { HwidMetaPill("устройства $it") }
                probe.profileTitle?.let { HwidMetaPill(it) }
            }
        }
    }
}

@Composable
private fun HwidPreviewCard(state: MihomoHwidState) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f)),
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                HwidSectionLabel("02", "YAML PREVIEW", modifier = Modifier.weight(1f))
                Icon(Icons.Outlined.Code, null, tint = WebPanelPalette.Muted, modifier = Modifier.size(18.dp))
            }
            HorizontalDivider(color = WebPanelPalette.Border.copy(alpha = 0.14f))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF01040D))
                    .horizontalScroll(rememberScrollState())
                    .padding(12.dp),
            ) {
                Text(
                    state.previewYaml,
                    color = Color(0xFFB9D7FF),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    softWrap = false,
                )
            }
        }
    }
}

@Composable
private fun HwidDiagnosticsCard(
    state: MihomoHwidState,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
) {
    val device = state.device ?: return
    val probe = state.probe
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f)),
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onExpandedChange(!expanded) }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "HWID diagnostics",
                        color = WebPanelPalette.TextStrong,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "Идентификатор, runtime и реальные заголовки запроса",
                        color = WebPanelPalette.Muted,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Icon(
                    if (expanded) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
                    if (expanded) "Свернуть диагностику" else "Развернуть диагностику",
                    tint = WebPanelPalette.Muted,
                    modifier = Modifier.size(21.dp),
                )
            }
            AnimatedVisibility(
                visible = expanded,
                enter = fadeIn(tween(140)) + expandVertically(tween(180)),
                exit = fadeOut(tween(110)) + shrinkVertically(tween(160)),
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    HorizontalDivider(color = WebPanelPalette.Border.copy(alpha = 0.14f))
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(11.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        HwidDiagnosticCell(
                            label = "Активный HWID",
                            value = device.hwid.ifBlank { "не определён" },
                            note = listOfNotNull(
                                device.format.takeIf(String::isNotBlank)?.uppercase(),
                                "совпадает с router MAC".takeIf { device.matchesRouterMac },
                                "override отличается от router MAC".takeIf { device.overrideDiffersFromRouter },
                            ).joinToString(" · "),
                            mono = true,
                        )
                        HwidDiagnosticCell(
                            label = "Источник",
                            value = device.source.hwidSourceLabel(),
                            note = device.warning.orEmpty(),
                        )
                        HwidDiagnosticCell(
                            label = "Router MAC → HWID",
                            value = when {
                                device.mac.isNotBlank() && device.macHwid.isNotBlank() -> "${device.mac} → ${device.macHwid}"
                                device.macHwid.isNotBlank() -> device.macHwid
                                device.mac.isNotBlank() -> device.mac
                                else -> "MAC роутера недоступен"
                            },
                            note = "Router-native кандидат, вычисленный панелью.",
                            mono = true,
                        )
                        HwidDiagnosticCell(
                            label = "Устройство и runtime",
                            value = listOf(device.deviceModel, device.osRelease).filter(String::isNotBlank).joinToString(" · ").ifBlank { "—" },
                            note = listOf(
                                device.mihomoVersion.takeIf(String::isNotBlank)?.let { "mihomo $it" }.orEmpty(),
                                device.userAgent.takeIf(String::isNotBlank)?.let { "UA: $it" }.orEmpty(),
                            ).filter(String::isNotBlank).joinToString("\n"),
                        )
                        HwidDiagnosticCell(
                            label = "Request headers",
                            value = (probe?.headersUsed?.takeIf(Map<String, String>::isNotEmpty) ?: device.headers).asHeaderBlock(),
                            mono = true,
                        )
                        HwidDiagnosticCell(
                            label = "Ответ провайдера",
                            value = probe.providerResponseBlock(),
                            mono = true,
                        )
                        if (probe != null) {
                            HwidCompareChain(device, probe)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun HwidCompareChain(device: MihomoHwidDeviceInfo, probe: MihomoHwidProbeResult) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            "IDENTITY CHAIN",
            color = WebPanelPalette.Muted,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
        )
        HwidChainRow("Router-native", device.macHwid.ifBlank { "недоступен" })
        HwidChainRow("Активный запрос", device.hwid.ifBlank { "не определён" })
        HwidChainRow("Подтвердил provider", probe.providerAcceptedHwid ?: "не подтвержден отдельно")
    }
}

@Composable
private fun HwidChainRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WebPanelPalette.Surface.copy(alpha = 0.72f), RoundedCornerShape(9.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(6.dp).background(WebPanelPalette.AccentLight, CircleShape))
        Text(label, color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(0.42f))
        Text(
            value,
            color = WebPanelPalette.Text,
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.weight(0.58f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun HwidDiagnosticCell(
    label: String,
    value: String,
    note: String = "",
    mono: Boolean = false,
) {
    Surface(
        shape = RoundedCornerShape(11.dp),
        color = WebPanelPalette.Surface.copy(alpha = 0.70f),
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.12f)),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(label.uppercase(), color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            Text(
                value.ifBlank { "—" },
                color = WebPanelPalette.Text,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            )
            if (note.isNotBlank()) {
                Text(note, color = WebPanelPalette.MutedDeep, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun HwidBottomActions(
    state: MihomoHwidState,
    config: MihomoConfigState,
    onCancel: () -> Unit,
    onProbe: () -> Unit,
    onInsert: () -> Unit,
    onApply: () -> Unit,
) {
    Surface(color = WebPanelPalette.Background, shadowElevation = 9.dp) {
        Surface(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            shape = RoundedCornerShape(16.dp),
            color = WebPanelPalette.Panel,
            border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f)),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(7.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (!state.isReady) {
                    OutlinedButton(
                        onClick = onCancel,
                        enabled = !state.isBusy,
                        modifier = Modifier.weight(0.34f).height(48.dp),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 9.dp),
                    ) {
                        Icon(Icons.Outlined.Close, null, modifier = Modifier.size(17.dp))
                        Spacer(Modifier.width(5.dp))
                        Text("Отмена", maxLines = 1)
                    }
                    Button(
                        onClick = onProbe,
                        enabled = state.subscriptionUrl.isNotBlank() && !state.isBusy,
                        modifier = Modifier.weight(0.66f).height(48.dp),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 11.dp),
                    ) {
                        if (state.operation == MihomoHwidOperationPhase.Probing) {
                            CircularProgressIndicator(modifier = Modifier.size(17.dp), strokeWidth = 2.dp, color = WebPanelPalette.TextStrong)
                        } else {
                            Icon(Icons.Outlined.Search, null, modifier = Modifier.size(18.dp))
                        }
                        Spacer(Modifier.width(7.dp))
                        Text(if (state.operation == MihomoHwidOperationPhase.Probing) "Проверяем…" else "Проверить", maxLines = 1)
                    }
                } else {
                    OutlinedButton(
                        onClick = onInsert,
                        enabled = config.hasLoaded && !config.isBusy && !state.isBusy,
                        modifier = Modifier.weight(0.43f).height(48.dp),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 7.dp),
                    ) {
                        Icon(Icons.Outlined.Add, null, modifier = Modifier.size(17.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("В редактор", maxLines = 1, style = MaterialTheme.typography.labelMedium)
                    }
                    Button(
                        onClick = onApply,
                        enabled = config.hasLoaded && !config.hasChanges && !config.isBusy && !state.isBusy,
                        modifier = Modifier.weight(0.57f).height(48.dp),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 8.dp),
                    ) {
                        if (state.operation == MihomoHwidOperationPhase.Applying) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = WebPanelPalette.TextStrong)
                        } else {
                            Icon(Icons.Outlined.CheckCircle, null, modifier = Modifier.size(17.dp))
                        }
                        Spacer(Modifier.width(5.dp))
                        Text("Применить + рестарт", maxLines = 1, style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun HwidSectionLabel(number: String, label: String, modifier: Modifier = Modifier) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Box(
            modifier = Modifier.size(24.dp).background(WebPanelPalette.AccentDeep, RoundedCornerShape(7.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text(number, color = WebPanelPalette.TextBlue, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
        }
        Text(label, color = WebPanelPalette.Muted, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun HwidMetaPill(text: String, tone: Color = WebPanelPalette.TextBlue) {
    Surface(
        shape = RoundedCornerShape(50),
        color = tone.copy(alpha = 0.08f),
        border = BorderStroke(1.dp, tone.copy(alpha = 0.22f)),
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            color = tone,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
        )
    }
}

@Composable
private fun HwidMessageCard(message: String, tone: Color) {
    Surface(
        shape = RoundedCornerShape(11.dp),
        color = tone.copy(alpha = 0.08f),
        border = BorderStroke(1.dp, tone.copy(alpha = 0.24f)),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Outlined.Info, null, tint = tone, modifier = Modifier.size(17.dp))
            Text(message, color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        }
    }
}

private fun String.hwidSourceLabel(): String = when (trim()) {
    "XKEEN_MIHOMO_HWID" -> "DevTools override"
    "XKEEN_HWID" -> "XKEEN_HWID override"
    "mac" -> "MAC роутера"
    "machine_id" -> "machine-id"
    "generated_state" -> "сохранённый fallback"
    "generated_ephemeral" -> "временный fallback"
    "none", "" -> "не определён"
    else -> this
}

private fun Map<String, String>.asHeaderBlock(): String = entries
    .sortedBy { it.key.lowercase() }
    .joinToString("\n") { (key, value) -> "$key: $value" }
    .ifBlank { "Специальные заголовки не собраны." }

private fun MihomoHwidProbeResult?.providerResponseBlock(): String {
    if (this == null) return "Появится после проверки."
    return buildList {
        if (responseHeaders.isNotEmpty()) add(responseHeaders.asHeaderBlock())
        deviceLimitSummary?.let { add("devices: $it") }
        nodeCount?.let { add("nodes: $it") }
        placeholderReason?.let { add("placeholder: $it") }
    }.joinToString("\n").ifBlank { "Провайдер не вернул специальных HWID-заголовков." }
}
