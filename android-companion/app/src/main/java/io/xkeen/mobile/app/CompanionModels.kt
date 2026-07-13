package io.xkeen.mobile.app

enum class AppPhase {
    Launching,
    Connections,
    PairLogin,
    Ready,
}

enum class MainTab {
    Routing,
    Home,
    Logs,
    More,
    Generator,
}

internal fun MainTab.isAvailableFor(availableCores: List<String>): Boolean =
    when (this) {
        MainTab.Routing -> availableCores.hasCore("xray")
        MainTab.Home,
        MainTab.Generator,
        -> availableCores.hasCore("mihomo")

        MainTab.Logs,
        MainTab.More,
        -> true
    }

enum class WorkspaceSection(
    val tab: MainTab,
    val title: String,
) {
    XrayRouting(MainTab.Routing, "Роутинг Xray"),
    XraySubscriptions(MainTab.Routing, "Подписки Xray"),
    XrayInbounds(MainTab.Routing, "Режим Inbounds"),
    XrayOutbounds(MainTab.Routing, "Прокси / Outbounds"),
    XrayAssets(MainTab.Routing, "DAT-файлы GeoIP / GeoSite"),
    XrayLogs(MainTab.Routing, "Логи Xray"),
    MihomoRouting(MainTab.Home, "Роутинг Mihomo"),
    MihomoProfiles(MainTab.Home, "Профили и подписки"),
    MihomoProviders(MainTab.Home, "Прокси-провайдеры"),
    MihomoGroups(MainTab.Home, "Группы прокси"),
    MihomoRules(MainTab.Home, "Правила Mihomo"),
    PortsOverview(MainTab.Logs, "Порты и исключения"),
    PortsXray(MainTab.Logs, "Порты Xray"),
    PortsMihomo(MainTab.Logs, "Порты Mihomo"),
    RoutingExclusions(MainTab.Logs, "Исключения маршрутизации"),
    ShellCommands(MainTab.More, "Команды"),
    ShellTerminal(MainTab.More, "Терминал"),
    ShellHistory(MainTab.More, "История команд"),
    MihomoGenerator(MainTab.Generator, "Генератор Mihomo"),
    GeneratorProfiles(MainTab.Generator, "Профили генератора"),
    GeneratorTemplates(MainTab.Generator, "Шаблоны"),
}

internal fun WorkspaceSection.isAvailableFor(availableCores: List<String>): Boolean =
    when (this) {
        WorkspaceSection.XrayRouting,
        WorkspaceSection.XraySubscriptions,
        WorkspaceSection.XrayInbounds,
        WorkspaceSection.XrayOutbounds,
        WorkspaceSection.XrayAssets,
        WorkspaceSection.XrayLogs,
        WorkspaceSection.PortsXray,
        -> availableCores.hasCore("xray")

        WorkspaceSection.MihomoRouting,
        WorkspaceSection.MihomoProfiles,
        WorkspaceSection.MihomoProviders,
        WorkspaceSection.MihomoGroups,
        WorkspaceSection.MihomoRules,
        WorkspaceSection.PortsMihomo,
        WorkspaceSection.MihomoGenerator,
        WorkspaceSection.GeneratorProfiles,
        WorkspaceSection.GeneratorTemplates,
        -> availableCores.hasCore("mihomo")

        WorkspaceSection.PortsOverview,
        WorkspaceSection.RoutingExclusions,
        WorkspaceSection.ShellCommands,
        WorkspaceSection.ShellTerminal,
        WorkspaceSection.ShellHistory,
        -> true
    }

internal fun List<String>.hasCore(core: String): Boolean =
    any { it.equals(core, ignoreCase = true) }

fun MainTab.defaultWorkspaceSection(): WorkspaceSection =
    when (this) {
        MainTab.Routing -> WorkspaceSection.XrayRouting
        MainTab.Home -> WorkspaceSection.MihomoRouting
        MainTab.Logs -> WorkspaceSection.PortsOverview
        MainTab.More -> WorkspaceSection.ShellCommands
        MainTab.Generator -> WorkspaceSection.MihomoGenerator
    }

enum class ConnectionStatus {
    Offline,
    NeedsAuth,
    Configured,
    SetupRequired,
}

enum class ServiceState {
    Running,
    Stopped,
    Restarting,
}

enum class LogLevel {
    Info,
    Warning,
    Error,
}

enum class LogFilter {
    All,
    Service,
    Routing,
    Errors,
}

enum class RoutingMode {
    Read,
    Edit,
}

enum class RoutingValidationState {
    Idle,
    Dirty,
    Valid,
    Invalid,
}

enum class DiagnosticSeverity {
    Ok,
    Warning,
    Error,
}

enum class ServiceAction(val label: String) {
    Start("Старт"),
    Stop("Стоп"),
    Restart("Перезапуск"),
}

data class Connection(
    val id: String,
    val name: String,
    val baseUrl: String,
    val status: ConnectionStatus,
    val lastSeen: String,
)

data class ConnectionDraft(
    val name: String = "",
    val baseUrl: String = "http://",
    val editingConnectionId: String? = null,
) {
    val isEditing: Boolean
        get() = editingConnectionId != null
}

data class LoginForm(
    val username: String = "admin",
    val password: String = "",
)

data class DashboardState(
    val instanceLabel: String,
    val endpoint: String,
    val statusSummary: String,
    val serviceState: ServiceState,
    val activeCore: String,
    val version: String,
    val lastOperation: String,
    val lastError: String?,
    val capabilities: List<String>,
    val recentEvents: List<RecentEvent>,
    val availableCores: List<String> = listOf("Xray", "Mihomo"),
)

data class RecentEvent(
    val time: String,
    val title: String,
    val subtitle: String,
)

data class RoutingDocument(
    val id: String,
    val title: String,
    val path: String,
    val summary: String,
    val revision: Int,
    val publishedContent: String,
    val draftContent: String,
    val savedDraftContent: String,
    val lastSavedAt: String,
    val lastAppliedAt: String?,
    val sizeBytes: Long? = null,
    val modifiedAtEpochSeconds: Long? = null,
    val usesJsonc: Boolean = false,
    val isSensitive: Boolean = false,
    val isLoaded: Boolean = true,
    val isLoading: Boolean = false,
    val loadError: String? = null,
) {
    val hasDraftChanges: Boolean
        get() = draftContent != publishedContent

    val hasUnsavedChanges: Boolean
        get() = draftContent != savedDraftContent

    val hasSavedPreview: Boolean
        get() = savedDraftContent != publishedContent
}

data class RoutingValidation(
    val state: RoutingValidationState = RoutingValidationState.Idle,
    val message: String = "Откройте конфиг и выполните проверку перед применением.",
    val details: List<String> = emptyList(),
)

data class RoutingPreview(
    val headline: String,
    val details: List<String>,
)

data class RoutingState(
    val searchQuery: String = "",
    val documents: List<RoutingDocument>,
    val selectedDocumentId: String,
    val mode: RoutingMode = RoutingMode.Read,
    val validation: RoutingValidation = RoutingValidation(),
    val preview: RoutingPreview? = null,
    val remoteDirectory: String? = null,
    val isRefreshing: Boolean = false,
    val hasAttemptedRemoteLoad: Boolean = false,
    val loadError: String? = null,
)

data class LogEntry(
    val time: String,
    val source: String,
    val level: LogLevel,
    val message: String,
)

data class LogsState(
    val filter: LogFilter = LogFilter.All,
    val entries: List<LogEntry>,
)

data class DiagnosticItem(
    val label: String,
    val status: String,
    val severity: DiagnosticSeverity,
)

sealed interface PendingAction {
    data class Service(val action: ServiceAction) : PendingAction
    data object ApplyRouting : PendingAction
}

data class CompanionUiState(
    val phase: AppPhase = AppPhase.Launching,
    val connections: List<Connection> = emptyList(),
    val connectionDraft: ConnectionDraft = ConnectionDraft(),
    val selectedConnectionId: String? = null,
    val loginForm: LoginForm = LoginForm(),
    val mainTab: MainTab = MainTab.Routing,
    val workspaceSection: WorkspaceSection = WorkspaceSection.XrayRouting,
    val dashboard: DashboardState = demoDashboardState(),
    val routing: RoutingState = demoRoutingState(),
    val logs: LogsState = demoLogsState(),
    val diagnostics: List<DiagnosticItem> = demoDiagnostics(),
    val pendingAction: PendingAction? = null,
)

fun demoDashboardState(): DashboardState = DashboardState(
    instanceLabel = "Домашний узел",
    endpoint = "https://lab.lan:8443",
    statusSummary = "Готов к безопасному управлению",
    serviceState = ServiceState.Running,
    activeCore = "Xray",
    version = "Xkeen 0.8.0-alpha",
    lastOperation = "Подготовлено превью маршрутов",
    lastError = null,
    capabilities = listOf("routingEditor", "logs", "restart", "diagnostics"),
    recentEvents = listOf(
        RecentEvent("17:48", "Сервис в норме", "Ядро xray принимает трафик"),
        RecentEvent("17:42", "Черновик сохранен", "main-routing.json готов к применению"),
        RecentEvent("17:35", "Demo-сессия открыта", "Вход завершен без перехода в браузер"),
    ),
)

private fun mainRoutingContent(): String = """
    {
      "routing": {
        "domainStrategy": "IPIfNonMatch",
        "rules": [
          // Блокировка QUIC
          {
            "type": "field",
            "network": "udp",
            "port": "443",
            "outboundTag": "block"
          },
          // Уязвимые UDP-порты
          {
            "type": "field",
            "network": "udp",
            "port": "135,137,138,139",
            "outboundTag": "block"
          },
          // Реклама и аналитика
          {
            "type": "field",
            "domain": ["geosite:category-ads-all"],
            "outboundTag": "block"
          }
        ]
      }
    }
""".trimIndent()

private fun bypassRoutingContent(): String = """
    {
      "routing": {
        "rules": [
          {
            "type": "field",
            "domain": ["geosite:category-ads-all"],
            "outboundTag": "block"
          }
        ]
      }
    }
""".trimIndent()

fun demoRoutingState(): RoutingState {
    val main = mainRoutingContent()
    val bypass = bypassRoutingContent()

    return RoutingState(
        documents = listOf(
            RoutingDocument(
                id = "main-routing",
                title = "05_routing.json",
                path = "/opt/etc/xray/configs/05_routing.json",
                summary = "Активный набор правил Xray для LAN и DNS",
                revision = 14,
                publishedContent = main,
                draftContent = main,
                savedDraftContent = main,
                lastSavedAt = "17:42",
                lastAppliedAt = "17:20",
            ),
            RoutingDocument(
                id = "bypass-routing",
                title = "06_bypass.json",
                path = "/opt/etc/xray/configs/06_bypass.json",
                summary = "Дополнительные правила для блокировок и обхода",
                revision = 6,
                publishedContent = bypass,
                draftContent = bypass,
                savedDraftContent = bypass,
                lastSavedAt = "16:58",
                lastAppliedAt = "16:40",
            ),
        ),
        selectedDocumentId = "main-routing",
    )
}

fun demoLogsState(): LogsState = LogsState(
    entries = listOf(
        LogEntry("17:49:11", "service", LogLevel.Info, "Пульс сервиса выглядит штатно"),
        LogEntry("17:48:02", "routing", LogLevel.Info, "Превью собрано для main-routing.json"),
        LogEntry("17:46:55", "service", LogLevel.Warning, "Окно перезапуска открыто на 8 секунд"),
        LogEntry("17:41:13", "auth", LogLevel.Info, "Demo-сессия открыта после входа"),
        LogEntry("17:35:28", "routing", LogLevel.Error, "Черновик 13 не прошел проверку: нет правил"),
    ),
)

fun demoDiagnostics(): List<DiagnosticItem> = listOf(
    DiagnosticItem("Мобильная сессия", "Активна в demo-режиме", DiagnosticSeverity.Ok),
    DiagnosticItem("Поток логов", "Окно переподключения 30 сек", DiagnosticSeverity.Ok),
    DiagnosticItem("Защищенное хранилище", "Пока не подключено", DiagnosticSeverity.Warning),
    DiagnosticItem("API мобильного клиента", "Пока работает на моках", DiagnosticSeverity.Warning),
)
