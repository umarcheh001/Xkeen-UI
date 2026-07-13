package io.xkeen.mobile.app

import java.time.LocalTime
import java.time.format.DateTimeFormatter

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
    fun pair(connection: Connection): SessionOpenResult

    fun login(connection: Connection, credentials: LoginForm): SessionOpenResult

    fun disconnect(connection: Connection): SessionCloseResult
}

internal interface ServiceActionsPort {
    fun switchCore(core: String): CoreSwitchResult

    fun perform(action: ServiceAction): ServiceActionResult
}

internal interface RoutingWritePort {
    fun save(document: RoutingDocument): RoutingSaveResult

    fun apply(document: RoutingDocument): RoutingApplyResult
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
    val activeCore: String,
    val serviceState: ServiceState,
    val statusSummary: String,
    val lastOperation: String,
    val eventTitle: String,
    val eventSubtitle: String,
    val logMessage: String,
)

internal data class ServiceActionResult(
    val serviceState: ServiceState,
    val statusSummary: String,
    val lastOperation: String,
    val eventTitle: String,
    val eventSubtitle: String,
    val logMessage: String,
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
    val routingWrites: RoutingWritePort,
    val logs: LogsPort,
    val journal: CompanionJournalPort,
    val xrayConfigSource: XrayConfigSource,
    val coreStatusSource: CoreStatusSource,
)

internal fun defaultCompanionControllerDependencies(
    connections: ConnectionsPort = InMemoryConnectionsPort(),
    transport: CompanionHttpTransport = HttpUrlConnectionCompanionTransport(),
): CompanionControllerDependencies {
    val journal = SystemCompanionJournalPort()
    return CompanionControllerDependencies(
        connections = connections,
        session = DemoSessionPort(),
        serviceActions = DemoServiceActionsPort(),
        routingWrites = DemoRoutingWritePort(journal),
        logs = DemoLogsPort(journal),
        journal = journal,
        xrayConfigSource = WebPanelXrayConfigSource(transport),
        coreStatusSource = WebPanelCoreStatusSource(transport),
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

internal class DemoSessionPort : SessionPort {
    override fun pair(connection: Connection): SessionOpenResult =
        openSession(
            connection = connection,
            lastOperation = "Сопряжение завершено",
            eventTitle = "Сопряжение завершено",
            logMessage = "Сопряжение открыто для ${connection.name}",
        )

    override fun login(connection: Connection, credentials: LoginForm): SessionOpenResult =
        openSession(
            connection = connection,
            lastOperation = "Вход завершен",
            eventTitle = "Вход выполнен",
            logMessage = "Вход открыт для ${connection.name}",
        )

    override fun disconnect(connection: Connection): SessionCloseResult =
        SessionCloseResult(
            connection = connection.copy(
                status = ConnectionStatus.NeedsAuth,
                lastSeen = "Сессия закрыта",
            ),
            statusSummary = "Требуется вход",
            logMessage = "Пользователь закрыл мобильную сессию",
        )

    private fun openSession(
        connection: Connection,
        lastOperation: String,
        eventTitle: String,
        logMessage: String,
    ): SessionOpenResult =
        SessionOpenResult(
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

internal class DemoServiceActionsPort : ServiceActionsPort {
    override fun switchCore(core: String): CoreSwitchResult =
        CoreSwitchResult(
            activeCore = core,
            serviceState = ServiceState.Running,
            statusSummary = "Готов к безопасному управлению",
            lastOperation = "Ядро изменено на $core",
            eventTitle = "Ядро изменено",
            eventSubtitle = "$core активно после перезапуска xkeen",
            logMessage = "Ядро изменено на $core; xkeen перезапущен",
        )

    override fun perform(action: ServiceAction): ServiceActionResult {
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
            serviceState = finalState,
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
}

internal class DemoRoutingWritePort(
    private val journal: CompanionJournalPort,
) : RoutingWritePort {
    override fun save(document: RoutingDocument): RoutingSaveResult {
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

    override fun apply(document: RoutingDocument): RoutingApplyResult {
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
    ): LogsState = current.copy(
        entries = listOf(journal.createEntry(source, level, message)) + current.entries.take(19),
    )
}

internal class SystemCompanionJournalPort : CompanionJournalPort {
    override fun shortTime(): String =
        LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm"))

    override fun longTime(): String =
        LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"))
}
