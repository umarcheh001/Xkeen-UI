package io.xkeen.mobile.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.automirrored.outlined.ExitToApp
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.automirrored.outlined.Rule
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.DataObject
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Lan
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.SettingsInputComponent
import androidx.compose.material.icons.outlined.Subscriptions
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.launch

private val DrawerAccent = WebPanelPalette.Panel
private val DrawerSelection = WebPanelPalette.Accent
private val CoreBlue = WebPanelPalette.Accent

private data class WorkspaceDrawerEntry(
    val section: WorkspaceSection,
    val icon: ImageVector,
)

@Composable
internal fun WorkspaceNavigationFrame(
    state: CompanionUiState,
    controller: DemoCompanionController,
    content: @Composable (
        openDrawer: () -> Unit,
        openCoreDialog: () -> Unit,
    ) -> Unit,
) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var showCoreDialog by rememberSaveable { mutableStateOf(false) }

    fun closeDrawer(afterClose: (() -> Unit)? = null) {
        scope.launch {
            drawerState.close()
            afterClose?.invoke()
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = drawerState.isOpen,
        drawerContent = {
            WorkspaceDrawer(
                state = state,
                onSectionSelected = { section ->
                    controller.selectWorkspaceSection(section)
                    closeDrawer()
                },
                onCore = { closeDrawer { showCoreDialog = true } },
                onConnections = { closeDrawer(controller::openConnections) },
            )
        },
    ) {
        content(
            { scope.launch { drawerState.open() } },
            { showCoreDialog = true },
        )
    }

    if (showCoreDialog) {
        CoreSelectionDialog(
            activeCore = state.dashboard.activeCore,
            availableCores = state.dashboard.availableCores,
            onDismiss = { showCoreDialog = false },
            onApply = { core ->
                controller.switchCore(core)
                showCoreDialog = false
            },
        )
    }
}

@Composable
private fun WorkspaceDrawer(
    state: CompanionUiState,
    onSectionSelected: (WorkspaceSection) -> Unit,
    onCore: () -> Unit,
    onConnections: () -> Unit,
) {
    val entries = remember(state.mainTab, state.dashboard.availableCores) {
        drawerEntries(state.mainTab).filter { entry ->
            entry.section.isAvailableFor(state.dashboard.availableCores)
        }
    }
    val contextTitle = drawerContextTitle(state.mainTab)

    ModalDrawerSheet(
        modifier = Modifier
            .fillMaxHeight()
            .widthIn(max = 324.dp),
        drawerContainerColor = WebPanelPalette.BackgroundDeep,
        drawerShape = RoundedCornerShape(topEnd = 18.dp, bottomEnd = 18.dp),
        windowInsets = WindowInsets(0, 0, 0, 0),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(DrawerAccent)
                .windowInsetsPadding(WindowInsets.statusBars)
                .padding(horizontal = 20.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = "XKEEN MOBILE",
                color = Color(0xFF93C5FD),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
            )
            Text(
                text = contextTitle,
                color = WebPanelPalette.TextStrong,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = state.dashboard.instanceLabel,
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Surface(
                color = WebPanelPalette.SurfaceRaised.copy(alpha = 0.88f),
                shape = RoundedCornerShape(999.dp),
            ) {
                Text(
                    text = "Активное ядро · ${state.dashboard.activeCore}",
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                    color = WebPanelPalette.TextBlue,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 10.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            entries.forEach { entry ->
                val selected = entry.section == state.workspaceSection
                NavigationDrawerItem(
                    label = {
                        Text(
                            text = entry.section.title,
                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                        )
                    },
                    selected = selected,
                    onClick = { onSectionSelected(entry.section) },
                    icon = { Icon(entry.icon, contentDescription = null) },
                    colors = NavigationDrawerItemDefaults.colors(
                        selectedContainerColor = DrawerSelection,
                        selectedIconColor = WebPanelPalette.TextStrong,
                        selectedTextColor = WebPanelPalette.TextStrong,
                        unselectedIconColor = WebPanelPalette.Muted,
                        unselectedTextColor = WebPanelPalette.Text,
                    ),
                    shape = RoundedCornerShape(10.dp),
                )
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 10.dp))
            NavigationDrawerItem(
                label = { Text("Core · ${state.dashboard.activeCore}", fontWeight = FontWeight.Bold) },
                selected = false,
                onClick = onCore,
                icon = { Icon(Icons.Outlined.Memory, contentDescription = null) },
                badge = { Text("Сменить") },
                shape = RoundedCornerShape(10.dp),
            )
            NavigationDrawerItem(
                label = { Text("Подключения") },
                selected = false,
                onClick = onConnections,
                icon = { Icon(Icons.Outlined.Devices, contentDescription = null) },
                shape = RoundedCornerShape(10.dp),
            )
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Outlined.ExitToApp,
                contentDescription = null,
                tint = WebPanelPalette.Muted,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = state.dashboard.endpoint,
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
internal fun WorkspaceSectionContent(
    state: CompanionUiState,
    controller: DemoCompanionController,
    modifier: Modifier = Modifier,
) {
    when (state.workspaceSection) {
        WorkspaceSection.XrayRouting -> RoutingWorkspaceScreen(state, controller, modifier)
        WorkspaceSection.ShellCommands,
        WorkspaceSection.ShellTerminal,
        -> ShellWorkspaceScreen(state, modifier)

        else -> ModulePlaceholderScreen(
            title = state.workspaceSection.title,
            subtitle = workspaceSectionDescription(state.workspaceSection),
            modifier = modifier,
        )
    }
}

@Composable
private fun CoreSelectionDialog(
    activeCore: String,
    availableCores: List<String>,
    onDismiss: () -> Unit,
    onApply: (String) -> Unit,
) {
    val available = remember(availableCores) { availableCores.distinctBy(String::lowercase) }
    val initialSelection = available.firstOrNull { it.equals(activeCore, ignoreCase = true) }
        ?: available.firstOrNull().orEmpty()
    var selectedCore by remember(activeCore, available) { mutableStateOf(initialSelection) }
    val canApply = selectedCore.isNotBlank() && !selectedCore.equals(activeCore, ignoreCase = true)

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.92f)
                .widthIn(max = 430.dp),
            color = Color(0xFF060E1E),
            shape = RoundedCornerShape(22.dp),
            tonalElevation = 8.dp,
            shadowElevation = 18.dp,
        ) {
            Column(modifier = Modifier.padding(18.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Surface(
                        color = Color(0xFF0D2340),
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Memory,
                            contentDescription = null,
                            tint = WebPanelPalette.Border,
                            modifier = Modifier.padding(9.dp),
                        )
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "XKEEN ENGINE",
                            color = Color(0xFF93C5FD),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 0.7.sp,
                        )
                        Text(
                            text = "Управление ядром",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }

                HorizontalDivider(modifier = Modifier.padding(vertical = 16.dp))
                Text(
                    text = "RESTART ON APPLY",
                    modifier = Modifier
                        .align(Alignment.End)
                        .background(WebPanelPalette.Surface, RoundedCornerShape(999.dp))
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                    color = WebPanelPalette.Muted,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.size(12.dp))

                available.forEach { core ->
                    CoreEngineRow(
                        name = core,
                        selected = core.equals(selectedCore, ignoreCase = true),
                        current = core.equals(activeCore, ignoreCase = true),
                        onClick = { selectedCore = core },
                    )
                    Spacer(Modifier.size(9.dp))
                }

                if (available.isEmpty()) {
                    Text(
                        text = "Доступные ядра не найдены.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    Text(
                        text = if (canApply) {
                            "После применения xkeen перезапустится с ядром $selectedCore."
                        } else {
                            "Сейчас активно ядро $activeCore. Выберите другой вариант для переключения."
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(WebPanelPalette.Surface, RoundedCornerShape(12.dp))
                            .padding(12.dp),
                        color = WebPanelPalette.Muted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                HorizontalDivider(modifier = Modifier.padding(vertical = 16.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedButton(onClick = onDismiss) {
                        Text("Отмена")
                    }
                    Spacer(Modifier.size(10.dp))
                    Button(
                        onClick = { onApply(selectedCore) },
                        enabled = canApply,
                        colors = ButtonDefaults.buttonColors(containerColor = CoreBlue),
                    ) {
                        Text("Применить")
                    }
                }
            }
        }
    }
}

@Composable
private fun CoreEngineRow(
    name: String,
    selected: Boolean,
    current: Boolean,
    onClick: () -> Unit,
) {
    val container = if (selected) CoreBlue else WebPanelPalette.Surface
    val content = if (selected) WebPanelPalette.TextStrong else WebPanelPalette.Text

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(container, RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 17.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(18.dp)
                .background(Color.Transparent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(if (selected) 10.dp else 8.dp)
                    .background(
                        color = if (selected) Color(0xFFBFDBFE) else WebPanelPalette.Muted,
                        shape = CircleShape,
                    ),
            )
        }
        Spacer(Modifier.size(10.dp))
        Text(
            text = name,
            modifier = Modifier.weight(1f),
            color = content,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = if (current) "Активно" else "Доступно",
            color = if (selected) Color(0xFFDBEAFE) else WebPanelPalette.Muted,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
        )
    }
}

private fun drawerContextTitle(tab: MainTab): String =
    when (tab) {
        MainTab.Routing -> "Xray"
        MainTab.Home -> "Mihomo"
        MainTab.Logs -> "Ports"
        MainTab.More -> "Shell"
        MainTab.Generator -> "Generator"
    }

private fun drawerEntries(tab: MainTab): List<WorkspaceDrawerEntry> =
    when (tab) {
        MainTab.Routing -> listOf(
            WorkspaceDrawerEntry(WorkspaceSection.XrayRouting, Icons.Outlined.AccountTree),
            WorkspaceDrawerEntry(WorkspaceSection.XraySubscriptions, Icons.Outlined.Subscriptions),
            WorkspaceDrawerEntry(WorkspaceSection.XrayInbounds, Icons.Outlined.SettingsInputComponent),
            WorkspaceDrawerEntry(WorkspaceSection.XrayOutbounds, Icons.Outlined.Hub),
            WorkspaceDrawerEntry(WorkspaceSection.XrayAssets, Icons.Outlined.CloudDownload),
            WorkspaceDrawerEntry(WorkspaceSection.XrayLogs, Icons.AutoMirrored.Outlined.ReceiptLong),
        )

        MainTab.Home -> listOf(
            WorkspaceDrawerEntry(WorkspaceSection.MihomoRouting, Icons.Outlined.AccountTree),
            WorkspaceDrawerEntry(WorkspaceSection.MihomoProfiles, Icons.Outlined.Folder),
            WorkspaceDrawerEntry(WorkspaceSection.MihomoProviders, Icons.Outlined.Dns),
            WorkspaceDrawerEntry(WorkspaceSection.MihomoGroups, Icons.Outlined.Hub),
            WorkspaceDrawerEntry(WorkspaceSection.MihomoRules, Icons.AutoMirrored.Outlined.Rule),
            WorkspaceDrawerEntry(WorkspaceSection.MihomoGenerator, Icons.Outlined.AutoAwesome),
        )

        MainTab.Logs -> listOf(
            WorkspaceDrawerEntry(WorkspaceSection.PortsOverview, Icons.Outlined.Lan),
            WorkspaceDrawerEntry(WorkspaceSection.PortsXray, Icons.Outlined.DataObject),
            WorkspaceDrawerEntry(WorkspaceSection.PortsMihomo, Icons.Outlined.SwapHoriz),
            WorkspaceDrawerEntry(WorkspaceSection.RoutingExclusions, Icons.Outlined.Tune),
        )

        MainTab.More -> listOf(
            WorkspaceDrawerEntry(WorkspaceSection.ShellCommands, Icons.AutoMirrored.Outlined.List),
            WorkspaceDrawerEntry(WorkspaceSection.ShellTerminal, Icons.Outlined.Terminal),
            WorkspaceDrawerEntry(WorkspaceSection.ShellHistory, Icons.Outlined.History),
        )

        MainTab.Generator -> listOf(
            WorkspaceDrawerEntry(WorkspaceSection.MihomoGenerator, Icons.Outlined.AutoAwesome),
            WorkspaceDrawerEntry(WorkspaceSection.GeneratorProfiles, Icons.Outlined.Folder),
            WorkspaceDrawerEntry(WorkspaceSection.GeneratorTemplates, Icons.AutoMirrored.Outlined.Article),
        )
    }

private fun workspaceSectionDescription(section: WorkspaceSection): String =
    when (section) {
        WorkspaceSection.XraySubscriptions -> "Управление подписками, обновлением узлов и профилями Xray."
        WorkspaceSection.XrayInbounds -> "Переключение Redirect, TProxy и Mixed с применением конфигурации."
        WorkspaceSection.XrayOutbounds -> "Прокси-ссылки, пулы, балансировщики и исходящие подключения Xray."
        WorkspaceSection.XrayAssets -> "Обновление и проверка GeoIP, GeoSite и других DAT-файлов."
        WorkspaceSection.XrayLogs -> "Онлайн-логи access и error для активного ядра Xray."
        WorkspaceSection.MihomoRouting -> "Редактор активного routing-профиля Mihomo."
        WorkspaceSection.MihomoProfiles -> "Профили, подписки, активация и резервные копии Mihomo."
        WorkspaceSection.MihomoProviders -> "Управление proxy-providers и обновлением источников."
        WorkspaceSection.MihomoGroups -> "Группы прокси, стратегии выбора и проверки доступности."
        WorkspaceSection.MihomoRules -> "Правила, rule-providers и порядок маршрутизации Mihomo."
        WorkspaceSection.PortsOverview -> "Общие порты xkeen и исключения для локальной сети."
        WorkspaceSection.PortsXray -> "Inbounds и системные порты конфигурации Xray."
        WorkspaceSection.PortsMihomo -> "Порты контроллера и входящих подключений Mihomo."
        WorkspaceSection.RoutingExclusions -> "Адреса и сети, которые должны обходить прокси."
        WorkspaceSection.ShellHistory -> "Недавние команды и повторный запуск сохранённых операций."
        WorkspaceSection.MihomoGenerator -> "Мастер сборки конфигурации Mihomo из профиля и шаблона."
        WorkspaceSection.GeneratorProfiles -> "Сохранённые исходные профили генератора."
        WorkspaceSection.GeneratorTemplates -> "Шаблоны секций и параметры итоговой конфигурации."
        WorkspaceSection.XrayRouting,
        WorkspaceSection.ShellCommands,
        WorkspaceSection.ShellTerminal,
        -> ""
    }
