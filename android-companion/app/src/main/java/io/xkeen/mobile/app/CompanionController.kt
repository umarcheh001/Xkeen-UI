package io.xkeen.mobile.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

internal class CompanionController(
    initialState: CompanionUiState = CompanionUiState(),
    private val dependencies: CompanionControllerDependencies = defaultCompanionControllerDependencies(),
) {
    var state by mutableStateOf(initialState)
        private set

    fun finishLaunch() {
        if (state.phase == AppPhase.Launching) {
            val stored = dependencies.connections.load().sanitized()
            val selectedConnection = stored.connections.firstOrNull {
                it.id == stored.selectedConnectionId
            }
            state = state.copy(
                phase = AppPhase.Connections,
                connections = stored.connections,
                selectedConnectionId = selectedConnection?.id,
                dashboard = selectedConnection?.let { selected ->
                    state.dashboard.copy(
                        instanceLabel = selected.name,
                        endpoint = selected.baseUrl,
                    )
                } ?: state.dashboard,
            )
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
        if (!draft.canBeSaved()) {
            return
        }

        val existing = draft.editingConnectionId?.let { editingId ->
            state.connections.firstOrNull { it.id == editingId }
        }
        if (draft.isEditing && existing == null) {
            state = state.copy(connectionDraft = ConnectionDraft())
            return
        }
        val savedConnection = dependencies.connections.save(draft, existing)
        val updatedConnections = if (existing == null) {
            listOf(savedConnection) + state.connections
        } else {
            state.connections.replaceConnection(savedConnection)
        }

        state = state.copy(
            connections = updatedConnections,
            connectionDraft = ConnectionDraft(),
        )
    }

    fun editConnection(connectionId: String) {
        val connection = state.connections.firstOrNull { it.id == connectionId } ?: return
        state = state.copy(
            connectionDraft = ConnectionDraft(
                name = connection.name,
                baseUrl = connection.baseUrl,
                editingConnectionId = connection.id,
            ),
        )
    }

    fun cancelConnectionEdit() {
        state = state.copy(connectionDraft = ConnectionDraft())
    }

    fun selectConnection(connectionId: String) {
        val selected = state.connections.firstOrNull { it.id == connectionId } ?: return
        dependencies.connections.select(connectionId)
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
            pendingAction = null,
        )
    }

    fun openConnections() {
        state = state.copy(
            phase = AppPhase.Connections,
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
        val connection = selectedConnection() ?: return
        openSession(dependencies.session.pair(connection))
    }

    fun login() {
        val connection = selectedConnection() ?: return
        openSession(dependencies.session.login(connection, state.loginForm))
    }

    fun selectTab(tab: MainTab) {
        if (!tab.isAvailableFor(state.dashboard.availableCores)) {
            return
        }
        state = state.copy(
            mainTab = tab,
            workspaceSection = tab.defaultWorkspaceSection(),
        )
    }

    fun selectWorkspaceSection(section: WorkspaceSection) {
        if (!section.isAvailableFor(state.dashboard.availableCores)) {
            return
        }
        state = state.copy(
            mainTab = section.tab,
            workspaceSection = section,
        )
    }

    fun switchCore(core: String) {
        val selectedCore = state.dashboard.availableCores.firstOrNull {
            it.equals(core, ignoreCase = true)
        } ?: return
        if (selectedCore.equals(state.dashboard.activeCore, ignoreCase = true)) {
            return
        }

        val switchedAt = dependencies.journal.shortTime()
        val result = dependencies.serviceActions.switchCore(selectedCore)
        state = state.copy(
            dashboard = state.dashboard.copy(
                activeCore = result.activeCore,
                serviceState = result.serviceState,
                statusSummary = result.statusSummary,
                lastOperation = result.lastOperation,
                recentEvents = listOf(
                    RecentEvent(
                        time = switchedAt,
                        title = result.eventTitle,
                        subtitle = result.eventSubtitle,
                    ),
                ) + state.dashboard.recentEvents.take(2),
            ),
            logs = recordLog("service", LogLevel.Info, result.logMessage),
        )
    }

    suspend fun refreshCoreStatus() {
        val result = runCatching {
            dependencies.coreStatusSource.load(state.dashboard.endpoint)
        }
        result.onSuccess(::applyCoreStatus)
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

    suspend fun refreshRoutingDocuments(force: Boolean = false) {
        if (!state.dashboard.availableCores.hasCore("xray")) {
            return
        }
        val routing = state.routing
        if (routing.isRefreshing || (!force && routing.hasAttemptedRemoteLoad)) {
            return
        }

        state = state.copy(
            routing = routing.copy(
                isRefreshing = true,
                hasAttemptedRemoteLoad = true,
                loadError = null,
            ),
        )

        val result = runCatching {
            dependencies.xrayConfigSource.listFragments(state.dashboard.endpoint)
        }
        result.onFailure { error ->
            state = state.copy(
                routing = state.routing.copy(
                    isRefreshing = false,
                    loadError = error.toRoutingLoadMessage(),
                ),
            )
        }
        result.onSuccess { index ->
            if (index.items.isEmpty()) {
                state = state.copy(
                    routing = state.routing.copy(
                        isRefreshing = false,
                        loadError = "На сервере не найдены конфигурации Xray JSON/JSONC.",
                    ),
                )
                return@onSuccess
            }

            val documents = index.items.map { item ->
                RoutingDocument(
                    id = "remote:${item.name}",
                    title = item.name,
                    path = joinRemotePath(index.directory, item.name),
                    summary = item.sizeBytes?.let(::formatFileSize) ?: "Конфигурация Xray",
                    revision = 0,
                    publishedContent = "",
                    draftContent = "",
                    savedDraftContent = "",
                    lastSavedAt = "server",
                    lastAppliedAt = null,
                    sizeBytes = item.sizeBytes,
                    modifiedAtEpochSeconds = item.modifiedAtEpochSeconds,
                    isSensitive = item.sensitive,
                    isLoaded = false,
                )
            }
            val selected = documents.firstOrNull {
                it.title.equals(index.currentName, ignoreCase = true)
            } ?: documents.first()

            state = state.copy(
                routing = state.routing.copy(
                    documents = documents,
                    selectedDocumentId = selected.id,
                    mode = RoutingMode.Read,
                    validation = RoutingValidation(message = "Загружаем ${selected.title} с Xkeen UI…"),
                    preview = null,
                    remoteDirectory = index.directory,
                    isRefreshing = false,
                    loadError = null,
                ),
            )
            loadRoutingDocument(selected.id)
        }
    }

    suspend fun loadSelectedRoutingDocument() {
        loadRoutingDocument(state.routing.selectedDocumentId)
    }

    private suspend fun loadRoutingDocument(documentId: String) {
        val document = state.routing.documents.firstOrNull { it.id == documentId } ?: return
        if (document.isLoaded || document.isLoading) {
            return
        }

        state = state.copy(
            routing = state.routing.copy(
                documents = state.routing.documents.replaceDocument(
                    document.copy(isLoading = true, loadError = null),
                ),
                loadError = null,
            ),
        )

        val result = runCatching {
            dependencies.xrayConfigSource.loadFragment(state.dashboard.endpoint, document.title)
        }
        result.onFailure { error ->
            val message = error.toRoutingLoadMessage()
            val current = state.routing.documents.firstOrNull { it.id == documentId } ?: return@onFailure
            state = state.copy(
                routing = state.routing.copy(
                    documents = state.routing.documents.replaceDocument(
                        current.copy(isLoading = false, loadError = message),
                    ),
                    loadError = message,
                    validation = RoutingValidation(
                        state = RoutingValidationState.Invalid,
                        message = message,
                    ),
                ),
            )
        }
        result.onSuccess { content ->
            val current = state.routing.documents.firstOrNull { it.id == documentId } ?: return@onSuccess
            val loaded = current.copy(
                publishedContent = content.text,
                draftContent = content.text,
                savedDraftContent = content.text,
                usesJsonc = content.usesJsoncSidecar,
                isLoaded = true,
                isLoading = false,
                loadError = null,
            )
            state = state.copy(
                routing = state.routing.copy(
                    documents = state.routing.documents.replaceDocument(loaded),
                    loadError = null,
                    validation = RoutingValidation(
                        message = if (content.usesJsoncSidecar) {
                            "JSONC загружен с Xkeen UI. Комментарии сохранены."
                        } else {
                            "Конфигурация загружена с Xkeen UI."
                        },
                    ),
                ),
            )
        }
    }

    fun enterRoutingEditMode() {
        state = state.copy(routing = state.routing.copy(mode = RoutingMode.Edit))
    }

    fun updateRoutingDraft(value: String) {
        updateRoutingDraft(state.routing.selectedDocumentId, value)
    }

    fun updateRoutingDraft(documentId: String, value: String) {
        val document = state.routing.documents.firstOrNull { it.id == documentId } ?: return
        if (!document.isLoaded) return
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
        val result = dependencies.routingWrites.save(document)
        state = state.copy(
            routing = state.routing.copy(
                documents = state.routing.documents.replaceDocument(result.document),
                validation = result.validation,
            ),
            dashboard = state.dashboard.copy(lastOperation = result.lastOperation),
            logs = recordLog("routing", LogLevel.Info, result.logMessage),
        )
    }

    fun updateLogFilter(filter: LogFilter) {
        state = state.copy(logs = state.logs.copy(filter = filter))
    }

    fun disconnect() {
        val connection = selectedConnection() ?: return
        val result = dependencies.session.disconnect(connection)
        val updatedConnections = state.connections.replaceConnection(result.connection)
        dependencies.connections.update(result.connection)

        state = state.copy(
            phase = AppPhase.Connections,
            connections = updatedConnections,
            mainTab = MainTab.Routing,
            workspaceSection = WorkspaceSection.XrayRouting,
            dashboard = state.dashboard.copy(statusSummary = result.statusSummary),
            logs = recordLog("auth", LogLevel.Warning, result.logMessage),
        )
    }

    private fun openSession(result: SessionOpenResult) {
        val eventTime = dependencies.journal.shortTime()
        val updatedConnections = state.connections.replaceConnection(result.connection)
        dependencies.connections.update(result.connection)
        state = state.copy(
            phase = AppPhase.Ready,
            connections = updatedConnections,
            loginForm = state.loginForm.copy(password = ""),
            dashboard = state.dashboard.copy(
                instanceLabel = result.connection.name,
                endpoint = result.connection.baseUrl,
                statusSummary = result.statusSummary,
                lastOperation = result.lastOperation,
                recentEvents = listOf(
                    RecentEvent(eventTime, result.eventTitle, result.eventSubtitle),
                ) + state.dashboard.recentEvents.take(2),
            ),
            diagnostics = state.diagnostics.replaceDiagnostic(
                label = "Мобильная сессия",
                status = "Готово",
                severity = DiagnosticSeverity.Ok,
            ),
            logs = recordLog("auth", LogLevel.Info, result.logMessage),
        )
    }

    private fun performServiceAction(action: ServiceAction) {
        val actionTime = dependencies.journal.shortTime()
        val result = dependencies.serviceActions.perform(action)

        state = state.copy(
            dashboard = state.dashboard.copy(
                serviceState = result.serviceState,
                statusSummary = result.statusSummary,
                lastOperation = result.lastOperation,
                recentEvents = listOf(
                    RecentEvent(actionTime, result.eventTitle, result.eventSubtitle),
                ) + state.dashboard.recentEvents.take(2),
            ),
            logs = recordLog("service", LogLevel.Info, result.logMessage),
        )
    }

    private fun applyRouting() {
        val document = selectedRoutingDocument() ?: return
        val result = dependencies.routingWrites.apply(document)
        val appliedAt = result.document.lastAppliedAt ?: dependencies.journal.shortTime()
        state = state.copy(
            routing = state.routing.copy(
                documents = state.routing.documents.replaceDocument(result.document),
                mode = RoutingMode.Read,
                validation = result.validation,
                preview = result.preview,
            ),
            dashboard = state.dashboard.copy(
                lastOperation = result.lastOperation,
                recentEvents = listOf(
                    RecentEvent(appliedAt, result.eventTitle, result.eventSubtitle),
                ) + state.dashboard.recentEvents.take(2),
            ),
            logs = recordLog("routing", LogLevel.Info, result.logMessage),
        )
    }

    private fun recordLog(
        source: String,
        level: LogLevel,
        message: String,
    ): LogsState = dependencies.logs.record(
        current = state.logs,
        source = source,
        level = level,
        message = message,
    )

    private fun selectedConnection(): Connection? =
        state.connections.firstOrNull { it.id == state.selectedConnectionId }

    private fun selectedRoutingDocument(): RoutingDocument? =
        state.routing.documents.firstOrNull { it.id == state.routing.selectedDocumentId }

    private fun applyCoreStatus(coreStatus: CoreStatus) {
        val availableCores = coreStatus.availableCores
        val activeCore = coreStatus.currentCore
            ?.takeIf { availableCores.hasCore(it) }
            ?: state.dashboard.activeCore.takeIf { availableCores.hasCore(it) }
            ?: availableCores.first()
        val currentSection = state.workspaceSection
        val section = if (currentSection.isAvailableFor(availableCores)) {
            currentSection
        } else {
            preferredCoreTab(activeCore, availableCores).defaultWorkspaceSection()
        }

        state = state.copy(
            mainTab = section.tab,
            workspaceSection = section,
            dashboard = state.dashboard.copy(
                activeCore = activeCore,
                availableCores = availableCores,
            ),
        )
    }
}

internal fun ConnectionDraft.canBeSaved(): Boolean {
    val normalizedUrl = baseUrl.trim()
    val hasSupportedScheme = normalizedUrl.startsWith("http://", ignoreCase = true) ||
        normalizedUrl.startsWith("https://", ignoreCase = true)
    return name.isNotBlank() &&
        hasSupportedScheme &&
        normalizedUrl.substringAfter("://", missingDelimiterValue = "").isNotBlank()
}

private fun preferredCoreTab(activeCore: String, availableCores: List<String>): MainTab =
    when {
        activeCore.equals("Mihomo", ignoreCase = true) && availableCores.hasCore("mihomo") -> MainTab.Home
        availableCores.hasCore("xray") -> MainTab.Routing
        availableCores.hasCore("mihomo") -> MainTab.Home
        else -> MainTab.More
    }

fun validateRoutingDraft(draft: String): RoutingValidation {
    val details = mutableListOf<String>()

    if (!draft.contains("\"routing\"")) {
        details += "No routing object found."
    }
    if (!draft.contains("\"rules\"")) {
        details += "No rules block found."
    }
    if (draft.count { it == '{' } != draft.count { it == '}' }) {
        details += "Brace count does not match."
    }
    if (draft.contains("TODO_INVALID")) {
        details += "Draft still contains TODO_INVALID marker."
    }

    return if (details.isEmpty()) {
        RoutingValidation(
            state = RoutingValidationState.Valid,
            message = "Проверка пройдена. Можно открывать превью и сохранять.",
            details = listOf(
                "routing object found",
                "rules block found",
                "basic JSON structure looks valid",
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

internal fun buildRoutingPreview(document: RoutingDocument): RoutingPreview {
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

private fun List<Connection>.replaceConnection(updated: Connection): List<Connection> =
    map { connection -> if (connection.id == updated.id) updated else connection }

private fun Throwable.toRoutingLoadMessage(): String =
    message?.takeIf { it.isNotBlank() } ?: "Не удалось загрузить конфигурации с Xkeen UI."

private fun joinRemotePath(directory: String, filename: String): String =
    if (directory.isBlank()) filename else "${directory.trimEnd('/')}/$filename"

private fun formatFileSize(bytes: Long): String =
    when {
        bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
        bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
        else -> "$bytes B"
    }

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
