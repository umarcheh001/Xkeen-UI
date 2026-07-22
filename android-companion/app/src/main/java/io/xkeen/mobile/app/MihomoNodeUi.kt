package io.xkeen.mobile.app

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoFixHigh
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.launch

@Composable
internal fun MihomoNodeWorkspaceScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val config = state.mihomoConfig
    val node = state.mihomoNode
    val groups = remember(config.content) { mihomoProxyGroupNames(config.content) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshMihomoConfig()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WebPanelPalette.Background)
            .imePadding(),
    ) {
        Surface(color = WebPanelPalette.Surface, shadowElevation = 5.dp) {
            Row(
                modifier = Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                Box(
                    modifier = Modifier.size(34.dp).background(WebPanelPalette.AccentDeep, RoundedCornerShape(10.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.Hub, null, tint = WebPanelPalette.TextBlue, modifier = Modifier.size(19.dp))
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(
                        "Узел Mihomo",
                        color = WebPanelPalette.TextStrong,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "Черновик · ${node.mode.displayName}",
                        color = WebPanelPalette.Muted,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                if (node.isImporting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = WebPanelPalette.TextBlue,
                    )
                }
            }
        }

        when {
            config.operation == MihomoConfigOperationPhase.Loading && !config.hasLoaded -> {
                Box(modifier = Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = WebPanelPalette.Accent)
                }
            }

            !config.hasLoaded -> {
                Column(
                    modifier = Modifier.weight(1f).fillMaxWidth().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(config.message, color = WebPanelPalette.Error, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(onClick = { scope.launch { controller.refreshMihomoConfig(force = true) } }) {
                        Text("Повторить")
                    }
                }
            }

            else -> {
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = Color(0xFF071229),
                        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.18f)),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(11.dp),
                            horizontalArrangement = Arrangement.spacedBy(9.dp),
                            verticalAlignment = Alignment.Top,
                        ) {
                            Icon(Icons.Outlined.Info, null, tint = WebPanelPalette.TextBlue, modifier = Modifier.size(18.dp))
                            Text(
                                "Отдельного YAML preview здесь нет. Источник будет преобразован в черновик, после чего приложение откроет редактор и выделит вставленный блок.",
                                modifier = Modifier.weight(1f),
                                color = WebPanelPalette.Muted,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }

                    Text(
                        "ТИП ИСТОЧНИКА",
                        color = WebPanelPalette.Border,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        MihomoNodeImportMode.entries.forEach { mode ->
                            FilterChip(
                                selected = node.mode == mode,
                                onClick = { controller.selectMihomoNodeMode(mode) },
                                enabled = !node.isImporting,
                                label = { Text(mode.displayName, maxLines = 1) },
                            )
                        }
                    }

                    OutlinedTextField(
                        value = node.source,
                        onValueChange = controller::updateMihomoNodeSource,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 146.dp, max = 280.dp),
                        enabled = !node.isImporting,
                        label = { Text(node.mode.inputLabel) },
                        placeholder = { Text(node.mode.placeholder(), color = WebPanelPalette.MutedDeep) },
                        supportingText = {
                            Text(node.mode.supportingText(), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        },
                        minLines = 5,
                        maxLines = 12,
                    )

                    if (node.mode == MihomoNodeImportMode.Auto || node.mode == MihomoNodeImportMode.Subscription) {
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = Color(0xFF071229),
                            border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.18f)),
                        ) {
                            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp)) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable(enabled = !node.isImporting) {
                                            controller.updateMihomoNodeAutoUpdate(!node.autoUpdateSubscriptions)
                                        },
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Checkbox(
                                        checked = node.autoUpdateSubscriptions,
                                        onCheckedChange = controller::updateMihomoNodeAutoUpdate,
                                        enabled = !node.isImporting,
                                    )
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(
                                            "Автообновление Xray-подписки",
                                            color = WebPanelPalette.TextStrong,
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontWeight = FontWeight.Medium,
                                        )
                                        Text(
                                            "Регистрируется только если источник распознан как Xray JSON",
                                            color = WebPanelPalette.Muted,
                                            style = MaterialTheme.typography.labelSmall,
                                        )
                                    }
                                }
                                if (node.autoUpdateSubscriptions) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        listOf(6, 12, 24, 48, 72).forEach { hours ->
                                            FilterChip(
                                                selected = node.subscriptionIntervalHours == hours,
                                                onClick = { controller.updateMihomoNodeInterval(hours) },
                                                enabled = !node.isImporting,
                                                label = { Text("$hours ч") },
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = WebPanelPalette.Panel,
                        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.18f)),
                    ) {
                        Column(modifier = Modifier.fillMaxWidth().padding(11.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        "Добавить в группы",
                                        color = WebPanelPalette.TextStrong,
                                        style = MaterialTheme.typography.titleSmall,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                    Text(
                                        if (groups.isEmpty()) "В config.yaml группы не найдены" else "Выбрано ${node.selectedGroups.count { it in groups }} из ${groups.size}",
                                        color = WebPanelPalette.Muted,
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                                }
                                NodeGroupAction("Все", groups.isNotEmpty() && !node.isImporting) {
                                    controller.setAllMihomoNodeGroups(groups, selected = true)
                                }
                                Spacer(Modifier.width(5.dp))
                                NodeGroupAction("Снять", node.selectedGroups.isNotEmpty() && !node.isImporting) {
                                    controller.setAllMihomoNodeGroups(groups, selected = false)
                                }
                            }
                            if (groups.isNotEmpty()) {
                                HorizontalDivider(
                                    modifier = Modifier.padding(vertical = 7.dp),
                                    color = WebPanelPalette.Border.copy(alpha = 0.14f),
                                )
                                groups.forEach { group ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable(enabled = !node.isImporting) { controller.toggleMihomoNodeGroup(group) }
                                            .padding(vertical = 2.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Checkbox(
                                            checked = group in node.selectedGroups,
                                            onCheckedChange = { controller.toggleMihomoNodeGroup(group) },
                                            enabled = !node.isImporting,
                                        )
                                        Text(
                                            group,
                                            color = WebPanelPalette.Text,
                                            style = MaterialTheme.typography.bodyMedium,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    if (config.hasChanges) {
                        NodeMessageCard(
                            "В редакторе уже есть несохранённые изменения. Новый узел будет добавлен поверх текущего черновика, не заменяя его.",
                            error = false,
                            warning = true,
                        )
                    }
                    node.error?.let { NodeMessageCard(it, error = true) }
                        ?: NodeMessageCard(
                            node.message,
                            success = node.lastInsertedNames.isNotEmpty() && node.source.isBlank(),
                        )
                }

                Surface(
                    color = WebPanelPalette.BackgroundDeep,
                    border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.14f)),
                ) {
                    Button(
                        onClick = { scope.launch { controller.importMihomoNodeDraft() } },
                        enabled = node.source.isNotBlank() && !node.isImporting && !config.isBusy,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 9.dp),
                    ) {
                        if (node.isImporting) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(17.dp),
                                strokeWidth = 2.dp,
                                color = WebPanelPalette.TextStrong,
                            )
                            Spacer(Modifier.width(8.dp))
                        } else {
                            Icon(Icons.Outlined.AutoFixHigh, null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(if (node.isImporting) "Добавляем…" else "Добавить в редактор")
                    }
                }
            }
        }
    }
}

@Composable
private fun NodeGroupAction(label: String, enabled: Boolean, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = if (enabled) WebPanelPalette.AccentDeep else WebPanelPalette.Surface,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = if (enabled) 0.28f else 0.12f)),
        modifier = Modifier.clickable(enabled = enabled, onClick = onClick),
    ) {
        Text(
            label,
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 6.dp),
            color = if (enabled) WebPanelPalette.TextBlue else WebPanelPalette.MutedDeep,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

@Composable
private fun NodeMessageCard(
    message: String,
    error: Boolean = false,
    warning: Boolean = false,
    success: Boolean = false,
) {
    val tone = when {
        error -> WebPanelPalette.Error
        warning -> WebPanelPalette.Warning
        success -> WebPanelPalette.Success
        else -> WebPanelPalette.TextBlue
    }
    Surface(
        shape = RoundedCornerShape(10.dp),
        color = tone.copy(alpha = 0.08f),
        border = BorderStroke(1.dp, tone.copy(alpha = 0.24f)),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                if (success) Icons.Outlined.CheckCircle else Icons.Outlined.Info,
                null,
                tint = tone,
                modifier = Modifier.size(17.dp),
            )
            Text(message, modifier = Modifier.weight(1f), color = WebPanelPalette.Muted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

private fun MihomoNodeImportMode.placeholder(): String = when (this) {
    MihomoNodeImportMode.Auto -> "vless://…\nили https://…\nили конфигурация VPN"
    MihomoNodeImportMode.Proxy -> "vless://…  trojan://…  vmess://…  ss://…  hy2://…"
    MihomoNodeImportMode.Subscription -> "https://example.net/subscription"
    MihomoNodeImportMode.WireGuard -> "[Interface]\nPrivateKey = …\n\n[Peer]\nPublicKey = …"
    MihomoNodeImportMode.OpenVpn -> "client\nremote vpn.example.net 1194\n…"
    MihomoNodeImportMode.Tailscale -> "hostname: xkeen\nauth-key: tskey-auth-…"
}

private fun MihomoNodeImportMode.supportingText(): String = when (this) {
    MihomoNodeImportMode.Auto -> "Тип определяется автоматически; несколько ссылок можно вставить построчно."
    MihomoNodeImportMode.Proxy -> "Поддерживаются VLESS, Trojan, VMess, Shadowsocks и Hysteria2."
    MihomoNodeImportMode.Subscription -> "Xray JSON станет статическими proxies, Clash/Mihomo — proxy-provider."
    MihomoNodeImportMode.WireGuard -> "Вставьте конфигурацию целиком, включая Interface и Peer."
    MihomoNodeImportMode.OpenVpn -> "Вставьте полное содержимое файла .ovpn."
    MihomoNodeImportMode.Tailscale -> "Поддерживается конфигурация параметрами или tailscale:// ссылка."
}
