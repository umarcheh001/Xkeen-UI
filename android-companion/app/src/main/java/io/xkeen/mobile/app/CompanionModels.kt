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
    Unknown,
    Running,
    Stopped,
    Restarting,
}

enum class ServiceOperationPhase {
    Idle,
    Pending,
    Success,
    Failure,
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

/** Log file selected in the read-only Xray viewer. */
enum class XrayLogStreamFilter {
    All,
    Access,
    Error,
}

/** Minimum visual slice selected by the user; it never changes server-side logging. */
enum class XrayLogLevelFilter {
    All,
    Info,
    Warning,
    Error,
}

/**
 * Observable state of the cursor-based Xray log transport.  A disconnected stream is not an
 * error by itself: it is the expected state while the app is backgrounded or no session is open.
 */
enum class LogsConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    AuthRequired,
}

enum class RoutingMode {
    Read,
    Edit,
}

enum class RoutingValidationState {
    Idle,
    Dirty,
    Validating,
    Valid,
    Invalid,
}

enum class RoutingWritePhase {
    Idle,
    Saving,
    Applying,
    Success,
    Failure,
    Conflict,
}

enum class InboundsMode(
    val apiValue: String,
    val displayName: String,
) {
    Hybrid("mixed", "Hybrid"),
    TProxy("tproxy", "TProxy"),
    Redirect("redirect", "Redirect"),
    ;

    companion object {
        fun fromApiValue(value: String?): InboundsMode? = entries.firstOrNull {
            it.apiValue == value?.trim()?.lowercase()
        }
    }
}

enum class RoutingWorkflowStep {
    Validate,
    Save,
    Apply,
    Complete,
}

/**
 * Identifies where a routing diagnostic was produced.  Local syntax feedback is deliberately
 * kept separate from the server's Xray/preflight result so the UI never presents a client-side
 * guess as a confirmed validation result.
 */
enum class RoutingDiagnosticSource {
    LocalSyntax,
    Server,
    Transport,
}

enum class RoutingDiagnosticSeverity {
    Info,
    Warning,
    Error,
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

data class ServiceOperationState(
    val phase: ServiceOperationPhase = ServiceOperationPhase.Idle,
    val action: ServiceAction? = null,
    val targetCore: String? = null,
    val message: String? = null,
) {
    val isPending: Boolean
        get() = phase == ServiceOperationPhase.Pending
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
    val publishedRevision: String = "",
    val savedRevision: String = "",
    val draftBaseRevision: String = "",
    val hasServerSavedDraft: Boolean = false,
) {
    val hasDraftChanges: Boolean
        get() = draftContent != publishedContent

    val hasUnsavedChanges: Boolean
        get() = draftContent != savedDraftContent

    val hasSavedPreview: Boolean
        get() = savedDraftContent != publishedContent

    val revisionLabel: String
        get() = publishedRevision
            .substringAfter(':', publishedRevision)
            .take(8)
            .takeIf(String::isNotBlank)
            ?: "r$revision"
}

fun routingWorkflowStep(
    document: RoutingDocument,
    validation: RoutingValidation,
): RoutingWorkflowStep = when {
    !document.isLoaded -> RoutingWorkflowStep.Complete
    validation.state != RoutingValidationState.Valid &&
        (document.hasUnsavedChanges || document.hasDraftChanges) -> RoutingWorkflowStep.Validate
    document.hasUnsavedChanges -> RoutingWorkflowStep.Save
    document.hasServerSavedDraft && document.hasDraftChanges -> RoutingWorkflowStep.Apply
    else -> RoutingWorkflowStep.Complete
}

data class RoutingDiagnostic(
    val source: RoutingDiagnosticSource,
    val severity: RoutingDiagnosticSeverity,
    val code: String? = null,
    val message: String,
    val hint: String? = null,
    val phase: String? = null,
    val line: Int? = null,
    val column: Int? = null,
    val path: String? = null,
) {
    val locationLabel: String?
        get() = when {
            line != null && column != null -> "строка $line, столбец $column"
            line != null -> "строка $line"
            path != null -> path
            else -> null
        }
}

data class RoutingValidation(
    val state: RoutingValidationState = RoutingValidationState.Idle,
    val message: String = "Откройте конфиг и выполните проверку перед применением.",
    val serverDiagnostics: List<RoutingDiagnostic> = emptyList(),
    /** Supplementary notes that never participate in the authoritative server result. */
    val details: List<String> = emptyList(),
) {
    /** Only server-confirmed diagnostics are authoritative and visible to the user. */
    val diagnostics: List<RoutingDiagnostic>
        get() = serverDiagnostics

    val primaryDiagnostic: RoutingDiagnostic?
        get() = diagnostics.firstOrNull { it.severity == RoutingDiagnosticSeverity.Error }
            ?: diagnostics.firstOrNull()

    val displayMessage: String
        get() = primaryDiagnostic?.message?.takeIf(String::isNotBlank) ?: message

    val isPending: Boolean
        get() = state == RoutingValidationState.Validating
}

data class RoutingPreview(
    val headline: String,
    val details: List<String>,
)

data class RoutingWriteState(
    val phase: RoutingWritePhase = RoutingWritePhase.Idle,
    val message: String = "",
    val code: String? = null,
) {
    val isPending: Boolean
        get() = phase == RoutingWritePhase.Saving || phase == RoutingWritePhase.Applying
}

data class RoutingState(
    val searchQuery: String = "",
    val documents: List<RoutingDocument>,
    val selectedDocumentId: String,
    val mode: RoutingMode = RoutingMode.Read,
    val validation: RoutingValidation = RoutingValidation(),
    val preview: RoutingPreview? = null,
    val isValidationInFlight: Boolean = false,
    val remoteDirectory: String? = null,
    val isRefreshing: Boolean = false,
    val hasAttemptedRemoteLoad: Boolean = false,
    val loadError: String? = null,
    val write: RoutingWriteState = RoutingWriteState(),
)

data class InboundsFragment(
    val name: String,
    val sizeBytes: Long? = null,
    val modifiedAtEpochSeconds: Long? = null,
)

data class InboundsState(
    val fragments: List<InboundsFragment> = emptyList(),
    val selectedFragment: String = "",
    val activePath: String = "",
    val appliedMode: InboundsMode? = null,
    val selectedMode: InboundsMode? = null,
    val rawServerMode: String? = null,
    val restartAfterApply: Boolean = true,
    val isLoading: Boolean = false,
    val isApplying: Boolean = false,
    val hasLoaded: Boolean = false,
    val message: String = "Откройте раздел, чтобы загрузить режим inbounds.",
    val error: String? = null,
) {
    val hasChanges: Boolean
        get() = selectedMode != null && selectedMode != appliedMode

    val isCustomMode: Boolean
        get() = rawServerMode != null && appliedMode == null
}

data class OutboundsFragment(
    val name: String,
    val sizeBytes: Long? = null,
    val modifiedAtEpochSeconds: Long? = null,
)

data class OutboundLatency(
    val status: String = "unknown",
    val delayMillis: Long? = null,
    val message: String? = null,
)

data class OutboundNode(
    val key: String,
    val tag: String,
    val name: String,
    val protocol: String,
    val transport: String,
    val security: String,
    val host: String,
    val port: String,
    val sni: String,
    val detail: String,
    val subscriptionName: String? = null,
    val latency: OutboundLatency? = null,
) {
    val displayName: String
        get() = subscriptionName?.takeIf(String::isNotBlank) ?: name.ifBlank { tag.ifBlank { "proxy" } }

    val endpoint: String
        get() = listOf(host, port).filter(String::isNotBlank).joinToString(":")
}

data class OutboundPreviewField(
    val label: String,
    val value: String,
)

data class OutboundLinkPreview(
    val isValid: Boolean = false,
    val scheme: String = "",
    val transport: String = "",
    val security: String = "",
    val fields: List<OutboundPreviewField> = emptyList(),
    val errors: List<String> = emptyList(),
    val warnings: List<String> = emptyList(),
) {
    val hasContent: Boolean
        get() = scheme.isNotBlank() || fields.isNotEmpty() || errors.isNotEmpty() || warnings.isNotEmpty()
}

data class OutboundEditorState(
    val isOpen: Boolean = false,
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    val canEdit: Boolean = false,
    val isExistingLink: Boolean = false,
    val draftUrl: String = "",
    val savedUrl: String = "",
    val draftTag: String = "proxy",
    val savedTag: String = "proxy",
    val sourceFingerprint: String = "",
    val restartAfterSave: Boolean = true,
    val preview: OutboundLinkPreview = OutboundLinkPreview(),
    val message: String? = null,
    val error: String? = null,
) {
    val hasChanges: Boolean
        get() = draftUrl.trim() != savedUrl.trim() || draftTag.trim() != savedTag.trim()

    val canSave: Boolean
        get() = canEdit && preview.isValid && draftUrl.isNotBlank() && draftTag.isNotBlank() && !isSaving
}

data class OutboundPoolEntryDraft(
    val tag: String,
    val url: String,
    val preview: OutboundLinkPreview,
) {
    val isValid: Boolean
        get() = tag.isNotBlank() && url.isNotBlank() && preview.isValid && !isReservedOutboundPoolTag(tag)

    val displayName: String
        get() = preview.fields.firstOrNull { it.label == "Название" }?.value
            ?.takeIf(String::isNotBlank)
            ?: preview.fields.firstOrNull { it.label == "Сервер" }?.value
                ?.takeIf(String::isNotBlank)
            ?: tag
}

data class OutboundPoolEditorState(
    val isOpen: Boolean = false,
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    val canEdit: Boolean = false,
    val input: String = "",
    val entries: List<OutboundPoolEntryDraft> = emptyList(),
    val sourceFingerprint: String = "",
    val restartAfterSave: Boolean = true,
    val replacePool: Boolean = false,
    val message: String? = null,
    val error: String? = null,
) {
    val hasDraft: Boolean
        get() = input.isNotBlank() || entries.isNotEmpty()

    val canSave: Boolean
        get() {
            val tags = entries.map { it.tag.lowercase() }
            return canEdit && entries.isNotEmpty() && entries.all(OutboundPoolEntryDraft::isValid) &&
                tags.distinct().size == tags.size && !isLoading && !isSaving
        }
}

data class OutboundsState(
    val fragments: List<OutboundsFragment> = emptyList(),
    val selectedFragment: String = "",
    val activePath: String = "",
    val nodes: List<OutboundNode> = emptyList(),
    val activeNodeKey: String? = null,
    val activeNodeTag: String? = null,
    val activeMessage: String? = null,
    val isLoading: Boolean = false,
    val isPingingAll: Boolean = false,
    val pingingNodeKeys: Set<String> = emptySet(),
    val hasLoaded: Boolean = false,
    val editor: OutboundEditorState = OutboundEditorState(),
    val poolEditor: OutboundPoolEditorState = OutboundPoolEditorState(),
    val message: String = "Откройте раздел, чтобы загрузить proxy-узлы Xray.",
    val error: String? = null,
) {
    val isBusy: Boolean
        get() = isLoading || isPingingAll || pingingNodeKeys.isNotEmpty() || editor.isLoading || editor.isSaving ||
            poolEditor.isLoading || poolEditor.isSaving

    fun isActive(node: OutboundNode): Boolean =
        node.key.isNotBlank() && node.key == activeNodeKey ||
            node.tag.isNotBlank() && node.tag == activeNodeTag
}

enum class XraySubscriptionRoutingMode(
    val apiValue: String,
    val displayName: String,
) {
    Safe("safe-fallback", "Безопасно"),
    Migrate("migrate-vless-rules", "Жёстко"),
    SubscriptionOnly("subscription-only", "Только подписка"),
    ;

    companion object {
        fun fromApi(value: String): XraySubscriptionRoutingMode =
            entries.firstOrNull { it.apiValue == value } ?: Safe
    }
}

data class XraySubscriptionDraft(
    val id: String = "",
    val name: String = "",
    val tag: String = "",
    val url: String = "",
    val nameFilter: String = "",
    val typeFilter: String = "",
    val transportFilter: String = "",
    val excludedNodeKeys: List<String> = emptyList(),
    val enabled: Boolean = true,
    val pingEnabled: Boolean = true,
    val routingMode: XraySubscriptionRoutingMode = XraySubscriptionRoutingMode.Safe,
    val routingAutoRule: Boolean = true,
    val routingBalancerTags: List<String> = emptyList(),
    val sockoptMark255: Boolean = false,
    val intervalHours: String = "24",
) {
    val validationError: String?
        get() {
            val source = url.trim()
            if (source.isBlank()) return "URL подписки обязателен."
            val supported = source.startsWith("https://", ignoreCase = true) ||
                source.startsWith("http://", ignoreCase = true) ||
                Regex("^happ://crypt[0-9]*/", RegexOption.IGNORE_CASE).containsMatchIn(source)
            if (!supported) return "Нужен HTTP(S) URL или happ://crypt…"
            val interval = intervalHours.trim().toIntOrNull()
            if (interval !in 1..168) return "Интервал должен быть от 1 до 168 часов."
            listOf(
                "фильтр имени" to nameFilter,
                "фильтр типа" to typeFilter,
                "фильтр транспорта" to transportFilter,
            ).forEach { (label, expression) ->
                if (expression.isNotBlank()) {
                    try {
                        Regex(expression, RegexOption.IGNORE_CASE)
                    } catch (_: Exception) {
                        return "Некорректный $label."
                    }
                }
            }
            return null
        }

    fun previewSignature(): String = listOf(
        url.trim(),
        tag.trim().ifBlank { name.trim() },
        nameFilter.trim(),
        typeFilter.trim(),
        transportFilter.trim(),
        excludedNodeKeys.sorted().joinToString("|"),
    ).joinToString("\u0000")
}

enum class XraySubscriptionNodeCatalogSource {
    None,
    SavedSnapshot,
    LivePreview,
}

data class XraySubscriptionNodeCatalog(
    val source: XraySubscriptionNodeCatalogSource = XraySubscriptionNodeCatalogSource.None,
    val nodes: List<OutboundNode> = emptyList(),
    val count: Int = 0,
    val sourceCount: Int = 0,
    val filteredOutCount: Int = 0,
    val warnings: List<String> = emptyList(),
    val errors: List<String> = emptyList(),
    val sourceFormat: String = "",
    val fetchMode: String = "",
    val profileUpdateIntervalHours: Int? = null,
    val updatedAtEpochSeconds: Long? = null,
) {
    val totalCount: Int
        get() = maxOf(sourceCount, nodes.size, count)

    val isAvailable: Boolean
        get() = source != XraySubscriptionNodeCatalogSource.None
}

data class XraySubscriptionEditorState(
    val isOpen: Boolean = false,
    val isPreviewing: Boolean = false,
    val isSaving: Boolean = false,
    val isPingingAll: Boolean = false,
    val pingingNodeKeys: Set<String> = emptySet(),
    val draft: XraySubscriptionDraft = XraySubscriptionDraft(),
    val savedDraft: XraySubscriptionDraft = XraySubscriptionDraft(),
    val preview: XraySubscriptionPreview? = null,
    val nodeCatalog: XraySubscriptionNodeCatalog = XraySubscriptionNodeCatalog(),
    val previewSignature: String = "",
    val advancedExpanded: Boolean = false,
    val refreshAfterSave: Boolean = true,
    val restartAfterMutation: Boolean = true,
    val message: String? = null,
    val error: String? = null,
) {
    val isPinging: Boolean
        get() = isPingingAll || pingingNodeKeys.isNotEmpty()

    val hasChanges: Boolean
        get() = draft != savedDraft

    val previewIsCurrent: Boolean
        get() = preview != null && previewSignature == draft.previewSignature()

    val previewAffectingChanges: Boolean
        get() = draft.previewSignature() != savedDraft.previewSignature()

    val requiresPreview: Boolean
        get() = draft.id.isBlank() || previewAffectingChanges

    val canSave: Boolean
        get() = draft.validationError == null && !isPreviewing && !isSaving && !isPinging &&
            (!requiresPreview || previewIsCurrent)
}

data class XraySubscriptionsState(
    val items: List<XraySubscriptionRecord> = emptyList(),
    val routingBalancers: List<XraySubscriptionRoutingBalancer> = emptyList(),
    val hasLoaded: Boolean = false,
    val isLoading: Boolean = false,
    val refreshingIds: Set<String> = emptySet(),
    val deletingIds: Set<String> = emptySet(),
    val isRefreshingDue: Boolean = false,
    val editor: XraySubscriptionEditorState = XraySubscriptionEditorState(),
    val message: String = "Откройте раздел, чтобы загрузить подписки Xray.",
    val error: String? = null,
) {
    val isBusy: Boolean
        get() = isLoading || refreshingIds.isNotEmpty() || deletingIds.isNotEmpty() || isRefreshingDue ||
            editor.isPreviewing || editor.isSaving || editor.isPinging
}

data class LogEntry(
    val time: String,
    val source: String,
    val level: LogLevel,
    val message: String,
    val id: String = "",
)

data class XrayLogDevice(
    val ip: String,
    val name: String,
    val source: String,
    val routerName: String? = null,
    val mac: String? = null,
    val hostname: String? = null,
) {
    val isManual: Boolean
        get() = source.equals("manual", ignoreCase = true)
}

data class LogsState(
    val filter: LogFilter = LogFilter.All,
    val streamFilter: XrayLogStreamFilter = XrayLogStreamFilter.All,
    val levelFilter: XrayLogLevelFilter = XrayLogLevelFilter.All,
    val searchQuery: String = "",
    val useRegex: Boolean = false,
    val displayLimit: Int = 600,
    val compactRows: Boolean = true,
    val followNewest: Boolean = true,
    val isPausedByUser: Boolean = false,
    val streamAvailability: Map<String, Boolean> = emptyMap(),
    val entries: List<LogEntry> = emptyList(),
    val connection: LogsConnectionState = LogsConnectionState.Disconnected,
    val statusMessage: String = "Поток логов ожидает подключения.",
    val reconnectAttempt: Int = 0,
    val hasLoadedHistory: Boolean = false,
    val xrayLogLevel: String? = null,
    val preferredXrayLogLevel: String = "info",
    val isXrayLogControlBusy: Boolean = false,
    val xrayLogControlMessage: String? = null,
    val xrayLogControlError: String? = null,
    val devices: List<XrayLogDevice> = emptyList(),
    val hasLoadedDevices: Boolean = false,
    val isLoadingDevices: Boolean = false,
    val devicesError: String? = null,
    val routerDevicesError: String? = null,
    val showDeviceNames: Boolean = true,
    val showDomains: Boolean = true,
    val destinationDomainsByIp: Map<String, String> = emptyMap(),
)

enum class MihomoConfigOperationPhase {
    Idle,
    Loading,
    Validating,
    Saving,
    Restarting,
    Success,
    Failure,
}

data class MihomoConfigState(
    val content: String = "",
    val savedContent: String = "",
    val activeProfile: String = "config.yaml",
    val hasLoaded: Boolean = false,
    val operation: MihomoConfigOperationPhase = MihomoConfigOperationPhase.Idle,
    val message: String = "Откройте раздел, чтобы загрузить активный YAML-профиль Mihomo.",
    val validationLog: String = "",
    val validatedContent: String? = null,
) {
    val hasChanges: Boolean
        get() = hasLoaded && content != savedContent

    val isBusy: Boolean
        get() = operation in setOf(
            MihomoConfigOperationPhase.Loading,
            MihomoConfigOperationPhase.Validating,
            MihomoConfigOperationPhase.Saving,
            MihomoConfigOperationPhase.Restarting,
        )

    val isCurrentContentValid: Boolean
        get() = validatedContent == content
}

enum class PortsDocumentId(
    val fileName: String,
    val endpoint: String,
    val description: String,
    val isJson: Boolean = false,
) {
    PortProxying(
        fileName = "port_proxying.lst",
        endpoint = "/api/xkeen/port-proxying",
        description = "Порты и диапазоны, которые нужно отправлять через прокси.",
    ),
    PortExclude(
        fileName = "port_exclude.lst",
        endpoint = "/api/xkeen/port-exclude",
        description = "Порты, которые нужно исключить из проксирования.",
    ),
    IpExclude(
        fileName = "ip_exclude.lst",
        endpoint = "/api/xkeen/ip-exclude",
        description = "IP и подсети, которые нужно исключить из проксирования.",
    ),
    XkeenConfig(
        fileName = "xkeen.json",
        endpoint = "/api/xkeen/config",
        description = "Пользовательские политики портов для разных устройств.",
        isJson = true,
    ),
    ;

    val path: String
        get() = "/opt/etc/xkeen/$fileName"
}

data class PortsEditorDocument(
    val id: PortsDocumentId,
    val content: String = "",
    val savedContent: String = "",
    val hasLoaded: Boolean = false,
    val isLoading: Boolean = false,
    val error: String? = null,
) {
    val hasChanges: Boolean
        get() = hasLoaded && content != savedContent
}

data class PortsEditorState(
    val documents: List<PortsEditorDocument> = defaultPortsEditorDocuments(),
    val selectedId: PortsDocumentId = PortsDocumentId.PortProxying,
    val isSaving: Boolean = false,
    val message: String = "Откройте раздел, чтобы загрузить порты и исключения.",
    val error: String? = null,
) {
    val selectedDocument: PortsEditorDocument?
        get() = documents.firstOrNull { it.id == selectedId }

    val isBusy: Boolean
        get() = isSaving || selectedDocument?.isLoading == true
}

fun defaultPortsEditorDocuments(): List<PortsEditorDocument> =
    PortsDocumentId.entries.map(::PortsEditorDocument)

fun unloadedPortsEditorState(): PortsEditorState = PortsEditorState()

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
    val keeneticLoginForm: LoginForm = LoginForm(),
    val isKeeneticAuthRequired: Boolean = false,
    val isSessionBusy: Boolean = false,
    val sessionMessage: String? = null,
    val mainTab: MainTab = MainTab.Routing,
    val workspaceSection: WorkspaceSection = WorkspaceSection.XrayRouting,
    val dashboard: DashboardState = demoDashboardState(),
    val routing: RoutingState = demoRoutingState(),
    val inbounds: InboundsState = InboundsState(),
    val outbounds: OutboundsState = OutboundsState(),
    val xraySubscriptions: XraySubscriptionsState = XraySubscriptionsState(),
    val xrayDat: XrayDatState = XrayDatState(),
    val mihomoConfig: MihomoConfigState = MihomoConfigState(),
    val portsEditor: PortsEditorState = PortsEditorState(),
    val logs: LogsState = LogsState(),
    val diagnostics: List<DiagnosticItem> = initialDiagnostics(),
    val pendingAction: PendingAction? = null,
    val serviceOperation: ServiceOperationState = ServiceOperationState(),
)

/**
 * Freshly opened sessions must not inherit a previous node's runtime, routing metadata or demo
 * fixtures.  The controller replaces this state only after server reads have confirmed it.
 */
fun unloadedDashboardState(): DashboardState = DashboardState(
    instanceLabel = "Xkeen UI",
    endpoint = "",
    statusSummary = "Ожидание подключения к Xkeen UI",
    serviceState = ServiceState.Unknown,
    activeCore = "Не определено",
    version = "Не загружено",
    lastOperation = "Ожидание server snapshot",
    lastError = null,
    capabilities = emptyList(),
    recentEvents = emptyList(),
    availableCores = emptyList(),
)

fun unloadedRoutingState(): RoutingState = RoutingState(
    documents = emptyList(),
    selectedDocumentId = "",
    validation = RoutingValidation(message = "Ожидаем список routing-конфигураций с Xkeen UI…"),
)

fun unloadedInboundsState(): InboundsState = InboundsState(
    message = "Ожидаем загрузку режима inbounds с Xkeen UI…",
)

fun unloadedOutboundsState(): OutboundsState = OutboundsState(
    message = "Ожидаем загрузку proxy-узлов с Xkeen UI…",
)

fun unloadedXraySubscriptionsState(): XraySubscriptionsState = XraySubscriptionsState(
    message = "Ожидаем загрузку подписок Xray с Xkeen UI…",
)

fun unloadedXrayDatState(): XrayDatState = XrayDatState()

fun unloadedMihomoConfigState(): MihomoConfigState = MihomoConfigState()

fun initialDiagnostics(): List<DiagnosticItem> = listOf(
    DiagnosticItem("Мобильная сессия", "Ожидает входа", DiagnosticSeverity.Warning),
    DiagnosticItem("Поток логов", "Ожидает подключения к узлу", DiagnosticSeverity.Warning),
    DiagnosticItem("Защищенное хранилище", "Готово", DiagnosticSeverity.Ok),
    DiagnosticItem("API мобильного клиента", "Доступен после входа", DiagnosticSeverity.Ok),
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
