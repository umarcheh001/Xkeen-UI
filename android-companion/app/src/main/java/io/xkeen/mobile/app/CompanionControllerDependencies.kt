package io.xkeen.mobile.app

import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.security.SecureRandom
import java.util.Base64

internal interface ConnectionsPort {
    fun load(): StoredConnections

    fun save(
        draft: ConnectionDraft,
        existing: Connection?,
    ): Connection

    fun update(connection: Connection)

    fun select(connectionId: String)
}

internal data class StoredConnections(
    val connections: List<Connection> = emptyList(),
    val selectedConnectionId: String? = null,
)

internal interface SessionPort {
    suspend fun pair(connection: Connection): SessionPairResult

    suspend fun login(connection: Connection, credentials: LoginForm): SessionOpenResult

    suspend fun authorizeKeenetic(
        connection: Connection,
        credentials: LoginForm,
    ): SessionPairResult = pair(connection)

    suspend fun restore(connection: Connection): SessionRestoreResult

    suspend fun disconnect(connection: Connection): SessionCloseResult

    fun expire(connection: Connection): SessionCloseResult
}

internal sealed interface SessionPairResult {
    data class Open(val result: SessionOpenResult) : SessionPairResult

    data class Status(
        val connection: Connection,
        val statusSummary: String,
        val message: String,
    ) : SessionPairResult
}

internal sealed interface SessionRestoreResult {
    data object NotAvailable : SessionRestoreResult

    data class Open(val result: SessionOpenResult) : SessionRestoreResult

    data class AuthRequired(val result: SessionCloseResult) : SessionRestoreResult
}

internal interface ServiceActionsPort {
    suspend fun switchCore(baseUrl: String, core: String): CoreSwitchResult

    suspend fun perform(baseUrl: String, action: ServiceAction): ServiceActionResult

    suspend fun load(baseUrl: String): ConfirmedServiceSnapshot
}

internal interface RoutingWritePort {
    suspend fun save(baseUrl: String, document: RoutingDocument): RoutingSaveResult

    suspend fun apply(baseUrl: String, document: RoutingDocument): RoutingApplyResult
}

internal interface LogsPort {
    fun record(
        current: LogsState,
        source: String,
        level: LogLevel,
        message: String,
    ): LogsState
}

internal interface CompanionJournalPort {
    fun shortTime(): String

    fun longTime(): String

    fun createEntry(source: String, level: LogLevel, message: String): LogEntry =
        LogEntry(
            time = longTime(),
            source = source,
            level = level,
            message = message,
        )
}

internal data class SessionOpenResult(
    val connection: Connection,
    val statusSummary: String,
    val lastOperation: String,
    val eventTitle: String,
    val eventSubtitle: String,
    val logMessage: String,
)

internal data class SessionCloseResult(
    val connection: Connection,
    val statusSummary: String,
    val logMessage: String,
)

internal data class CoreSwitchResult(
    val snapshot: ConfirmedServiceSnapshot,
    val statusSummary: String,
    val lastOperation: String,
    val eventTitle: String,
    val eventSubtitle: String,
    val logMessage: String,
)

internal data class ServiceActionResult(
    val snapshot: ConfirmedServiceSnapshot,
    val statusSummary: String,
    val lastOperation: String,
    val eventTitle: String,
    val eventSubtitle: String,
    val logMessage: String,
)

internal data class ConfirmedServiceSnapshot(
    val serviceState: ServiceState,
    val activeCore: String,
    val availableCores: List<String>,
)

internal data class RoutingSaveResult(
    val document: RoutingDocument,
    val validation: RoutingValidation,
    val lastOperation: String,
    val logMessage: String,
)

internal data class RoutingApplyResult(
    val document: RoutingDocument,
    val validation: RoutingValidation,
    val preview: RoutingPreview,
    val lastOperation: String,
    val eventTitle: String,
    val eventSubtitle: String,
    val logMessage: String,
)

internal data class CompanionControllerDependencies(
    val connections: ConnectionsPort,
    val session: SessionPort,
    val serviceActions: ServiceActionsPort,
    val routingValidation: RoutingValidationPort,
    val routingWrites: RoutingWritePort,
    val inbounds: InboundsPort,
    val outbounds: OutboundsPort,
    val xraySubscriptions: XraySubscriptionsPort,
    val xrayDat: XrayDatPort,
    val mihomoConfig: MihomoConfigPort,
    val mihomoTemplates: MihomoTemplatesPort,
    val portsEditor: PortsEditorPort,
    val terminal: TerminalPort,
    val logs: LogsPort,
    val logsTransport: LogsTransportPort,
    val journal: CompanionJournalPort,
    val xrayConfigSource: XrayConfigSource,
    val coreStatusSource: CoreStatusSource,
    val xrayLogsControl: XrayLogsControlPort = DemoXrayLogsControlPort(),
    val mihomoNode: MihomoNodePort = DemoMihomoNodePort(),
)

internal fun defaultCompanionControllerDependencies(
    connections: ConnectionsPort = InMemoryConnectionsPort(),
    sessionMaterials: SessionMaterialStore = InMemorySessionMaterialStore(),
    transport: CompanionHttpTransport? = null,
): CompanionControllerDependencies {
    val journal = SystemCompanionJournalPort()
    val authHook = SessionMaterialAuthHook(connections, sessionMaterials)
    val keeneticGatewayAuth = InMemoryKeeneticGatewayAuthStore()
    val effectiveTransport = transport ?: HttpUrlConnectionCompanionTransport(
        authHook = authHook,
        keeneticGatewayAuth = keeneticGatewayAuth,
    )
    val serviceTransport = transport ?: HttpUrlConnectionCompanionTransport(
        config = CompanionHttpTransportConfig(readTimeoutMillis = 90_000),
        authHook = authHook,
        keeneticGatewayAuth = keeneticGatewayAuth,
    )
    val datTransport = transport ?: HttpUrlConnectionCompanionTransport(
        config = CompanionHttpTransportConfig(readTimeoutMillis = 35_000),
        authHook = authHook,
        keeneticGatewayAuth = keeneticGatewayAuth,
    )
    return CompanionControllerDependencies(
        connections = connections,
        session = MobileSessionPort(sessionMaterials, effectiveTransport, keeneticGatewayAuth),
        serviceActions = WebPanelServiceActionsPort(serviceTransport),
        routingValidation = WebPanelRoutingValidationPort(serviceTransport),
        routingWrites = WebPanelRoutingWritePort(serviceTransport),
        inbounds = WebPanelInboundsPort(serviceTransport),
        outbounds = WebPanelOutboundsPort(serviceTransport),
        xraySubscriptions = WebPanelXraySubscriptionsPort(serviceTransport),
        xrayDat = WebPanelXrayDatPort(datTransport),
        mihomoConfig = WebPanelMihomoConfigPort(serviceTransport),
        mihomoTemplates = WebPanelMihomoTemplatesPort(serviceTransport),
        portsEditor = WebPanelPortsEditorPort(serviceTransport),
        terminal = WebPanelTerminalPort(serviceTransport),
        logs = DemoLogsPort(journal),
        logsTransport = WebPanelLogsTransport(effectiveTransport),
        journal = journal,
        xrayConfigSource = WebPanelXrayConfigSource(effectiveTransport),
        coreStatusSource = WebPanelCoreStatusSource(effectiveTransport),
        xrayLogsControl = WebPanelXrayLogsControlPort(serviceTransport),
        mihomoNode = WebPanelMihomoNodePort(serviceTransport),
    )
}

internal class InMemoryConnectionsPort(
    initial: StoredConnections = StoredConnections(),
    private val idFactory: () -> String = { java.util.UUID.randomUUID().toString() },
) : ConnectionsPort {
    private var stored = initial.sanitized()

    override fun load(): StoredConnections = stored

    override fun save(
        draft: ConnectionDraft,
        existing: Connection?,
    ): Connection {
        val connection = connectionFromDraft(
            draft = draft,
            existing = existing,
            idFactory = idFactory,
        )
        stored = stored.copy(
            connections = stored.connections.upsert(connection),
        )
        return connection
    }

    override fun update(connection: Connection) {
        stored = stored.copy(connections = stored.connections.upsert(connection))
    }

    override fun select(connectionId: String) {
        if (stored.connections.any { it.id == connectionId }) {
            stored = stored.copy(selectedConnectionId = connectionId)
        }
    }
}

internal fun connectionFromDraft(
    draft: ConnectionDraft,
    existing: Connection?,
    idFactory: () -> String,
): Connection = existing?.copy(
    name = draft.name.trim(),
    baseUrl = draft.baseUrl.trim(),
) ?: Connection(
    id = idFactory(),
    name = draft.name.trim(),
    baseUrl = draft.baseUrl.trim(),
    status = ConnectionStatus.SetupRequired,
    lastSeen = "Новый черновик",
)

internal fun StoredConnections.sanitized(): StoredConnections {
    val uniqueConnections = connections
        .filter { it.id.isNotBlank() && it.name.isNotBlank() && it.baseUrl.isNotBlank() }
        .distinctBy(Connection::id)
    return copy(
        connections = uniqueConnections,
        selectedConnectionId = selectedConnectionId?.takeIf { selectedId ->
            uniqueConnections.any { it.id == selectedId }
        },
    )
}

internal fun List<Connection>.upsert(connection: Connection): List<Connection> =
    if (any { it.id == connection.id }) {
        map { current -> if (current.id == connection.id) connection else current }
    } else {
        listOf(connection) + this
    }

internal class DemoSessionPort(
    private val sessionMaterials: SessionMaterialStore = InMemorySessionMaterialStore(),
    private val demoSessionSecretFactory: () -> String = ::newDemoSessionSecret,
) : SessionPort {
    override suspend fun pair(connection: Connection): SessionPairResult =
        SessionPairResult.Open(openSession(
            connection = connection,
            lastOperation = "Сопряжение завершено",
            eventTitle = "Сопряжение завершено",
            logMessage = "Сопряжение открыто для ${connection.name}",
        ))

    override suspend fun login(connection: Connection, credentials: LoginForm): SessionOpenResult =
        openSession(
            connection = connection,
            lastOperation = "Вход завершен",
            eventTitle = "Вход выполнен",
            logMessage = "Вход открыт для ${connection.name}",
        )

    override suspend fun restore(connection: Connection): SessionRestoreResult =
        SessionRestoreResult.NotAvailable

    override suspend fun disconnect(connection: Connection): SessionCloseResult =
        expire(connection)

    override fun expire(connection: Connection): SessionCloseResult {
        sessionMaterials.clear(connection.id)
        return SessionCloseResult(
            connection = connection.copy(
                status = ConnectionStatus.NeedsAuth,
                lastSeen = "Сессия закрыта",
            ),
            statusSummary = "Требуется вход",
            logMessage = "Пользователь закрыл мобильную сессию",
        )
    }

    private fun openSession(
        connection: Connection,
        lastOperation: String,
        eventTitle: String,
        logMessage: String,
    ): SessionOpenResult {
        sessionMaterials.save(
            StoredSessionMaterial(
                connectionId = connection.id,
                material = SessionMaterial(accessToken = demoSessionSecretFactory()),
                // A demo credential must never authorize automatic restore. Only MobileSessionPort
                // sets this marker after a real backend bootstrap has returned a valid session.
                trustedForRestore = false,
            ),
        )
        return SessionOpenResult(
            connection = connection.copy(
                status = ConnectionStatus.Configured,
                lastSeen = "Готово",
            ),
            statusSummary = "Готов к безопасному управлению",
            lastOperation = lastOperation,
            eventTitle = eventTitle,
            eventSubtitle = "Сессия открыта без перехода в браузер",
            logMessage = logMessage,
        )
    }
}

private fun newDemoSessionSecret(): String {
    val bytes = ByteArray(32)
    SecureRandom().nextBytes(bytes)
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

internal class DemoServiceActionsPort : ServiceActionsPort {
    override suspend fun switchCore(baseUrl: String, core: String): CoreSwitchResult =
        CoreSwitchResult(
            snapshot = demoSnapshot(activeCore = core, serviceState = ServiceState.Running),
            statusSummary = "Готов к безопасному управлению",
            lastOperation = "Ядро изменено на $core",
            eventTitle = "Ядро изменено",
            eventSubtitle = "$core активно после перезапуска xkeen",
            logMessage = "Ядро изменено на $core; xkeen перезапущен",
        )

    override suspend fun perform(baseUrl: String, action: ServiceAction): ServiceActionResult {
        val serviceState = when (action) {
            ServiceAction.Start -> ServiceState.Running
            ServiceAction.Stop -> ServiceState.Stopped
            ServiceAction.Restart -> ServiceState.Restarting
        }
        val finalState = if (action == ServiceAction.Restart) ServiceState.Running else serviceState
        val lastOperation = when (action) {
            ServiceAction.Start -> "Запрошен запуск сервиса"
            ServiceAction.Stop -> "Сервис безопасно остановлен"
            ServiceAction.Restart -> "Среда выполнения успешно перезапущена"
        }

        return ServiceActionResult(
            snapshot = demoSnapshot(serviceState = finalState),
            statusSummary = if (finalState == ServiceState.Running) {
                "Готов к безопасному управлению"
            } else {
                "Сервис остановлен"
            },
            lastOperation = lastOperation,
            eventTitle = action.label,
            eventSubtitle = lastOperation,
            logMessage = "Подтверждено действие: ${action.label.lowercase()}",
        )
    }

    override suspend fun load(baseUrl: String): ConfirmedServiceSnapshot = demoSnapshot()

    private fun demoSnapshot(
        activeCore: String = "Xray",
        serviceState: ServiceState = ServiceState.Running,
    ): ConfirmedServiceSnapshot = ConfirmedServiceSnapshot(
        serviceState = serviceState,
        activeCore = canonicalCoreName(activeCore) ?: activeCore,
        availableCores = listOf("Xray", "Mihomo"),
    )
}

internal class DemoRoutingWritePort(
    private val journal: CompanionJournalPort,
) : RoutingWritePort {
    override suspend fun save(baseUrl: String, document: RoutingDocument): RoutingSaveResult {
        val savedAt = journal.shortTime()
        val updated = document.copy(
            savedDraftContent = document.draftContent,
            lastSavedAt = savedAt,
        )
        return RoutingSaveResult(
            document = updated,
            validation = RoutingValidation(
                state = RoutingValidationState.Valid,
                message = "Черновик сохранен. Откройте превью или примените, когда будете готовы.",
                details = listOf(
                    "Сохранено в $savedAt",
                    "Опубликованная ревизия не изменится до применения.",
                ),
            ),
            lastOperation = "Черновик маршрутов сохранен в $savedAt",
            logMessage = "Черновик сохранен для ${document.title}",
        )
    }

    override suspend fun apply(baseUrl: String, document: RoutingDocument): RoutingApplyResult {
        val appliedAt = journal.shortTime()
        val updated = document.copy(
            revision = document.revision + 1,
            publishedContent = document.savedDraftContent,
            draftContent = document.savedDraftContent,
            lastAppliedAt = appliedAt,
        )
        return RoutingApplyResult(
            document = updated,
            validation = RoutingValidation(
                state = RoutingValidationState.Valid,
                message = "Применение завершено. Опубликованная ревизия уже активна.",
                details = listOf(
                    "Ревизия r${updated.revision} опубликована в $appliedAt",
                    "В демонстрационной оболочке конфликтов не найдено.",
                ),
            ),
            preview = buildRoutingPreview(updated).copy(
                headline = "Применено к ${updated.title}",
            ),
            lastOperation = "Маршруты применены в $appliedAt",
            eventTitle = "Маршруты применены",
            eventSubtitle = "${updated.title} переведен на ревизию r${updated.revision}",
            logMessage = "Применена ревизия r${updated.revision} для ${updated.title}",
        )
    }
}

internal class DemoLogsPort(
    private val journal: CompanionJournalPort,
) : LogsPort {
    override fun record(
        current: LogsState,
        source: String,
        level: LogLevel,
        message: String,
    ): LogsState {
        val localEntries = current.entries.filterNot(LogEntry::isXrayLogEntry).take(19)
        val remoteEntries = current.entries.filter(LogEntry::isXrayLogEntry)
            .sortedXrayLogsChronologically()
            .asReversed()
            .take(current.displayLimit)
        return current.copy(
            entries = listOf(journal.createEntry(source, level, message)) + localEntries + remoteEntries,
        )
    }
}

internal class SystemCompanionJournalPort : CompanionJournalPort {
    override fun shortTime(): String =
        LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm"))

    override fun longTime(): String =
        LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"))
}
