package io.xkeen.mobile.app

import androidx.compose.foundation.background
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
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
import kotlinx.coroutines.delay

@Composable
fun CompanionApp() {
    val controller = remember { DemoCompanionController() }
    val state = controller.state

    XkeenMobileTheme(darkTheme = false) {
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
private fun LaunchRoute(controller: DemoCompanionController) {
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
                    text = "Восстанавливаем последний доверенный сеанс и подготавливаем данные клиента.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    Text(
                        text = "Проверяем подключения, авторизацию и черновики маршрутов",
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
    controller: DemoCompanionController,
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
            title = "Добавить узел",
            supporting = "Подготовьте черновик подключения. Позже он будет сохранен в защищенное хранилище и использован для мобильного старта.",
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
                horizontalArrangement = Arrangement.End,
            ) {
                CompactActionButton(
                    label = "Сохранить",
                    icon = Icons.Outlined.Save,
                    onClick = controller::saveConnectionDraft,
                )
            }
        }

        SectionCard(
            title = "Сохраненные подключения",
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.connections.forEach { connection ->
                    ConnectionCard(
                        connection = connection,
                        onOpen = { controller.selectConnection(connection.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun PairLoginRoute(
    state: CompanionUiState,
    controller: DemoCompanionController,
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
    controller: DemoCompanionController,
) {
    WorkspaceNavigationFrame(state, controller) { openDrawer, openCoreDialog ->
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            topBar = {
                WorkspaceHeader(
                    state = state,
                    onMenu = openDrawer,
                    onCore = openCoreDialog,
                    onServiceAction = controller::requestServiceAction,
                )
            },
            bottomBar = {
                ReadyBottomBar(
                    selected = state.mainTab,
                    onSelected = controller::selectTab,
                )
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
    val selectedDocument = state.routing.documents.firstOrNull {
        it.id == state.routing.selectedDocumentId
    }

    val headerTitle = if (state.workspaceSection == WorkspaceSection.XrayRouting) {
        selectedDocument?.title ?: state.workspaceSection.title
    } else {
        state.workspaceSection.title
    }

    Surface(
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 3.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.statusBars)
                .height(68.dp)
                .padding(end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onMenu) {
                Icon(Icons.Outlined.Menu, contentDescription = "Открыть меню раздела")
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                Text(
                    text = headerTitle,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    modifier = Modifier.clickable(onClick = onCore),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = "Core",
                        style = MaterialTheme.typography.labelLarge,
                        color = Color(0xFF123E49),
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text = "· ${state.dashboard.activeCore}",
                        style = MaterialTheme.typography.labelMedium,
                        color = Color(0xFF64767B),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    repeat(5) { index ->
                        Box(
                            modifier = Modifier
                                .size(7.dp)
                                .background(
                                    color = if (index == 0) Color(0xFF244B86) else Color(0xFF8E9AB0),
                                    shape = CircleShape,
                                ),
                        )
                    }
                }
            }
            ServiceHeaderButton(
                label = "Start",
                color = Color(0xFF4B8B34),
                onClick = { onServiceAction(ServiceAction.Start) },
            )
            ServiceHeaderButton(
                label = "Stop",
                color = Color(0xFFB74332),
                onClick = { onServiceAction(ServiceAction.Stop) },
            )
            ServiceHeaderButton(
                label = "Restart",
                color = Color(0xFF50528D),
                onClick = { onServiceAction(ServiceAction.Restart) },
            )
        }
    }
}

@Composable
private fun ServiceHeaderButton(
    label: String,
    color: Color,
    onClick: () -> Unit,
) {
    TextButton(
        onClick = onClick,
        contentPadding = PaddingValues(horizontal = 5.dp, vertical = 0.dp),
    ) {
        Text(
            text = label,
            color = color,
            fontWeight = FontWeight.ExtraBold,
            fontSize = 14.sp,
        )
    }
}

@Composable
private fun ReadyBottomBar(
    selected: MainTab,
    onSelected: (MainTab) -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 6.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .height(58.dp)
                .padding(horizontal = 5.dp, vertical = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            WorkspaceTab(MainTab.Routing, selected, onSelected, "Xray")
            WorkspaceTab(MainTab.Home, selected, onSelected, "Mihomo")
            WorkspaceTab(MainTab.Logs, selected, onSelected, "Ports")
            WorkspaceTab(MainTab.More, selected, onSelected, "Shell")
            WorkspaceTab(MainTab.Generator, selected, onSelected, "Generator")
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
    Box(
        modifier = Modifier
            .weight(if (tab == MainTab.Generator) 1.35f else 1f)
            .fillMaxHeight()
            .background(
                color = if (isSelected) Color(0xFF123E49) else Color.Transparent,
                shape = RoundedCornerShape(5.dp),
            )
            .clickable { onSelected(tab) },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (isSelected) Color.White else Color(0xFF17333B),
            fontWeight = FontWeight.ExtraBold,
            fontSize = 13.sp,
            maxLines = 1,
        )
    }
}

@Composable
private fun DashboardScreen(
    state: CompanionUiState,
    controller: DemoCompanionController,
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
    controller: DemoCompanionController,
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
    controller: DemoCompanionController,
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
    controller: DemoCompanionController,
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

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text("Подтвердить")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Отмена")
            }
        },
        title = {
            Text(dialog.title)
        },
        text = {
            Text(dialog.body)
        },
    )
}

@Composable
private fun ConnectionCard(
    connection: Connection,
    onOpen: () -> Unit,
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
                CompactActionButton(
                    label = "Открыть",
                    onClick = onOpen,
                )
            }
            CompactStatusRow(
                items = listOf(
                    connectionStatusChip(connection.status),
                    statusChip(connection.lastSeen),
                ),
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
            modifier = modifier.height(44.dp),
            shape = shape,
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
            content = content,
        )

        CompactButtonStyle.Outlined -> OutlinedButton(
            onClick = onClick,
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
            controller = DemoCompanionController(CompanionUiState(phase = AppPhase.Ready)),
        )
    }
}
