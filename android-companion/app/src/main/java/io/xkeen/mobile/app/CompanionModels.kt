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

enum class WorkspaceSection(
    val tab: MainTab,
    val title: String,
) {
    XrayRouting(MainTab.Routing, "Роутинг Xray"),
    XraySubscriptions(MainTab.Routing, "Подписки Xray"),
    XrayInbounds(MainTab.Routing, "Режим Inbounds"),
    XrayScenario(MainTab.Routing, "Сценарий маршрутизации"),
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
)

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
    val connections: List<Connection> = demoConnections(),
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

fun demoConnections(): List<Connection> = listOf(
    Connection(
        id = "home-lab",
        name = "Домашний узел",
        baseUrl = "https://lab.lan:8443",
        status = ConnectionStatus.Configured,
        lastSeen = "Был на связи 20 сек назад",
    ),
    Connection(
        id = "edge-node",
        name = "Пограничный узел",
        baseUrl = "https://edge.lan:8443",
        status = ConnectionStatus.NeedsAuth,
        lastSeen = "Вход устарел",
    ),
    Connection(
        id = "travel-box",
        name = "Дорожный узел",
        baseUrl = "http://192.168.31.20:8080",
        status = ConnectionStatus.Offline,
        lastSeen = "Офлайн",
    ),
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
        RecentEvent("17:35", "Сессия восстановлена", "Мобильный токен использован без браузера"),
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
        LogEntry("17:41:13", "auth", LogLevel.Info, "Мобильная сессия восстановлена из хранилища"),
        LogEntry("17:35:28", "routing", LogLevel.Error, "Черновик 13 не прошел проверку: нет правил"),
    ),
)

fun demoDiagnostics(): List<DiagnosticItem> = listOf(
    DiagnosticItem("Мобильная сессия", "Активна и восстановлена", DiagnosticSeverity.Ok),
    DiagnosticItem("Поток логов", "Окно переподключения 30 сек", DiagnosticSeverity.Ok),
    DiagnosticItem("Защищенное хранилище", "Пока не подключено", DiagnosticSeverity.Warning),
    DiagnosticItem("API мобильного клиента", "Пока работает на моках", DiagnosticSeverity.Warning),
)
