package io.xkeen.mobile.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.time.LocalTime
import java.time.format.DateTimeFormatter

private enum class SessionFlow(
    val actionLabel: String,
    val eventTitle: String,
    val logLabel: String,
) {
    Pairing(
        actionLabel = "Сопряжение",
        eventTitle = "Сопряжение завершено",
        logLabel = "сопряжение",
    ),
    Login(
        actionLabel = "Вход",
        eventTitle = "Вход выполнен",
        logLabel = "вход",
    ),
}

class DemoCompanionController(
    initialState: CompanionUiState = CompanionUiState(),
) {
    var state by mutableStateOf(initialState)
        private set

    fun finishLaunch() {
        if (state.phase == AppPhase.Launching) {
            state = state.copy(phase = AppPhase.Connections)
        }
    }

    fun updateConnectionDraftName(value: String) {
        state = state.copy(connectionDraft = state.connectionDraft.copy(name = value))
    }

    fun updateConnectionDraftUrl(value: String) {
        state = state.copy(connectionDraft = state.connectionDraft.copy(baseUrl = value))
    }

    fun saveConnectionDraft() {
        val draft = state.connectionDraft
        if (draft.name.isBlank() || draft.baseUrl.isBlank()) {
            return
        }

        val newConnection = Connection(
            id = draft.name.lowercase().replace(" ", "-"),
            name = draft.name.trim(),
            baseUrl = draft.baseUrl.trim(),
            status = ConnectionStatus.SetupRequired,
            lastSeen = "Новый черновик",
        )

        state = state.copy(
            connections = listOf(newConnection) + state.connections,
            connectionDraft = ConnectionDraft(),
        )
    }

    fun selectConnection(connectionId: String) {
        val selected = state.connections.firstOrNull { it.id == connectionId } ?: return
        state = state.copy(
            phase = AppPhase.PairLogin,
            selectedConnectionId = connectionId,
            loginForm = state.loginForm.copy(username = "admin", password = ""),
            dashboard = state.dashboard.copy(
                instanceLabel = selected.name,
                endpoint = selected.baseUrl,
                statusSummary = when (selected.status) {
                    ConnectionStatus.Configured -> "Готов к безопасному управлению"
                    ConnectionStatus.NeedsAuth -> "Требуется вход"
                    ConnectionStatus.SetupRequired -> "Требуется настройка"
                    ConnectionStatus.Offline -> "Офлайн"
                },
            ),
        )
    }

    fun backToConnections() {
        state = state.copy(
            phase = AppPhase.Connections,
            selectedConnectionId = null,
            pendingAction = null,
        )
    }

    fun updateUsername(value: String) {
        state = state.copy(loginForm = state.loginForm.copy(username = value))
    }

    fun updatePassword(value: String) {
        state = state.copy(loginForm = state.loginForm.copy(password = value))
    }

    fun pairDemoDevice() {
        completeSession(SessionFlow.Pairing)
    }

    fun login() {
        completeSession(SessionFlow.Login)
    }

    fun selectTab(tab: MainTab) {
        state = state.copy(mainTab = tab)
    }

    fun requestServiceAction(action: ServiceAction) {
        state = state.copy(pendingAction = PendingAction.Service(action))
    }

    fun requestRoutingApply() {
        val document = selectedRoutingDocument() ?: return
        when {
            state.routing.validation.state != RoutingValidationState.Valid -> validateRouting()
            document.hasUnsavedChanges -> {
                state = state.copy(
                    routing = state.routing.copy(
                        validation = RoutingValidation(
                            state = RoutingValidationState.Dirty,
                            message = "Сначала сохраните черновик перед применением.",
                            details = listOf(
                                "Черновик отличается от последнего сохраненного превью.",
                                "Если измените содержимое после сохранения, проверьте его еще раз.",
                            ),
                        ),
                    ),
                )
            }

            else -> state = state.copy(pendingAction = PendingAction.ApplyRouting)
        }
    }

    fun dismissPendingAction() {
        state = state.copy(pendingAction = null)
    }

    fun confirmPendingAction() {
        when (val action = state.pendingAction) {
            is PendingAction.Service -> {
                performServiceAction(action.action)
                state = state.copy(pendingAction = null)
            }

            PendingAction.ApplyRouting -> {
                applyRouting()
                state = state.copy(pendingAction = null)
            }

            null -> Unit
        }
    }

    fun updateRoutingSearchQuery(query: String) {
        state = state.copy(routing = state.routing.copy(searchQuery = query))
    }

    fun selectRoutingDocument(documentId: String) {
        if (state.routing.selectedDocumentId == documentId) {
            return
        }

        state = state.copy(
            routing = state.routing.copy(
                selectedDocumentId = documentId,
                mode = RoutingMode.Read,
                validation = RoutingValidation(),
                preview = null,
            ),
        )
    }

    fun enterRoutingEditMode() {
        state = state.copy(routing = state.routing.copy(mode = RoutingMode.Edit))
    }

    fun updateRoutingDraft(value: String) {
        val document = selectedRoutingDocument() ?: return
        val updatedDocument = document.copy(draftContent = value)
        state = state.copy(
            routing = state.routing.copy(
                documents = state.routing.documents.replaceDocument(updatedDocument),
                mode = RoutingMode.Edit,
                validation = RoutingValidation(
                    state = RoutingValidationState.Dirty,
                    message = "Черновик изменен. Выполните проверку перед превью или применением.",
                ),
                preview = null,
            ),
        )
    }

    fun revertRoutingDraft() {
        val document = selectedRoutingDocument() ?: return
        val reverted = document.copy(
            draftContent = document.publishedContent,
            savedDraftContent = document.publishedContent,
        )
        state = state.copy(
            routing = state.routing.copy(
                documents = state.routing.documents.replaceDocument(reverted),
                mode = RoutingMode.Read,
                validation = RoutingValidation(
                    message = "Черновик возвращен к опубликованной ревизии.",
                ),
                preview = null,
            ),
        )
    }

    fun validateRouting() {
        val document = selectedRoutingDocument() ?: return
        state = state.copy(
            routing = state.routing.copy(
                validation = validateRoutingDraft(document.draftContent),
            ),
        )
    }

    fun previewRouting() {
        val document = selectedRoutingDocument() ?: return
        val validation = validateRoutingDraft(document.draftContent)
        state = state.copy(routing = state.routing.copy(validation = validation))
        if (validation.state != RoutingValidationState.Valid) {
            return
        }

        state = state.copy(
            routing = state.routing.copy(
                preview = buildRoutingPreview(document),
            ),
        )
    }

    fun saveRouting() {
        val document = selectedRoutingDocument() ?: return
        val savedAt = nowShort()
        val updated = document.copy(
            savedDraftContent = document.draftContent,
            lastSavedAt = savedAt,
        )
        state = state.copy(
            routing = state.routing.copy(
                documents = state.routing.documents.replaceDocument(updated),
                validation = RoutingValidation(
                    state = RoutingValidationState.Valid,
                    message = "Черновик сохранен. Откройте превью или примените, когда будете готовы.",
                    details = listOf(
                        "Сохранено в $savedAt",
                        "Опубликованная ревизия не изменится до применения.",
                    ),
                ),
            ),
            dashboard = state.dashboard.copy(lastOperation = "Черновик маршрутов сохранен в $savedAt"),
            logs = state.logs.prepend(
                LogEntry(nowLong(), "routing", LogLevel.Info, "Черновик сохранен для ${document.title}"),
            ),
        )
    }

    fun updateLogFilter(filter: LogFilter) {
        state = state.copy(logs = state.logs.copy(filter = filter))
    }

    fun disconnect() {
        val connectionId = state.selectedConnectionId ?: return
        val updatedConnections = state.connections.map { connection ->
            if (connection.id == connectionId) {
                connection.copy(status = ConnectionStatus.NeedsAuth, lastSeen = "Сессия закрыта")
            } else {
                connection
            }
        }

        state = state.copy(
            phase = AppPhase.Connections,
            selectedConnectionId = null,
            connections = updatedConnections,
            mainTab = MainTab.Home,
            dashboard = state.dashboard.copy(statusSummary = "Требуется вход"),
            logs = state.logs.prepend(
                LogEntry(nowLong(), "auth", LogLevel.Warning, "Пользователь закрыл мобильную сессию"),
            ),
        )
    }

    private fun completeSession(flow: SessionFlow) {
        val connectionId = state.selectedConnectionId ?: return
        val updatedConnections = state.connections.map { connection ->
            if (connection.id == connectionId) {
                connection.copy(status = ConnectionStatus.Configured, lastSeen = "Готово")
            } else {
                connection
            }
        }
        val selected = updatedConnections.first { it.id == connectionId }
        val eventTime = nowShort()
        val authLog = LogEntry(
            time = nowLong(),
            source = "auth",
            level = LogLevel.Info,
            message = "${flow.logLabel.replaceFirstChar(Char::titlecase)} открыто для ${selected.name}",
        )

        state = state.copy(
            phase = AppPhase.Ready,
            connections = updatedConnections,
            dashboard = state.dashboard.copy(
                instanceLabel = selected.name,
                endpoint = selected.baseUrl,
                statusSummary = "Готов к безопасному управлению",
                lastOperation = "${flow.actionLabel} завершено",
                recentEvents = listOf(
                    RecentEvent(eventTime, flow.eventTitle, "Сессия открыта без перехода в браузер"),
                ) + state.dashboard.recentEvents.take(2),
            ),
            diagnostics = state.diagnostics.replaceDiagnostic(
                label = "Мобильная сессия",
                status = "Готово",
                severity = DiagnosticSeverity.Ok,
            ),
            logs = state.logs.prepend(authLog),
        )
    }

    private fun performServiceAction(action: ServiceAction) {
        val actionTime = nowShort()
        val serviceState = when (action) {
            ServiceAction.Start -> ServiceState.Running
            ServiceAction.Stop -> ServiceState.Stopped
            ServiceAction.Restart -> ServiceState.Restarting
        }
        val finalState = if (action == ServiceAction.Restart) ServiceState.Running else serviceState
        val summary = when (action) {
            ServiceAction.Start -> "Запрошен запуск сервиса"
            ServiceAction.Stop -> "Сервис безопасно остановлен"
            ServiceAction.Restart -> "Среда выполнения успешно перезапущена"
        }

        state = state.copy(
            dashboard = state.dashboard.copy(
                serviceState = finalState,
                statusSummary = if (finalState == ServiceState.Running) {
                    "Готов к безопасному управлению"
                } else {
                    "Сервис остановлен"
                },
                lastOperation = summary,
                recentEvents = listOf(
                    RecentEvent(actionTime, action.label, summary),
                ) + state.dashboard.recentEvents.take(2),
            ),
            logs = state.logs.prepend(
                LogEntry(nowLong(), "service", LogLevel.Info, "Подтверждено действие: ${action.label.lowercase()}"),
            ),
        )
    }

    private fun applyRouting() {
        val document = selectedRoutingDocument() ?: return
        val appliedAt = nowShort()
        val updated = document.copy(
            revision = document.revision + 1,
            publishedContent = document.savedDraftContent,
            draftContent = document.savedDraftContent,
            lastAppliedAt = appliedAt,
        )
        state = state.copy(
            routing = state.routing.copy(
                documents = state.routing.documents.replaceDocument(updated),
                mode = RoutingMode.Read,
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
            ),
            dashboard = state.dashboard.copy(
                lastOperation = "Маршруты применены в $appliedAt",
                recentEvents = listOf(
                    RecentEvent(appliedAt, "Маршруты применены", "${updated.title} переведен на ревизию r${updated.revision}"),
                ) + state.dashboard.recentEvents.take(2),
            ),
            logs = state.logs.prepend(
                LogEntry(nowLong(), "routing", LogLevel.Info, "Применена ревизия r${updated.revision} для ${updated.title}"),
            ),
        )
    }

    private fun selectedRoutingDocument(): RoutingDocument? =
        state.routing.documents.firstOrNull { it.id == state.routing.selectedDocumentId }

    private fun nowShort(): String =
        LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm"))

    private fun nowLong(): String =
        LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"))
}

fun validateRoutingDraft(draft: String): RoutingValidation {
    val details = mutableListOf<String>()

    if (!draft.contains("\"routing\"")) {
        details += "Отсутствует корневой объект routing."
    }
    if (!draft.contains("\"rules\"")) {
        details += "Не найден блок rules."
    }
    if (draft.count { it == '{' } != draft.count { it == '}' }) {
        details += "Количество фигурных скобок не совпадает."
    }
    if (draft.contains("TODO_INVALID")) {
        details += "В черновике все еще есть маркер TODO_INVALID."
    }

    return if (details.isEmpty()) {
        RoutingValidation(
            state = RoutingValidationState.Valid,
            message = "Проверка пройдена. Можно открывать превью и сохранять.",
            details = listOf(
                "объект routing найден",
                "блок rules обнаружен",
                "базовая структура JSON выглядит корректно",
            ),
        )
    } else {
        RoutingValidation(
            state = RoutingValidationState.Invalid,
            message = "Исправьте ${details.size} пункт(а) перед применением.",
            details = details,
        )
    }
}

private fun buildRoutingPreview(document: RoutingDocument): RoutingPreview {
    val outboundMentions = Regex("\"outboundTag\"").findAll(document.draftContent).count()
    val ruleMentions = Regex("\"type\"\\s*:\\s*\"field\"").findAll(document.draftContent).count()

    return RoutingPreview(
        headline = "Превью готово для ${document.title}",
        details = listOf(
            "изменено блоков правил: $ruleMentions",
            "найдено outbound-тегов: $outboundMentions",
            "опубликованная ревизия: r${document.revision}",
            "сохраненное превью готово к применению",
        ),
    )
}

private fun List<RoutingDocument>.replaceDocument(updated: RoutingDocument): List<RoutingDocument> =
    map { document -> if (document.id == updated.id) updated else document }

private fun LogsState.prepend(entry: LogEntry): LogsState =
    copy(entries = listOf(entry) + entries.take(19))

private fun List<DiagnosticItem>.replaceDiagnostic(
    label: String,
    status: String,
    severity: DiagnosticSeverity,
): List<DiagnosticItem> = map { item ->
    if (item.label == label) {
        item.copy(status = status, severity = severity)
    } else {
        item
    }
}
