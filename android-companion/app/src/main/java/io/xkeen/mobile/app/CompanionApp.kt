package io.xkeen.mobile.app

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.FactCheck
import androidx.compose.material.icons.automirrored.outlined.Subject
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Http
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lan
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Password
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Preview
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.ReportProblem
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SettingsBackupRestore
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.xkeen.mobile.ui.theme.XkeenMobileTheme
import io.xkeen.mobile.ui.theme.WebPanelPalette
import kotlinx.coroutines.delay

@Composable
fun CompanionApp() {
    val applicationContext = LocalContext.current.applicationContext
    val controller = remember(applicationContext) {
        CompanionController(
            dependencies = defaultCompanionControllerDependencies(
                connections = persistedConnectionsPort(applicationContext),
                sessionMaterials = secureSessionMaterialStore(applicationContext),
            ),
        )
    }
    val state = controller.state

    XkeenMobileTheme(darkTheme = true) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
        ) {
            when (state.phase) {
                AppPhase.Launching -> LaunchRoute(controller)
                AppPhase.Connections -> ConnectionsRoute(state, controller)
                AppPhase.PairLogin -> PairLoginRoute(state, controller)
                AppPhase.Ready -> ReadyRoute(state, controller)
            }
        }
    }
}

@Composable
private fun LaunchRoute(controller: CompanionController) {
    LaunchedEffect(Unit) {
        delay(1100)
        controller.finishLaunch()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .windowInsetsPadding(WindowInsets.safeDrawing),
        contentAlignment = Alignment.Center,
    ) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
            shape = RoundedCornerShape(24.dp),
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 22.dp, vertical = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                horizontalAlignment = Alignment.Start,
            ) {
                Surface(
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.secondaryContainer,
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Bolt,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier.padding(12.dp),
                    )
                }
                Text(
                    text = "Xkeen Mobile",
                    style = MaterialTheme.typography.headlineSmall,
                )
                Text(
                    text = "Загружаем сохраненные подключения и подготавливаем данные клиента.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    Text(
                        text = "Читаем локальный snapshot подключений",
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }
    }
}

@Composable
private fun ConnectionsRoute(
    state: CompanionUiState,
    controller: CompanionController,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TitleBlock(
            eyebrow = "Подключения",
            title = "Доверенные узлы",
            subtitle = "Сначала добавьте адрес вручную, затем выполните сопряжение или вход.",
        )

        SectionCard(
            title = if (state.connectionDraft.isEditing) "Редактировать узел" else "Добавить узел",
            supporting = "Имя, адрес и состояние узла сохраняются локально. Данные входа будут храниться отдельно.",
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CompactField(
                    modifier = Modifier.weight(1f),
                    value = state.connectionDraft.name,
                    onValueChange = controller::updateConnectionDraftName,
                    label = "Имя",
                    labelMode = CompactFieldLabelMode.Above,
                    leadingIcon = { Icon(Icons.Outlined.Lan, contentDescription = null) },
                )
                CompactField(
                    modifier = Modifier.weight(1f),
                    value = state.connectionDraft.baseUrl,
                    onValueChange = controller::updateConnectionDraftUrl,
                    label = "URL",
                    labelMode = CompactFieldLabelMode.Above,
                    leadingIcon = { Icon(Icons.Outlined.Http, contentDescription = null) },
                    keyboardType = KeyboardType.Uri,
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
            ) {
                if (state.connectionDraft.isEditing) {
                    CompactActionButton(
                        label = "Отмена",
                        onClick = controller::cancelConnectionEdit,
                        style = CompactButtonStyle.Outlined,
                    )
                }
                CompactActionButton(
                    label = if (state.connectionDraft.isEditing) "Сохранить изменения" else "Сохранить",
                    icon = Icons.Outlined.Save,
                    onClick = controller::saveConnectionDraft,
                    enabled = state.connectionDraft.canBeSaved(),
                )
            }
        }

        SectionCard(
            title = "Сохраненные подключения",
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.connections.isEmpty()) {
                    Text(
                        text = "Сохраненных узлов пока нет.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                state.connections.forEach { connection ->
                    ConnectionCard(
                        connection = connection,
                        isSelected = connection.id == state.selectedConnectionId,
                        onOpen = { controller.selectConnection(connection.id) },
                        onEdit = { controller.editConnection(connection.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun PairLoginRoute(
    state: CompanionUiState,
    controller: CompanionController,
) {
    val connection = state.connections.firstOrNull { it.id == state.selectedConnectionId }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = controller::backToConnections) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Назад")
            }
            Spacer(Modifier.width(4.dp))
            Column {
                Text(
                    text = connection?.name ?: "Выбранный узел",
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    text = connection?.baseUrl ?: "",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        SectionCard(
            title = "Авторизация",
        ) {
            CompactStatusRow(
                items = listOf(
                    connectionStatusChip(connection?.status ?: ConnectionStatus.NeedsAuth),
                ),
            )
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CompactField(
                    modifier = Modifier.weight(1f),
                    value = state.loginForm.username,
                    onValueChange = controller::updateUsername,
                    label = "Логин",
                    labelMode = CompactFieldLabelMode.Above,
                    leadingIcon = { Icon(Icons.Outlined.Key, contentDescription = null) },
                )
                CompactField(
                    modifier = Modifier.weight(1f),
                    value = state.loginForm.password,
                    onValueChange = controller::updatePassword,
                    label = "Пароль",
                    labelMode = CompactFieldLabelMode.Above,
                    leadingIcon = { Icon(Icons.Outlined.Password, contentDescription = null) },
                    visualTransformation = PasswordVisualTransformation(),
                )
            }
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CompactActionButton(
                    label = "Демо-сопряжение",
                    icon = Icons.Outlined.VpnKey,
                    onClick = controller::pairDemoDevice,
                    modifier = Modifier.weight(1f),
                )
                CompactActionButton(
                    label = "Войти",
                    icon = Icons.Outlined.Verified,
                    onClick = controller::login,
                    modifier = Modifier.weight(1f),
                    style = CompactButtonStyle.Outlined,
                )
            }
        }

        SectionCard(
            title = "Доступные разделы",
        ) {
            CompactStatusRow(
                items = listOf(
                    statusChip("Сводка"),
                    statusChip("Маршруты Xray"),
                    statusChip("Логи"),
                    statusChip("Еще"),
                ),
            )
        }
    }
}

@Composable
private fun ReadyRoute(
    state: CompanionUiState,
    controller: CompanionController,
) {
    val density = LocalDensity.current
    val isImeVisible = WindowInsets.ime.getBottom(density) > 0

    LaunchedEffect(state.dashboard.endpoint) {
        controller.refreshCoreStatus()
    }
    WorkspaceNavigationFrame(state, controller) { openDrawer, openCoreDialog ->
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            topBar = {
                WorkspaceHeader(
                    state = state,
                    onMenu = openDrawer,
                    onCore = openCoreDialog,
                    onServiceAction = controller::requestServiceAction,
                )
            },
            bottomBar = {
                if (!isImeVisible) {
                    ReadyBottomBar(
                        selected = state.mainTab,
                        availableCores = state.dashboard.availableCores,
                        onSelected = controller::selectTab,
                    )
                }
            },
        ) { innerPadding ->
            WorkspaceSectionContent(
                state = state,
                controller = controller,
                modifier = Modifier.padding(innerPadding),
            )

            PendingActionDialog(
                pendingAction = state.pendingAction,
                onDismiss = controller::dismissPendingAction,
                onConfirm = controller::confirmPendingAction,
            )
        }
    }
}

@Composable
private fun WorkspaceHeader(
    state: CompanionUiState,
    onMenu: () -> Unit,
    onCore: () -> Unit,
    onServiceAction: (ServiceAction) -> Unit,
) {
    Surface(color = Color.Transparent, shadowElevation = 8.dp) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(
                        listOf(
                            WebPanelPalette.Panel,
                            WebPanelPalette.BackgroundDeep,
                        ),
                    ),
                )
                .windowInsetsPadding(WindowInsets.statusBars)
                .height(56.dp)
                .padding(horizontal = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            GlassMenuButton(onClick = onMenu)
            Spacer(Modifier.width(6.dp))
            CoreGlassButton(
                activeCore = state.dashboard.activeCore,
                onClick = onCore,
            )
            Spacer(Modifier.weight(1f))
            Spacer(Modifier.width(5.dp))
            ServiceHeaderButton(
                label = "Start",
                color = WebPanelPalette.Success,
                onClick = { onServiceAction(ServiceAction.Start) },
            )
            Spacer(Modifier.width(4.dp))
            ServiceHeaderButton(
                label = "Stop",
                color = WebPanelPalette.Error,
                onClick = { onServiceAction(ServiceAction.Stop) },
            )
            Spacer(Modifier.width(4.dp))
            ServiceHeaderButton(
                label = "Restart",
                color = WebPanelPalette.Warning,
                onClick = { onServiceAction(ServiceAction.Restart) },
            )
        }
    }
}

@Composable
private fun GlassMenuButton(onClick: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Box(
        modifier = Modifier
            .size(36.dp)
            .shadow(4.dp, shape)
            .background(
                brush = Brush.verticalGradient(
                    listOf(WebPanelPalette.SurfaceRaised, WebPanelPalette.Surface),
                ),
                shape = shape,
            )
            .border(
                width = 1.dp,
                brush = Brush.linearGradient(
                    listOf(
                        Color.White.copy(alpha = 0.10f),
                        WebPanelPalette.Border.copy(alpha = 0.34f),
                    ),
                ),
                shape = shape,
            )
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Outlined.Menu,
            contentDescription = "Открыть меню раздела",
            tint = WebPanelPalette.TextBlue,
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
private fun CoreGlassButton(
    activeCore: String,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    Row(
        modifier = Modifier
            .height(34.dp)
            .shadow(3.dp, shape)
            .background(
                brush = Brush.horizontalGradient(
                    listOf(
                        WebPanelPalette.Surface.copy(alpha = 0.92f),
                        Color(0xFF081436),
                    ),
                ),
                shape = shape,
            )
            .border(1.dp, WebPanelPalette.Border.copy(alpha = 0.32f), shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = Icons.Outlined.Memory,
            contentDescription = null,
            tint = WebPanelPalette.Border,
            modifier = Modifier.size(17.dp),
        )
        Text(
            text = activeCore,
            color = WebPanelPalette.TextStrong,
            fontSize = 12.sp,
            fontWeight = FontWeight.ExtraBold,
            lineHeight = 14.sp,
            maxLines = 1,
        )
    }
}

@Composable
private fun ServiceHeaderButton(
    label: String,
    color: Color,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(11.dp)
    Row(
        modifier = Modifier
            .height(30.dp)
            .shadow(3.dp, shape)
            .background(
                brush = Brush.verticalGradient(
                    listOf(
                        color.copy(alpha = 0.18f),
                        WebPanelPalette.Surface.copy(alpha = 0.96f),
                    ),
                ),
                shape = shape,
            )
            .border(
                width = 1.dp,
                brush = Brush.linearGradient(
                    listOf(
                        Color.White.copy(alpha = 0.10f),
                        color.copy(alpha = 0.58f),
                        WebPanelPalette.Border.copy(alpha = 0.12f),
                    ),
                ),
                shape = shape,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            modifier = Modifier
                .size(5.dp)
                .background(color, CircleShape),
        )
        Text(
            text = label,
            color = color,
            fontWeight = FontWeight.ExtraBold,
            fontSize = 11.sp,
            maxLines = 1,
        )
    }
}

@Composable
private fun ReadyBottomBar(
    selected: MainTab,
    availableCores: List<String>,
    onSelected: (MainTab) -> Unit,
) {
    Surface(color = Color.Transparent, shadowElevation = 12.dp) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(
                        listOf(
                            WebPanelPalette.BackgroundDeep.copy(alpha = 0.98f),
                            WebPanelPalette.Background,
                        ),
                    ),
                )
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(horizontal = 6.dp, vertical = 4.dp),
        ) {
            val panelShape = RoundedCornerShape(16.dp)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp)
                    .shadow(6.dp, panelShape)
                    .background(
                        brush = Brush.linearGradient(
                            listOf(
                                WebPanelPalette.Surface.copy(alpha = 0.96f),
                                Color(0xFF081436),
                                WebPanelPalette.Surface.copy(alpha = 0.94f),
                            ),
                        ),
                        shape = panelShape,
                    )
                    .border(
                        width = 1.dp,
                        brush = Brush.linearGradient(
                            listOf(
                                Color.White.copy(alpha = 0.10f),
                                WebPanelPalette.Border.copy(alpha = 0.28f),
                                WebPanelPalette.Border.copy(alpha = 0.12f),
                            ),
                        ),
                        shape = panelShape,
                    )
                    .padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                if (availableCores.hasCore("xray")) {
                    WorkspaceTab(MainTab.Routing, selected, onSelected, "Xray")
                }
                if (availableCores.hasCore("mihomo")) {
                    WorkspaceTab(MainTab.Home, selected, onSelected, "Mihomo")
                }
                WorkspaceTab(MainTab.Logs, selected, onSelected, "Ports")
                WorkspaceTab(MainTab.More, selected, onSelected, "Shell")
                if (availableCores.hasCore("mihomo")) {
                    WorkspaceTab(MainTab.Generator, selected, onSelected, "Generator")
                }
            }
        }
    }
}

@Composable
private fun RowScope.WorkspaceTab(
    tab: MainTab,
    selected: MainTab,
    onSelected: (MainTab) -> Unit,
    label: String,
) {
    val isSelected = tab == selected
    val shape = RoundedCornerShape(11.dp)
    val tabBackground = if (isSelected) {
        Brush.linearGradient(
            listOf(
                WebPanelPalette.AccentDeep,
                WebPanelPalette.AccentMiddle,
                WebPanelPalette.AccentLight,
            ),
        )
    } else {
        Brush.verticalGradient(
            listOf(
                WebPanelPalette.Surface.copy(alpha = 0.78f),
                WebPanelPalette.BackgroundDeep.copy(alpha = 0.92f),
            ),
        )
    }
    val border = if (isSelected) {
        Brush.linearGradient(
            listOf(
                Color.White.copy(alpha = 0.22f),
                WebPanelPalette.Border.copy(alpha = 0.52f),
                Color(0xFF91B4FF).copy(alpha = 0.44f),
            ),
        )
    } else {
        Brush.linearGradient(
            listOf(
                Color.White.copy(alpha = 0.07f),
                WebPanelPalette.Border.copy(alpha = 0.20f),
            ),
        )
    }
    Box(
        modifier = Modifier
            .weight(if (tab == MainTab.Generator) 1.35f else 1f)
            .fillMaxHeight()
            .then(if (isSelected) Modifier.shadow(5.dp, shape) else Modifier)
            .background(tabBackground, shape)
            .border(1.dp, border, shape)
            .clickable { onSelected(tab) },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = label,
                color = if (isSelected) WebPanelPalette.TextStrong else WebPanelPalette.TextBlue,
                fontWeight = FontWeight.ExtraBold,
                fontSize = 11.sp,
                maxLines = 1,
            )
            Spacer(Modifier.height(1.dp))
            Box(
                modifier = Modifier
                    .width(if (isSelected) 18.dp else 5.dp)
                    .height(2.dp)
                    .background(
                        color = if (isSelected) Color(0xFFBFDBFE) else WebPanelPalette.MutedDeep,
                        shape = CircleShape,
                    ),
            )
        }
    }
}

@Composable
private fun DashboardScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SectionCard(
            title = "Сводка узла",
            supporting = state.dashboard.endpoint,
        ) {
            CompactStatusRow(
                items = buildList {
                    add(serviceStateChip(state.dashboard.serviceState))
                    add(statusChip(state.dashboard.activeCore))
                    state.dashboard.capabilities.forEach { capability ->
                        add(statusChip(capabilityLabel(capability)))
                    }
                },
            )
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(IntrinsicSize.Min),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                MetricCard("Версия", state.dashboard.version, Modifier.weight(1f).fillMaxHeight())
                MetricCard("Последнее действие", state.dashboard.lastOperation, Modifier.weight(1f).fillMaxHeight())
            }
            state.dashboard.lastError?.let { error ->
                Spacer(Modifier.height(8.dp))
                WarningBanner(error)
            }
            Spacer(Modifier.height(8.dp))
            ActionGrid(
                columns = 3,
                actions = listOf(
                    GridAction(
                        label = ServiceAction.Start.label,
                        icon = Icons.Outlined.PlayArrow,
                        tone = if (state.dashboard.serviceState == ServiceState.Stopped) ActionTone.Accent else ActionTone.Neutral,
                        onClick = { controller.requestServiceAction(ServiceAction.Start) },
                    ),
                    GridAction(
                        label = ServiceAction.Stop.label,
                        icon = Icons.Outlined.Stop,
                        tone = if (state.dashboard.serviceState == ServiceState.Running) ActionTone.Accent else ActionTone.Neutral,
                        onClick = { controller.requestServiceAction(ServiceAction.Stop) },
                    ),
                    GridAction(
                        label = ServiceAction.Restart.label,
                        icon = Icons.Outlined.Refresh,
                        onClick = { controller.requestServiceAction(ServiceAction.Restart) },
                    ),
                ),
            )
        }

        SectionCard(
            title = "Последние события",
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.dashboard.recentEvents.forEach { event ->
                    EventRow(event)
                }
            }
        }
    }
}

@Composable
private fun RoutingScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val routing = state.routing
    val selectedDocument = routing.documents.firstOrNull { it.id == routing.selectedDocumentId } ?: return
    val filteredDocuments = routing.documents.filter { document ->
        routing.searchQuery.isBlank() ||
            document.title.contains(routing.searchQuery, ignoreCase = true) ||
            document.path.contains(routing.searchQuery, ignoreCase = true)
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SectionCard(
            title = "Маршруты Xray",
            supporting = "Конфигов: ${filteredDocuments.size}",
        ) {
            CompactField(
                value = routing.searchQuery,
                onValueChange = controller::updateRoutingSearchQuery,
                label = "Поиск конфигов",
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                filteredDocuments.forEach { document ->
                    FilterChip(
                        selected = document.id == selectedDocument.id,
                        onClick = { controller.selectRoutingDocument(document.id) },
                        label = { Text(document.title) },
                    )
                }
            }
        }

        SectionCard(
            title = selectedDocument.title,
            supporting = selectedDocument.path,
        ) {
            CompactStatusRow(
                items = listOf(
                    statusChip("r${selectedDocument.revision}"),
                    statusChip(if (selectedDocument.hasDraftChanges) "черновик изменен" else "опубликовано"),
                    statusChip(if (selectedDocument.hasUnsavedChanges) "не сохранено" else "сохранено"),
                    statusChip(if (routing.mode == RoutingMode.Read) "чтение" else "редактирование"),
                ),
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = selectedDocument.summary,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            ActionGrid(
                columns = 3,
                actions = listOf(
                    GridAction("Править", Icons.Outlined.Edit, onClick = controller::enterRoutingEditMode),
                    GridAction("Проверить", Icons.AutoMirrored.Outlined.FactCheck, onClick = controller::validateRouting),
                    GridAction("Превью", Icons.Outlined.Preview, onClick = controller::previewRouting),
                    GridAction(
                        label = "Сохранить",
                        icon = Icons.Outlined.Save,
                        tone = if (selectedDocument.hasUnsavedChanges) ActionTone.Accent else ActionTone.Neutral,
                        onClick = controller::saveRouting,
                    ),
                    GridAction(
                        label = "Применить",
                        icon = Icons.Outlined.DoneAll,
                        tone = if (selectedDocument.hasDraftChanges) ActionTone.Accent else ActionTone.Neutral,
                        onClick = controller::requestRoutingApply,
                    ),
                    GridAction("Откатить", Icons.Outlined.SettingsBackupRestore, onClick = controller::revertRoutingDraft),
                ),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = selectedDocument.draftContent,
                onValueChange = controller::updateRoutingDraft,
                readOnly = routing.mode == RoutingMode.Read,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 188.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                label = {
                    Text(
                        if (routing.mode == RoutingMode.Read) {
                            "Опубликованная версия или сохраненный черновик"
                        } else {
                            "Редактор черновика"
                        },
                    )
                },
            )
        }

        SectionCard(
            title = "Проверка",
            supporting = routing.validation.message,
        ) {
            CompactStatusRow(
                items = listOf(validationChip(routing.validation.state)),
            )
            if (routing.validation.details.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    routing.validation.details.forEach { detail ->
                        Text(
                            text = "• $detail",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        routing.preview?.let { preview ->
            SectionCard(
                title = "Превью",
                supporting = preview.headline,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    preview.details.forEach { detail ->
                        Text(
                            text = "• $detail",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun LogsScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    val filteredEntries = state.logs.entries.filter { entry ->
        when (state.logs.filter) {
            LogFilter.All -> true
            LogFilter.Service -> entry.source == "service"
            LogFilter.Routing -> entry.source == "routing"
            LogFilter.Errors -> entry.level == LogLevel.Error
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SectionCard(
            title = "Живые логи",
        ) {
            CompactStatusRow(
                items = listOf(
                    statusChip("история + поток"),
                    statusChip("готово к переподключению"),
                    statusChip("фильтр по источнику"),
                ),
            )
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                LogFilter.entries.forEach { filter ->
                    FilterChip(
                        selected = filter == state.logs.filter,
                        onClick = { controller.updateLogFilter(filter) },
                        label = { Text(logFilterLabel(filter)) },
                    )
                }
            }
        }

        SectionCard(
            title = "Последние записи",
            supporting = "В текущем фильтре видно: ${filteredEntries.size}",
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                filteredEntries.forEach { entry ->
                    LogRow(entry)
                }
            }
        }
    }
}

@Composable
private fun MoreScreen(
    state: CompanionUiState,
    controller: CompanionController,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SectionCard(
            title = "Диагностика",
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.diagnostics.forEach { item ->
                    DiagnosticRow(item)
                }
            }
        }

        SectionCard(
            title = "Подключения",
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.connections.forEach { connection ->
                    ConnectionMiniRow(connection)
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                CompactActionButton(
                    label = "Отключить",
                    icon = Icons.AutoMirrored.Outlined.ArrowBack,
                    onClick = controller::disconnect,
                    style = CompactButtonStyle.Outlined,
                )
            }
        }

        SectionCard(
            title = "О сборке",
        ) {
            CompactStatusRow(
                items = listOf(
                    statusChip("Compose-оболочка"),
                    statusChip("Демо-состояние"),
                    statusChip("Тестовый бэкенд"),
                ),
            )
        }
    }
}

@Composable
private fun PendingActionDialog(
    pendingAction: PendingAction?,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val focusManager = LocalFocusManager.current
    val dialog = when (pendingAction) {
        is PendingAction.Service -> when (pendingAction.action) {
            ServiceAction.Start -> DialogModel("Запустить сервис?", "Подтвердите запрос на запуск из мобильного клиента.")
            ServiceAction.Stop -> DialogModel("Остановить сервис?", "Подтвердите запрос на остановку из мобильного клиента.")
            ServiceAction.Restart -> DialogModel("Перезапустить среду?", "Подтвердите запрос на перезапуск из мобильного клиента.")
        }

        PendingAction.ApplyRouting -> DialogModel(
            title = "Применить черновик маршрутов?",
            body = "Черновик уже проверен и сохранен. Подтвердите публикацию текущей ревизии маршрутов.",
        )

        null -> null
    }

    dialog ?: return

    LaunchedEffect(dialog) {
        focusManager.clearFocus(force = true)
    }

    XkeenDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Icon(
                        imageVector = Icons.Outlined.ReportProblem,
                        contentDescription = null,
                        tint = WebPanelPalette.Border,
                        modifier = Modifier.padding(10.dp),
                    )
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "ПОДТВЕРЖДЕНИЕ",
                        color = WebPanelPalette.Border,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 0.7.sp,
                    )
                    Text(
                        text = dialog.title,
                        color = WebPanelPalette.TextStrong,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            Text(
                text = dialog.body,
                color = WebPanelPalette.Muted,
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedButton(onClick = onDismiss) {
                    Text("Отмена")
                }
                Spacer(Modifier.width(10.dp))
                Button(
                    onClick = onConfirm,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = WebPanelPalette.Accent,
                        contentColor = WebPanelPalette.TextStrong,
                    ),
                ) {
                    Text("Подтвердить")
                }
            }
        }
    }
}

@Composable
private fun ConnectionCard(
    connection: Connection,
    isSelected: Boolean,
    onOpen: () -> Unit,
    onEdit: () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
        shape = RoundedCornerShape(18.dp),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(connection.name, style = MaterialTheme.typography.titleMedium)
                    Text(
                        text = connection.baseUrl,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onEdit) {
                        Icon(Icons.Outlined.Edit, contentDescription = "Редактировать ${connection.name}")
                    }
                    CompactActionButton(
                        label = "Открыть",
                        onClick = onOpen,
                    )
                }
            }
            CompactStatusRow(
                items = buildList {
                    if (isSelected) {
                        add(statusChip("Последний выбранный"))
                    }
                    add(connectionStatusChip(connection.status))
                    add(statusChip(connection.lastSeen))
                },
            )
        }
    }
}

@Composable
private fun ConnectionMiniRow(connection: Connection) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(connection.name, style = MaterialTheme.typography.titleSmall)
            Text(
                text = connection.baseUrl,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        StatusChip(connectionStatusChip(connection.status))
    }
}

@Composable
private fun EventRow(event: RecentEvent) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Surface(
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.secondaryContainer,
        ) {
            Text(
                text = event.time,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(event.title, style = MaterialTheme.typography.titleSmall)
            Text(
                text = event.subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun MetricCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        tonalElevation = 1.dp,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(
            modifier = Modifier
                .fillMaxHeight()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(text = value, style = MaterialTheme.typography.titleSmall)
        }
    }
}

@Composable
private fun LogRow(entry: LogEntry) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusChip(logLevelChip(entry.level))
                Text(logSourceLabel(entry.source), style = MaterialTheme.typography.labelMedium)
                Text(
                    entry.time,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(entry.message, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun DiagnosticRow(item: DiagnosticItem) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(item.label, style = MaterialTheme.typography.titleSmall)
            Text(
                text = item.status,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        StatusChip(diagnosticSeverityChip(item.severity))
    }
}

@Composable
private fun WarningBanner(message: String) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.errorContainer,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Outlined.ReportProblem,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
        }
    }
}

@Composable
private fun SectionCard(
    title: String,
    supporting: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
        ) {
            Text(text = title, style = MaterialTheme.typography.titleLarge)
            if (!supporting.isNullOrBlank()) {
                Spacer(Modifier.height(3.dp))
                Text(
                    text = supporting,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(10.dp))
            content()
        }
    }
}

@Composable
private fun TitleBlock(
    eyebrow: String,
    title: String,
    subtitle: String,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = eyebrow.uppercase(),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            text = title,
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = subtitle,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun CompactField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    labelMode: CompactFieldLabelMode = CompactFieldLabelMode.Floating,
    leadingIcon: @Composable (() -> Unit)? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    visualTransformation: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
) {
    val field: @Composable (Modifier, @Composable (() -> Unit)?) -> Unit = { fieldModifier, labelContent ->
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = fieldModifier.height(52.dp),
            label = labelContent,
            leadingIcon = leadingIcon,
            shape = RoundedCornerShape(14.dp),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            visualTransformation = visualTransformation,
            textStyle = MaterialTheme.typography.bodyMedium,
            singleLine = true,
        )
    }

    when (labelMode) {
        CompactFieldLabelMode.Floating -> field(
            modifier,
            {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelMedium,
                )
            },
        )

        CompactFieldLabelMode.Above -> Column(
            modifier = modifier,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            field(Modifier.fillMaxWidth(), null)
        }
    }
}

private enum class ActionTone {
    Neutral,
    Accent,
}

private enum class CompactFieldLabelMode {
    Floating,
    Above,
}

private enum class CompactButtonStyle {
    Tonal,
    Outlined,
}

private data class GridAction(
    val label: String,
    val icon: ImageVector,
    val onClick: () -> Unit,
    val tone: ActionTone = ActionTone.Neutral,
)

@Composable
private fun ActionGrid(
    actions: List<GridAction>,
    columns: Int,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        actions.chunked(columns).forEach { rowActions ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                rowActions.forEach { action ->
                    ActionGridButton(
                        action = action,
                        modifier = Modifier.weight(1f),
                    )
                }
                repeat(columns - rowActions.size) {
                    Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun CompactActionButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    style: CompactButtonStyle = CompactButtonStyle.Tonal,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(14.dp)
    val content: @Composable RowScope.() -> Unit = {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }

    when (style) {
        CompactButtonStyle.Tonal -> FilledTonalButton(
            onClick = onClick,
            enabled = enabled,
            modifier = modifier.height(44.dp),
            shape = shape,
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
            content = content,
        )

        CompactButtonStyle.Outlined -> OutlinedButton(
            onClick = onClick,
            enabled = enabled,
            modifier = modifier.height(44.dp),
            shape = shape,
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
            content = content,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CompactStatusRow(
    items: List<StatusChipModel>,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items.forEach { item ->
            StatusChip(item)
        }
    }
}

@Composable
private fun RowScope.ActionGridButton(
    action: GridAction,
    modifier: Modifier = Modifier,
) {
    val colors = when (action.tone) {
        ActionTone.Neutral -> ButtonDefaults.filledTonalButtonColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = MaterialTheme.colorScheme.onSurface,
        )

        ActionTone.Accent -> ButtonDefaults.filledTonalButtonColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
            contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        )
    }

    FilledTonalButton(
        onClick = action.onClick,
        modifier = modifier.height(52.dp),
        shape = RoundedCornerShape(14.dp),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
        colors = colors,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(action.icon, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(
                text = action.label,
                style = MaterialTheme.typography.labelMedium,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun StatusChip(model: StatusChipModel) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = model.containerColor,
    ) {
        Text(
            text = model.label,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium,
            color = model.contentColor,
        )
    }
}

private data class StatusChipModel(
    val label: String,
    val containerColor: Color,
    val contentColor: Color,
)

private data class DialogModel(
    val title: String,
    val body: String,
)

@Composable
private fun statusChip(label: String): StatusChipModel = StatusChipModel(
    label = label,
    containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
    contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
)

@Composable
private fun connectionStatusChip(status: ConnectionStatus): StatusChipModel =
    when (status) {
        ConnectionStatus.Configured -> StatusChipModel(
            "готово",
            MaterialTheme.colorScheme.secondaryContainer,
            MaterialTheme.colorScheme.onSecondaryContainer,
        )

        ConnectionStatus.NeedsAuth -> StatusChipModel(
            "нужен вход",
            MaterialTheme.colorScheme.tertiaryContainer,
            MaterialTheme.colorScheme.onTertiaryContainer,
        )

        ConnectionStatus.SetupRequired -> StatusChipModel(
            "нужна настройка",
            MaterialTheme.colorScheme.primaryContainer,
            MaterialTheme.colorScheme.onPrimaryContainer,
        )

        ConnectionStatus.Offline -> StatusChipModel(
            "офлайн",
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
        )
    }

@Composable
private fun serviceStateChip(state: ServiceState): StatusChipModel =
    when (state) {
        ServiceState.Running -> StatusChipModel(
            "работает",
            MaterialTheme.colorScheme.secondaryContainer,
            MaterialTheme.colorScheme.onSecondaryContainer,
        )

        ServiceState.Stopped -> StatusChipModel(
            "остановлен",
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
        )

        ServiceState.Restarting -> StatusChipModel(
            "перезапуск",
            MaterialTheme.colorScheme.tertiaryContainer,
            MaterialTheme.colorScheme.onTertiaryContainer,
        )
    }

@Composable
private fun validationChip(state: RoutingValidationState): StatusChipModel =
    when (state) {
        RoutingValidationState.Idle -> statusChip("ожидание")
        RoutingValidationState.Dirty -> StatusChipModel(
            "изменен",
            MaterialTheme.colorScheme.tertiaryContainer,
            MaterialTheme.colorScheme.onTertiaryContainer,
        )

        RoutingValidationState.Valid -> StatusChipModel(
            "проверено",
            MaterialTheme.colorScheme.secondaryContainer,
            MaterialTheme.colorScheme.onSecondaryContainer,
        )

        RoutingValidationState.Invalid -> StatusChipModel(
            "ошибка",
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
        )
    }

private fun serviceStateLabel(state: ServiceState): String =
    when (state) {
        ServiceState.Running -> "Работает"
        ServiceState.Stopped -> "Остановлен"
        ServiceState.Restarting -> "Перезапуск"
    }

private fun capabilityLabel(capability: String): String =
    when (capability) {
        "routingEditor" -> "редактор"
        "logs" -> "логи"
        "restart" -> "рестарт"
        "diagnostics" -> "диагностика"
        else -> capability
    }

private fun logFilterLabel(filter: LogFilter): String =
    when (filter) {
        LogFilter.All -> "Все"
        LogFilter.Service -> "Сервис"
        LogFilter.Routing -> "Маршруты"
        LogFilter.Errors -> "Ошибки"
    }

private fun logSourceLabel(source: String): String =
    when (source) {
        "service" -> "Сервис"
        "routing" -> "Маршруты"
        "auth" -> "Авторизация"
        else -> source
    }

@Composable
private fun logLevelChip(level: LogLevel): StatusChipModel =
    when (level) {
        LogLevel.Info -> StatusChipModel(
            "ИНФО",
            MaterialTheme.colorScheme.secondaryContainer,
            MaterialTheme.colorScheme.onSecondaryContainer,
        )

        LogLevel.Warning -> StatusChipModel(
            "ВНИМАНИЕ",
            MaterialTheme.colorScheme.tertiaryContainer,
            MaterialTheme.colorScheme.onTertiaryContainer,
        )

        LogLevel.Error -> StatusChipModel(
            "ОШИБКА",
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
        )
    }

@Composable
private fun diagnosticSeverityChip(severity: DiagnosticSeverity): StatusChipModel =
    when (severity) {
        DiagnosticSeverity.Ok -> StatusChipModel(
            "НОРМА",
            MaterialTheme.colorScheme.secondaryContainer,
            MaterialTheme.colorScheme.onSecondaryContainer,
        )

        DiagnosticSeverity.Warning -> StatusChipModel(
            "ВНИМАНИЕ",
            MaterialTheme.colorScheme.tertiaryContainer,
            MaterialTheme.colorScheme.onTertiaryContainer,
        )

        DiagnosticSeverity.Error -> StatusChipModel(
            "ОШИБКА",
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
        )
    }

@Composable
private fun RowScope.BottomBarItem(
    tab: MainTab,
    selected: MainTab,
    onSelected: (MainTab) -> Unit,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
) {
    NavigationBarItem(
        selected = tab == selected,
        onClick = { onSelected(tab) },
        icon = { Icon(icon, contentDescription = null) },
        label = { Text(label) },
    )
}

@Preview(showBackground = true)
@Composable
private fun ReadyPreview() {
    XkeenMobileTheme {
        ReadyRoute(
            state = CompanionUiState(phase = AppPhase.Ready),
            controller = CompanionController(CompanionUiState(phase = AppPhase.Ready)),
        )
    }
}
