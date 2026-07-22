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
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
    var sourceTypeExpanded by rememberSaveable { mutableStateOf(false) }
    var groupsExpanded by rememberSaveable { mutableStateOf(false) }

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
                    NodeCollapsibleSection(
                        title = "Тип источника",
                        summary = node.mode.displayName,
                        expanded = sourceTypeExpanded,
                        enabled = !node.isImporting,
                        onExpandedChange = { sourceTypeExpanded = it },
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(7.dp),
                        ) {
                            MihomoNodeImportMode.entries.forEach { mode ->
                                FilterChip(
                                    selected = node.mode == mode,
                                    onClick = {
                                        controller.selectMihomoNodeMode(mode)
                                        sourceTypeExpanded = false
                                    },
                                    enabled = !node.isImporting,
                                    label = { Text(mode.displayName, maxLines = 1) },
                                )
                            }
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

                    NodeCollapsibleSection(
                        title = "Добавить в группы",
                        summary = if (groups.isEmpty()) {
                            "В config.yaml группы не найдены"
                        } else {
                            "Выбрано ${node.selectedGroups.count { it in groups }} из ${groups.size}"
                        },
                        expanded = groupsExpanded,
                        enabled = groups.isNotEmpty() && !node.isImporting,
                        onExpandedChange = { groupsExpanded = it },
                    ) {
                        if (groups.isNotEmpty()) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.End,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                NodeGroupAction("Все", groups.isNotEmpty() && !node.isImporting) {
                                    controller.setAllMihomoNodeGroups(groups, selected = true)
                                }
                                Spacer(Modifier.width(5.dp))
                                NodeGroupAction("Снять", node.selectedGroups.isNotEmpty() && !node.isImporting) {
                                    controller.setAllMihomoNodeGroups(groups, selected = false)
                                }
                            }
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

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(WebPanelPalette.Background)
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(16.dp),
                        color = WebPanelPalette.Panel,
                        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f)),
                        shadowElevation = 5.dp,
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(7.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            OutlinedButton(
                                onClick = controller::closeMihomoNodeWorkspace,
                                enabled = !node.isImporting,
                                modifier = Modifier.weight(0.36f).height(48.dp),
                                shape = RoundedCornerShape(12.dp),
                                contentPadding = PaddingValues(horizontal = 10.dp),
                            ) {
                                Icon(Icons.Outlined.Close, null, modifier = Modifier.size(17.dp))
                                Spacer(Modifier.width(6.dp))
                                Text("Отмена", maxLines = 1)
                            }
                            Button(
                                onClick = { scope.launch { controller.importMihomoNodeDraft() } },
                                enabled = node.source.isNotBlank() && !node.isImporting && !config.isBusy,
                                modifier = Modifier.weight(0.64f).height(48.dp),
                                shape = RoundedCornerShape(12.dp),
                                contentPadding = PaddingValues(horizontal = 12.dp),
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
                                Text(if (node.isImporting) "Добавляем…" else "Добавить в редактор", maxLines = 1)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun NodeCollapsibleSection(
    title: String,
    summary: String,
    expanded: Boolean,
    enabled: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    content: @Composable () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = WebPanelPalette.Panel,
        border = BorderStroke(1.dp, WebPanelPalette.Border.copy(alpha = 0.22f)),
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = enabled) { onExpandedChange(!expanded) }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(
                        title,
                        color = WebPanelPalette.TextStrong,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        summary,
                        color = WebPanelPalette.Muted,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Icon(
                    if (expanded) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
                    contentDescription = if (expanded) "Свернуть" else "Развернуть",
                    tint = if (enabled) WebPanelPalette.Muted else WebPanelPalette.MutedDeep,
                    modifier = Modifier.size(21.dp),
                )
            }
            AnimatedVisibility(
                visible = expanded,
                enter = fadeIn(animationSpec = tween(140)) + expandVertically(animationSpec = tween(180)),
                exit = fadeOut(animationSpec = tween(110)) + shrinkVertically(animationSpec = tween(160)),
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    HorizontalDivider(color = WebPanelPalette.Border.copy(alpha = 0.14f))
                    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 11.dp, vertical = 8.dp)) {
                        content()
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
