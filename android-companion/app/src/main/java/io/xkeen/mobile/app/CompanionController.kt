package io.xkeen.mobile.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

private const val XRAY_DAT_READ_TIMEOUT_MILLIS = 35_000L

internal class CompanionController(
    initialState: CompanionUiState = CompanionUiState(),
    private val dependencies: CompanionControllerDependencies = defaultCompanionControllerDependencies(),
) {
    var state by mutableStateOf(initialState)
        private set

    /**
     * A controller-owned guard remains active even if an edit or document switch changes the
     * visible validation state from [RoutingValidationState.Validating] to [RoutingValidationState.Dirty].
     */
    private var activeRoutingValidationRequest: RoutingValidationRequest? = null
    private var logsTransportGeneration: Long = 0
    private var xrayLogsControlGeneration: Long = 0
    private val logCursors = mutableMapOf<String, String>()
    private val xrayLogDomainResolver = XrayLogDomainResolver()

    private data class RoutingValidationRequest(
        val documentId: String,
        val draftContent: String,
        val connectionId: String?,
        val endpoint: String,
    )

    suspend fun finishLaunch() {
        if (state.phase != AppPhase.Launching) return

        val stored = dependencies.connections.load().sanitized()
        val selectedConnection = stored.connections.firstOrNull {
            it.id == stored.selectedConnectionId
        }
        state = state.copy(
            connections = stored.connections,
            selectedConnectionId = selectedConnection?.id,
            isSessionBusy = selectedConnection != null,
            sessionMessage = null,
            dashboard = selectedConnection?.let { selected ->
                state.dashboard.copy(
                    instanceLabel = selected.name,
                    endpoint = selected.baseUrl,
                )
            } ?: state.dashboard,
        )
        if (selectedConnection == null) {
            state = state.copy(phase = AppPhase.Connections, isSessionBusy = false)
            return
        }

        try {
            when (val restored = dependencies.session.restore(selectedConnection)) {
                SessionRestoreResult.NotAvailable -> closeSession(
                    result = dependencies.session.expire(selectedConnection),
                    phase = AppPhase.PairLogin,
                    message = "Сохраненная мобильная сессия не найдена. Войдите снова.",
                )

                is SessionRestoreResult.Open -> openSession(restored.result)

                is SessionRestoreResult.AuthRequired -> closeSession(
                    result = restored.result,
                    phase = AppPhase.PairLogin,
                    message = "Срок мобильной сессии истек. Войдите снова.",
                )
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!requireKeeneticLogin(error, "Не удалось подтвердить сохраненную сессию")) {
                state = state.copy(
                    phase = AppPhase.PairLogin,
                    isSessionBusy = false,
                    sessionMessage = "Не удалось подтвердить сохраненную сессию: ${sessionErrorMessage(error)}",
                    dashboard = state.dashboard.copy(statusSummary = "Не удалось восстановить сессию"),
                )
            }
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
            keeneticLoginForm = LoginForm(),
            isKeeneticAuthRequired = false,
            isSessionBusy = false,
            sessionMessage = null,
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
        if (state.serviceOperation.isPending) return
        state = state.copy(
            phase = AppPhase.Connections,
            pendingAction = null,
            isSessionBusy = false,
            sessionMessage = null,
        )
    }

    fun openConnections() {
        if (state.serviceOperation.isPending) return
        state = state.copy(
            phase = AppPhase.Connections,
            pendingAction = null,
            isSessionBusy = false,
            sessionMessage = null,
        )
    }

    fun updateUsername(value: String) {
        state = state.copy(loginForm = state.loginForm.copy(username = value))
    }

    fun updatePassword(value: String) {
        state = state.copy(loginForm = state.loginForm.copy(password = value))
    }

    fun updateKeeneticUsername(value: String) {
        state = state.copy(keeneticLoginForm = state.keeneticLoginForm.copy(username = value))
    }

    fun updateKeeneticPassword(value: String) {
        state = state.copy(keeneticLoginForm = state.keeneticLoginForm.copy(password = value))
    }

    suspend fun pair() {
        val connection = selectedConnection() ?: return
        if (state.isSessionBusy) return
        state = state.copy(
            isSessionBusy = true,
            sessionMessage = "Проверяем доступность узла…",
        )

        try {
            when (val result = dependencies.session.pair(connection)) {
                is SessionPairResult.Open -> openSession(result.result)
                is SessionPairResult.Status -> updateSessionStatus(result)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!requireKeeneticLogin(error, "Не удалось проверить узел")) {
                sessionFailed(error, "Не удалось проверить узел")
            }
        }
    }

    suspend fun authorizeKeenetic() {
        val connection = selectedConnection() ?: return
        if (state.isSessionBusy) return
        state = state.copy(
            isSessionBusy = true,
            sessionMessage = "Входим в Keenetic и продолжаем проверку…",
        )

        try {
            when (val result = dependencies.session.authorizeKeenetic(connection, state.keeneticLoginForm)) {
                is SessionPairResult.Open -> openSession(result.result)
                is SessionPairResult.Status -> updateSessionStatus(result)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!requireKeeneticLogin(error, "Не удалось войти в Keenetic")) {
                sessionFailed(error, "Не удалось войти в Keenetic")
            }
        }
    }

    suspend fun login() {
        val connection = selectedConnection() ?: return
        if (state.isSessionBusy) return
        state = state.copy(
            isSessionBusy = true,
            sessionMessage = "Проверяем данные и открываем сессию…",
        )

        try {
            openSession(dependencies.session.login(connection, state.loginForm))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!requireKeeneticLogin(error, "Не удалось выполнить вход")) {
                sessionFailed(error, "Не удалось выполнить вход")
            }
        }
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

    suspend fun switchCore(core: String) {
        if (state.serviceOperation.isPending || state.isWorkspaceRefreshing) return
        val selectedCore = state.dashboard.availableCores.firstOrNull {
            it.equals(core, ignoreCase = true)
        } ?: return
        if (selectedCore.equals(state.dashboard.activeCore, ignoreCase = true)) {
            return
        }

        val endpoint = state.dashboard.endpoint
        state = state.copy(
            pendingAction = null,
            serviceOperation = ServiceOperationState(
                phase = ServiceOperationPhase.Pending,
                targetCore = selectedCore,
                message = "Переключаем ядро на $selectedCore и ждём подтверждение сервера…",
            ),
            dashboard = state.dashboard.copy(
                statusSummary = "Переключение ядра выполняется",
                lastOperation = "Ожидаем подтверждение ядра $selectedCore",
                lastError = null,
            ),
        )

        try {
            val result = dependencies.serviceActions.switchCore(endpoint, selectedCore)
            val switchedAt = dependencies.journal.shortTime()
            applyConfirmedServiceSnapshot(result.snapshot)
            state = state.copy(
                serviceOperation = ServiceOperationState(
                    phase = ServiceOperationPhase.Success,
                    targetCore = result.snapshot.activeCore,
                    message = result.statusSummary,
                ),
                dashboard = state.dashboard.copy(
                    statusSummary = result.statusSummary,
                    lastOperation = result.lastOperation,
                    lastError = null,
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
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            serviceOperationFailed(
                endpoint = endpoint,
                error = error,
                fallback = "Не удалось переключить ядро на $selectedCore.",
                targetCore = selectedCore,
            )
        }
    }

    suspend fun refreshCoreStatus() {
        if (state.dashboard.endpoint.isBlank()) return
        val result = runCatching {
            dependencies.coreStatusSource.load(state.dashboard.endpoint)
        }
        result.onSuccess { coreStatus ->
            applyCoreStatus(coreStatus)
            state = state.copy(
                dashboard = state.dashboard.copy(lastError = null),
            )
        }
        result.onFailure { error ->
            if (!returnToLoginForExpiredSession(error)) {
                applyCoreStatusLoadFailure(error)
            }
        }
    }

    /** Loads the only runtime state shown after opening a real mobile session. */
    suspend fun refreshWorkspaceSnapshot(): Boolean {
        val endpoint = state.dashboard.endpoint
        if (endpoint.isBlank()) return false
        return try {
            val snapshot = dependencies.serviceActions.load(endpoint)
            applyConfirmedServiceSnapshot(snapshot)
            state = state.copy(
                dashboard = state.dashboard.copy(
                    statusSummary = snapshot.serviceState.workspaceStatusSummary(),
                    lastError = null,
                ),
            )
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!returnToLoginForExpiredSession(error)) {
                applyCoreStatusLoadFailure(error)
            }
            false
        }
    }

    /** Refreshes confirmed runtime state and the server-backed data visible on the current screen. */
    suspend fun refreshWorkspaceFromServer() {
        val endpoint = state.dashboard.endpoint
        if (
            endpoint.isBlank() ||
            state.phase != AppPhase.Ready ||
            state.isSessionBusy ||
            state.isWorkspaceRefreshing ||
            state.serviceOperation.isPending
        ) {
            return
        }

        state = state.copy(isWorkspaceRefreshing = true)
        try {
            val runtimeRefreshed = refreshWorkspaceSnapshot()
            if (runtimeRefreshed && state.phase == AppPhase.Ready && state.dashboard.endpoint == endpoint) {
                refreshVisibleWorkspaceContent()
            }
        } finally {
            state = state.copy(isWorkspaceRefreshing = false)
        }
    }

    private suspend fun refreshVisibleWorkspaceContent() {
        when (state.workspaceSection) {
            WorkspaceSection.XrayRouting -> {
                val selected = state.routing.documents.firstOrNull {
                    it.id == state.routing.selectedDocumentId
                }
                if (selected?.hasDraftChanges != true) {
                    refreshRoutingDocuments(force = true)
                }
            }

            WorkspaceSection.XrayInbounds -> {
                if (!state.inbounds.hasChanges) refreshInbounds(force = true)
            }

            WorkspaceSection.XrayOutbounds -> {
                if (!state.outbounds.editor.isOpen && !state.outbounds.poolEditor.isOpen) {
                    refreshOutbounds(force = true)
                }
            }

            WorkspaceSection.XraySubscriptions -> {
                if (!state.xraySubscriptions.editor.isOpen) {
                    refreshXraySubscriptions(force = true)
                }
            }

            WorkspaceSection.XrayAssets -> refreshXrayDatCatalog(force = true)
            WorkspaceSection.XrayLogs -> refreshXrayLogsStatus()
            WorkspaceSection.MihomoRouting -> {
                if (!state.mihomoConfig.hasChanges) refreshMihomoConfig(force = true)
            }

            WorkspaceSection.MihomoTemplates -> refreshMihomoTemplates(force = true)

            WorkspaceSection.PortsOverview -> {
                if (state.portsEditor.selectedDocument?.hasChanges != true) {
                    loadSelectedPortsDocument(force = true)
                }
            }

            else -> Unit
        }
    }

    fun requestServiceAction(action: ServiceAction) {
        if (state.serviceOperation.isPending || state.isWorkspaceRefreshing || state.pendingAction != null) return
        state = state.copy(pendingAction = PendingAction.Service(action))
    }

    fun requestRoutingApply() {
        val document = selectedRoutingDocument() ?: return
        when {
            state.routing.isValidationInFlight ||
                state.routing.validation.isPending ||
                state.routing.write.isPending -> return

            state.routing.write.phase == RoutingWritePhase.Conflict -> return

            state.routing.validation.state != RoutingValidationState.Valid -> {
                if (state.routing.validation.state in setOf(
                        RoutingValidationState.Idle,
                        RoutingValidationState.Dirty,
                    )
                ) {
                    state = state.copy(
                        routing = state.routing.copy(
                            validation = state.routing.validation.copy(
                                state = RoutingValidationState.Dirty,
                                message = "Перед применением выполните проверку на сервере.",
                            ),
                        ),
                    )
                }
            }

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

            !document.hasServerSavedDraft -> {
                state = state.copy(
                    routing = state.routing.copy(
                        write = RoutingWriteState(
                            phase = RoutingWritePhase.Failure,
                            code = "nothing_to_apply",
                            message = "Сначала сохраните проверенный черновик на сервере.",
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

    fun dismissServiceOperationResult() {
        if (!state.serviceOperation.isPending) {
            state = state.copy(serviceOperation = ServiceOperationState())
        }
    }

    /** Clears the short-lived confirmation shown after a routing save or apply succeeds. */
    fun dismissRoutingWriteResult() {
        if (state.routing.write.phase == RoutingWritePhase.Success) {
            state = state.copy(routing = state.routing.copy(write = RoutingWriteState()))
        }
    }

    suspend fun confirmPendingAction() {
        when (val action = state.pendingAction) {
            is PendingAction.Service -> {
                state = state.copy(pendingAction = null)
                performServiceAction(action.action)
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
                write = RoutingWriteState(),
            ),
        )
    }

    suspend fun refreshRoutingDocuments(force: Boolean = false) {
        if (state.dashboard.endpoint.isBlank()) {
            return
        }
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
            if (returnToLoginForExpiredSession(error)) {
                return@onFailure
            }
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

    suspend fun refreshInbounds(force: Boolean = false) {
        val endpoint = state.dashboard.endpoint
        if (endpoint.isBlank() || !state.dashboard.availableCores.hasCore("xray")) return
        val current = state.inbounds
        if (current.isLoading || current.isApplying || (!force && current.hasLoaded)) return
        state = state.copy(
            inbounds = current.copy(
                isLoading = true,
                message = "Загружаем режим inbounds с Xkeen UI…",
                error = null,
            ),
        )
        try {
            val index = dependencies.inbounds.listFragments(endpoint)
            val selected = current.selectedFragment.takeIf { name ->
                index.items.any { it.name == name }
            } ?: index.currentName.takeIf { name ->
                index.items.any { it.name == name }
            } ?: index.items.firstOrNull()?.name
            if (selected.isNullOrBlank()) {
                throw InboundsException("Сервер не вернул ни одного файла 03_inbounds*.json.")
            }
            val snapshot = dependencies.inbounds.load(endpoint, selected)
            if (state.dashboard.endpoint != endpoint) return
            state = state.copy(
                inbounds = state.inbounds.fromServer(
                    index = index,
                    snapshot = snapshot,
                    selectedFragment = selected,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishInboundsFailure(error, "Не удалось загрузить режим inbounds.")
        }
    }

    suspend fun selectInboundsFragment(filename: String) {
        val endpoint = state.dashboard.endpoint
        val current = state.inbounds
        if (endpoint.isBlank() || current.isLoading || current.isApplying) return
        if (current.fragments.none { it.name == filename }) return
        state = state.copy(
            inbounds = current.copy(
                selectedFragment = filename,
                isLoading = true,
                message = "Загружаем $filename…",
                error = null,
            ),
        )
        try {
            val snapshot = dependencies.inbounds.load(endpoint, filename)
            if (state.dashboard.endpoint != endpoint || state.inbounds.selectedFragment != filename) return
            val path = snapshot.path.ifBlank {
                current.activePath.substringBeforeLast('/', "")
                    .takeIf(String::isNotBlank)
                    ?.let { "$it/$filename" }
                    ?: filename
            }
            state = state.copy(
                inbounds = state.inbounds.copy(
                    activePath = path,
                    appliedMode = snapshot.mode,
                    selectedMode = snapshot.mode,
                    rawServerMode = snapshot.rawMode,
                    isLoading = false,
                    hasLoaded = true,
                    message = snapshot.inboundsStatusMessage(),
                    error = null,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishInboundsFailure(error, "Не удалось загрузить $filename.")
        }
    }

    fun selectInboundsMode(mode: InboundsMode) {
        if (state.inbounds.isLoading || state.inbounds.isApplying) return
        state = state.copy(
            inbounds = state.inbounds.copy(
                selectedMode = mode,
                message = if (mode == state.inbounds.appliedMode) {
                    "${mode.displayName} уже активен."
                } else {
                    "Выбран ${mode.displayName}. Нажмите «Применить режим»."
                },
                error = null,
            ),
        )
    }

    fun updateInboundsRestartAfterApply(enabled: Boolean) {
        if (state.inbounds.isApplying) return
        state = state.copy(inbounds = state.inbounds.copy(restartAfterApply = enabled))
    }

    suspend fun applyInboundsMode() {
        val endpoint = state.dashboard.endpoint
        val current = state.inbounds
        val mode = current.selectedMode ?: return
        val filename = current.selectedFragment
        if (endpoint.isBlank() || filename.isBlank() || current.isLoading || current.isApplying || !current.hasChanges) {
            return
        }
        state = state.copy(
            inbounds = current.copy(
                isApplying = true,
                message = if (current.restartAfterApply) {
                    "Применяем ${mode.displayName} и перезапускаем Xkeen…"
                } else {
                    "Сохраняем режим ${mode.displayName}…"
                },
                error = null,
            ),
        )
        try {
            val result = dependencies.inbounds.apply(
                baseUrl = endpoint,
                filename = filename,
                mode = mode,
                restart = current.restartAfterApply,
            )
            if (state.dashboard.endpoint != endpoint || state.inbounds.selectedFragment != filename) return
            val restartFailed = result.restartRequested && !result.restarted
            val message = when {
                restartFailed -> "${result.mode.displayName} сохранён, но сервер не подтвердил перезапуск Xkeen."
                result.restarted -> "${result.mode.displayName} применён; Xkeen перезапущен."
                else -> "${result.mode.displayName} сохранён без перезапуска Xkeen."
            }
            state = state.copy(
                inbounds = state.inbounds.copy(
                    appliedMode = result.mode,
                    selectedMode = result.mode,
                    rawServerMode = result.rawMode,
                    isApplying = false,
                    hasLoaded = true,
                    message = message,
                    error = message.takeIf { restartFailed },
                ),
                dashboard = state.dashboard.copy(
                    lastOperation = "Режим inbounds: ${result.mode.displayName}",
                    lastError = message.takeIf { restartFailed },
                ),
                logs = recordLog(
                    "inbounds",
                    if (restartFailed) LogLevel.Warning else LogLevel.Info,
                    message,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishInboundsFailure(error, "Не удалось применить режим inbounds.")
        }
    }

    suspend fun refreshOutbounds(force: Boolean = false) {
        val endpoint = state.dashboard.endpoint
        if (endpoint.isBlank() || !state.dashboard.availableCores.hasCore("xray")) return
        val current = state.outbounds
        if (current.isBusy || (!force && current.hasLoaded)) return
        state = state.copy(
            outbounds = current.copy(
                isLoading = true,
                message = "Загружаем proxy-узлы с Xkeen UI…",
                error = null,
            ),
        )
        try {
            val index = dependencies.outbounds.listFragments(endpoint)
            val selected = current.selectedFragment.takeIf { name ->
                index.items.any { it.name == name }
            } ?: index.currentName.takeIf { name ->
                index.items.any { it.name == name }
            } ?: index.items.firstOrNull()?.name
            if (selected.isNullOrBlank()) {
                throw OutboundsException("Сервер не вернул ни одного файла 04_outbounds*.json.")
            }
            val snapshot = dependencies.outbounds.load(endpoint, selected)
            val active = loadActiveOutboundOrNull(endpoint, selected)
            if (state.dashboard.endpoint != endpoint) return
            state = state.copy(
                outbounds = state.outbounds.fromServer(index, snapshot, selected, active),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishOutboundsFailure(error, "Не удалось загрузить proxy-узлы.")
        }
    }

    suspend fun selectOutboundsFragment(filename: String) {
        val endpoint = state.dashboard.endpoint
        val current = state.outbounds
        if (endpoint.isBlank() || current.isBusy || current.fragments.none { it.name == filename }) return
        state = state.copy(
            outbounds = current.copy(
                selectedFragment = filename,
                isLoading = true,
                editor = OutboundEditorState(restartAfterSave = current.editor.restartAfterSave),
                poolEditor = OutboundPoolEditorState(
                    restartAfterSave = current.poolEditor.restartAfterSave,
                    replacePool = false,
                ),
                message = "Загружаем $filename…",
                error = null,
            ),
        )
        try {
            val snapshot = dependencies.outbounds.load(endpoint, filename)
            val active = loadActiveOutboundOrNull(endpoint, filename)
            if (state.dashboard.endpoint != endpoint || state.outbounds.selectedFragment != filename) return
            state = state.copy(
                outbounds = state.outbounds.copy(
                    activePath = snapshot.path,
                    nodes = snapshot.nodes.sortWithActiveFirst(active),
                    activeNodeKey = active?.key,
                    activeNodeTag = active?.tag,
                    activeMessage = active?.message,
                    isLoading = false,
                    hasLoaded = true,
                    message = snapshot.outboundsStatusMessage(),
                    error = null,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishOutboundsFailure(error, "Не удалось загрузить $filename.")
        }
    }

    suspend fun pingOutbound(nodeKey: String) {
        val endpoint = state.dashboard.endpoint
        val current = state.outbounds
        val node = current.nodes.firstOrNull { it.key == nodeKey } ?: return
        if (endpoint.isBlank() || current.isLoading || current.isPingingAll || nodeKey in current.pingingNodeKeys) return
        state = state.copy(
            outbounds = current.copy(
                pingingNodeKeys = current.pingingNodeKeys + nodeKey,
                message = "Проверяем ${node.displayName}…",
                error = null,
            ),
        )
        try {
            val latency = dependencies.outbounds.ping(endpoint, current.selectedFragment, nodeKey)
            if (state.dashboard.endpoint != endpoint || state.outbounds.selectedFragment != current.selectedFragment) return
            state = state.copy(
                outbounds = state.outbounds.copy(
                    nodes = state.outbounds.nodes.withLatency(mapOf(nodeKey to latency)),
                    pingingNodeKeys = state.outbounds.pingingNodeKeys - nodeKey,
                    message = latency.delayMillis?.let { "${node.displayName}: $it мс." }
                        ?: "Проверка ${node.displayName} завершена.",
                    error = latency.message.takeIf { latency.status == "error" },
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishOutboundsFailure(error, "Не удалось проверить ${node.displayName}.", nodeKey)
        }
    }

    suspend fun pingAllOutbounds() {
        val endpoint = state.dashboard.endpoint
        val current = state.outbounds
        val keys = current.nodes.map(OutboundNode::key).filter(String::isNotBlank)
        if (endpoint.isBlank() || current.isBusy || keys.isEmpty()) return
        state = state.copy(
            outbounds = current.copy(
                isPingingAll = true,
                pingingNodeKeys = keys.toSet(),
                message = "Проверяем задержку: ${keys.size} proxy-узлов…",
                error = null,
            ),
        )
        try {
            val latency = dependencies.outbounds.pingAll(endpoint, current.selectedFragment, keys)
            if (state.dashboard.endpoint != endpoint || state.outbounds.selectedFragment != current.selectedFragment) return
            val successful = latency.values.count { it.delayMillis != null }
            val failed = latency.values.count { it.status == "error" }
            state = state.copy(
                outbounds = state.outbounds.copy(
                    nodes = state.outbounds.nodes.withLatency(latency),
                    isPingingAll = false,
                    pingingNodeKeys = emptySet(),
                    message = if (failed == 0) {
                        "Проверено proxy-узлов: $successful."
                    } else {
                        "Доступно $successful из ${keys.size}; ошибок: $failed."
                    },
                    error = null,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishOutboundsFailure(error, "Не удалось проверить proxy-узлы.")
        }
    }

    suspend fun openOutboundsEditor() {
        val endpoint = state.dashboard.endpoint
        val current = state.outbounds
        val filename = current.selectedFragment
        if (endpoint.isBlank() || filename.isBlank() || current.isBusy) return
        if (current.nodes.size > 1) {
            state = state.copy(
                outbounds = current.copy(
                    editor = OutboundEditorState(
                        isOpen = true,
                        error = "Этот фрагмент содержит пул из ${current.nodes.size} узлов. Single-link редактор не перезаписывает пулы.",
                    ),
                ),
            )
            return
        }
        state = state.copy(
            outbounds = current.copy(
                editor = OutboundEditorState(
                    isOpen = true,
                    isLoading = true,
                    restartAfterSave = current.editor.restartAfterSave,
                    message = "Читаем текущую proxy-ссылку…",
                ),
            ),
        )
        try {
            val snapshot = dependencies.outbounds.loadLink(endpoint, filename)
            if (state.dashboard.endpoint != endpoint || state.outbounds.selectedFragment != filename) return
            val url = snapshot.url.orEmpty()
            val customSingleNode = current.nodes.size == 1 && url.isBlank()
            val managedFragment = snapshot.managedKind != null
            state = state.copy(
                outbounds = state.outbounds.copy(
                    activePath = snapshot.path.ifBlank { state.outbounds.activePath },
                    editor = OutboundEditorState(
                        isOpen = true,
                        canEdit = !customSingleNode && !managedFragment,
                        isExistingLink = url.isNotBlank(),
                        draftUrl = url,
                        savedUrl = url,
                        draftTag = snapshot.outboundTag,
                        savedTag = snapshot.outboundTag,
                        sourceFingerprint = snapshot.sourceFingerprint,
                        restartAfterSave = state.outbounds.editor.restartAfterSave,
                        preview = previewOutboundLink(url),
                        message = if (url.isBlank() && !customSingleNode && !managedFragment) {
                            "Добавьте новую proxy-ссылку в пустой фрагмент."
                        } else if (customSingleNode) {
                            null
                        } else {
                            "Ссылка загружена только в память редактора. Секреты не сохраняются на устройстве."
                        },
                        error = when {
                            managedFragment -> "Это generated-фрагмент ${if (snapshot.managedKind == "subscription") "подписки" else "пула"}. Single-link редактор не перезаписывает управляемые фрагменты."
                            customSingleNode -> "Текущий узел нельзя представить одной поддерживаемой ссылкой. Используйте JSON-редактор веб-панели."
                            else -> null
                        },
                    ),
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishOutboundsEditorFailure(error, "Не удалось открыть редактор proxy-ссылки.")
        }
    }

    fun updateOutboundDraftUrl(value: String) {
        val editor = state.outbounds.editor
        if (!editor.isOpen || editor.isLoading || editor.isSaving || !editor.canEdit) return
        state = state.copy(
            outbounds = state.outbounds.copy(
                editor = editor.copy(
                    draftUrl = value,
                    preview = previewOutboundLink(value),
                    message = null,
                    error = null,
                ),
            ),
        )
    }

    fun updateOutboundDraftTag(value: String) {
        val editor = state.outbounds.editor
        if (!editor.isOpen || editor.isLoading || editor.isSaving || !editor.canEdit) return
        state = state.copy(
            outbounds = state.outbounds.copy(
                editor = editor.copy(draftTag = value.take(96), message = null, error = null),
            ),
        )
    }

    fun normalizeOutboundDraft() {
        val editor = state.outbounds.editor
        if (!editor.isOpen || editor.isLoading || editor.isSaving || !editor.canEdit) return
        val normalized = normalizeOutboundLink(editor.draftUrl)
        state = state.copy(
            outbounds = state.outbounds.copy(
                editor = if (normalized == null) {
                    editor.copy(error = "Не удалось нормализовать ссылку. Проверьте формат.", message = null)
                } else {
                    editor.copy(
                        draftUrl = normalized,
                        draftTag = cleanOutboundTag(editor.draftTag),
                        preview = previewOutboundLink(normalized),
                        message = "Ссылка нормализована локально. На сервер она ещё не отправлена.",
                        error = null,
                    )
                },
            ),
        )
    }

    fun updateOutboundsRestartAfterSave(enabled: Boolean) {
        val editor = state.outbounds.editor
        if (!editor.isOpen || editor.isSaving) return
        state = state.copy(outbounds = state.outbounds.copy(editor = editor.copy(restartAfterSave = enabled)))
    }

    fun closeOutboundsEditor() {
        if (state.outbounds.editor.isSaving) return
        state = state.copy(
            outbounds = state.outbounds.copy(
                editor = OutboundEditorState(
                    restartAfterSave = state.outbounds.editor.restartAfterSave,
                ),
            ),
        )
    }

    suspend fun openOutboundsPoolEditor() {
        val endpoint = state.dashboard.endpoint
        val current = state.outbounds
        val filename = current.selectedFragment
        if (endpoint.isBlank() || filename.isBlank() || current.isBusy) return
        state = state.copy(
            outbounds = current.copy(
                poolEditor = OutboundPoolEditorState(
                    isOpen = true,
                    isLoading = true,
                    restartAfterSave = current.poolEditor.restartAfterSave,
                    replacePool = false,
                    message = "Проверяем выбранный outbounds-фрагмент…",
                ),
            ),
        )
        try {
            val snapshot = dependencies.outbounds.loadLink(endpoint, filename)
            if (state.dashboard.endpoint != endpoint || state.outbounds.selectedFragment != filename) return
            val subscriptionManaged = snapshot.managedKind == "subscription"
            state = state.copy(
                outbounds = state.outbounds.copy(
                    poolEditor = state.outbounds.poolEditor.copy(
                        isLoading = false,
                        canEdit = !subscriptionManaged,
                        sourceFingerprint = snapshot.sourceFingerprint,
                        message = if (subscriptionManaged) null else {
                            "Добавьте готовые ссылки. Текущие узлы не загружаются в черновик и сохраняются в режиме добавления."
                        },
                        error = if (subscriptionManaged) {
                            "Generated-фрагмент подписки управляется сервером и не может быть перезаписан ручным пулом."
                        } else {
                            null
                        },
                    ),
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishOutboundsPoolEditorFailure(error, "Не удалось открыть создание proxy-пула.")
        }
    }

    fun updateOutboundPoolInput(value: String) {
        val editor = state.outbounds.poolEditor
        if (!editor.isOpen || editor.isLoading || editor.isSaving || !editor.canEdit) return
        state = state.copy(
            outbounds = state.outbounds.copy(
                poolEditor = editor.copy(input = value, message = null, error = null),
            ),
        )
    }

    fun addOutboundPoolInput() {
        val editor = state.outbounds.poolEditor
        if (!editor.isOpen || editor.isLoading || editor.isSaving || !editor.canEdit) return
        val result = mergeOutboundPoolInput(editor.entries, editor.input)
        state = state.copy(
            outbounds = state.outbounds.copy(
                poolEditor = if (result.addedCount == 0) {
                    editor.copy(message = null, error = "Не найдено ни одной непустой строки со ссылкой.")
                } else {
                    editor.copy(
                        input = "",
                        entries = result.entries,
                        message = "Добавлено или обновлено строк: ${result.addedCount}. Ссылки нормализованы локально.",
                        error = null,
                    )
                },
            ),
        )
    }

    fun updateOutboundPoolEntryTag(index: Int, value: String) {
        val editor = state.outbounds.poolEditor
        if (!editor.isOpen || editor.isLoading || editor.isSaving || !editor.canEdit) return
        val entry = editor.entries.getOrNull(index) ?: return
        val updated = editor.entries.toMutableList().apply {
            set(index, entry.copy(tag = sanitizeOutboundPoolTag(value)))
        }
        state = state.copy(
            outbounds = state.outbounds.copy(
                poolEditor = editor.copy(entries = updated, message = null, error = null),
            ),
        )
    }

    fun removeOutboundPoolEntry(index: Int) {
        val editor = state.outbounds.poolEditor
        if (!editor.isOpen || editor.isLoading || editor.isSaving || !editor.canEdit) return
        if (index !in editor.entries.indices) return
        state = state.copy(
            outbounds = state.outbounds.copy(
                poolEditor = editor.copy(
                    entries = editor.entries.filterIndexed { entryIndex, _ -> entryIndex != index },
                    message = null,
                    error = null,
                ),
            ),
        )
    }

    fun clearOutboundPoolDraft() {
        val editor = state.outbounds.poolEditor
        if (!editor.isOpen || editor.isLoading || editor.isSaving || !editor.canEdit) return
        state = state.copy(
            outbounds = state.outbounds.copy(
                poolEditor = editor.copy(input = "", entries = emptyList(), message = null, error = null),
            ),
        )
    }

    fun updateOutboundPoolRestartAfterSave(enabled: Boolean) {
        val editor = state.outbounds.poolEditor
        if (!editor.isOpen || editor.isSaving) return
        state = state.copy(outbounds = state.outbounds.copy(poolEditor = editor.copy(restartAfterSave = enabled)))
    }

    fun updateOutboundPoolReplaceMode(enabled: Boolean) {
        val editor = state.outbounds.poolEditor
        if (!editor.isOpen || editor.isSaving) return
        state = state.copy(outbounds = state.outbounds.copy(poolEditor = editor.copy(replacePool = enabled)))
    }

    fun closeOutboundsPoolEditor() {
        val editor = state.outbounds.poolEditor
        if (editor.isSaving) return
        state = state.copy(
            outbounds = state.outbounds.copy(
                poolEditor = OutboundPoolEditorState(
                    restartAfterSave = editor.restartAfterSave,
                    replacePool = false,
                ),
            ),
        )
    }

    suspend fun saveOutboundPool() {
        val endpoint = state.dashboard.endpoint
        val current = state.outbounds
        val editor = current.poolEditor
        val filename = current.selectedFragment
        if (endpoint.isBlank() || filename.isBlank() || !editor.isOpen || !editor.canSave) return

        state = state.copy(
            outbounds = current.copy(
                poolEditor = editor.copy(
                    isSaving = true,
                    message = "Проверяем, не изменился ли $filename на сервере…",
                    error = null,
                ),
            ),
        )
        try {
            val fresh = dependencies.outbounds.loadLink(endpoint, filename)
            if (!fresh.file.equals(filename, ignoreCase = true)) {
                throw OutboundsException("Сервер вернул другой outbounds-фрагмент. Сохранение остановлено.")
            }
            if (fresh.sourceFingerprint != editor.sourceFingerprint) {
                throw OutboundsException(
                    "$filename изменился на сервере после открытия редактора. Закройте создание пула, обновите фрагмент и повторите.",
                )
            }
            if (fresh.managedKind == "subscription") {
                throw OutboundsException("Generated-фрагмент подписки нельзя перезаписать ручным пулом.")
            }
            state = state.copy(
                outbounds = state.outbounds.copy(
                    poolEditor = state.outbounds.poolEditor.copy(message = "Сохраняем proxy-пул в $filename…"),
                ),
            )
            val result = dependencies.outbounds.savePool(
                baseUrl = endpoint,
                filename = filename,
                request = OutboundPoolSaveRequest(
                    entries = editor.entries.map { entry ->
                        OutboundPoolSaveEntry(tag = entry.tag, url = entry.url)
                    },
                    restart = editor.restartAfterSave,
                    replacePool = editor.replacePool,
                    writeRaw = true,
                    sockoptMark255 = false,
                ),
            )
            val nodes = dependencies.outbounds.load(endpoint, filename)
            val active = loadActiveOutboundOrNull(endpoint, filename)
            if (state.dashboard.endpoint != endpoint || state.outbounds.selectedFragment != filename) return
            val restartFailed = result.restartRequested && !result.restarted
            val action = if (result.replacedPool) "заменён" else "обновлён"
            val message = when {
                restartFailed -> "Proxy-пул $action (${result.updated}), но сервер не подтвердил перезапуск Xkeen."
                result.restarted -> "Proxy-пул $action (${result.updated}); Xkeen перезапущен."
                else -> "Proxy-пул $action (${result.updated}) без перезапуска Xkeen."
            }
            state = state.copy(
                outbounds = state.outbounds.copy(
                    activePath = nodes.path,
                    nodes = nodes.nodes.sortWithActiveFirst(active),
                    activeNodeKey = active?.key,
                    activeNodeTag = active?.tag,
                    activeMessage = active?.message,
                    poolEditor = OutboundPoolEditorState(
                        restartAfterSave = editor.restartAfterSave,
                        replacePool = false,
                    ),
                    hasLoaded = true,
                    message = message,
                    error = message.takeIf { restartFailed },
                ),
                dashboard = state.dashboard.copy(
                    lastOperation = "Сохранён proxy-пул $filename",
                    lastError = message.takeIf { restartFailed },
                ),
                logs = recordLog(
                    "outbounds",
                    if (restartFailed) LogLevel.Warning else LogLevel.Info,
                    message,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishOutboundsPoolEditorFailure(error, "Не удалось сохранить proxy-пул.")
        }
    }

    suspend fun refreshXraySubscriptions(force: Boolean = false) {
        val endpoint = state.dashboard.endpoint
        val current = state.xraySubscriptions
        if (endpoint.isBlank() || !state.dashboard.availableCores.hasCore("xray")) return
        if (current.isBusy || (!force && current.hasLoaded)) return
        state = state.copy(
            xraySubscriptions = current.copy(
                isLoading = true,
                message = "Загружаем подписки Xray…",
                error = null,
            ),
        )
        try {
            val snapshot = dependencies.xraySubscriptions.list(endpoint)
            if (state.dashboard.endpoint != endpoint) return
            state = state.copy(
                xraySubscriptions = state.xraySubscriptions.copy(
                    items = snapshot.subscriptions.sortedBy { it.name.lowercase() },
                    routingBalancers = snapshot.routingBalancers,
                    hasLoaded = true,
                    isLoading = false,
                    message = subscriptionListMessage(snapshot.subscriptions),
                    error = null,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishXraySubscriptionsFailure(error, "Не удалось загрузить подписки Xray.")
        }
    }

    fun openNewXraySubscription() {
        val current = state.xraySubscriptions
        if (current.isBusy) return
        val draft = XraySubscriptionDraft()
        state = state.copy(
            xraySubscriptions = current.copy(
                editor = XraySubscriptionEditorState(
                    isOpen = true,
                    draft = draft,
                    savedDraft = draft,
                    message = "Добавьте URL и выполните безопасный preview перед сохранением.",
                ),
            ),
        )
    }

    fun openXraySubscription(id: String) {
        val current = state.xraySubscriptions
        if (current.isBusy) return
        val record = current.items.firstOrNull { it.id == id } ?: return
        val draft = record.toSubscriptionDraft()
        state = state.copy(
            xraySubscriptions = current.copy(
                editor = XraySubscriptionEditorState(
                    isOpen = true,
                    draft = draft,
                    savedDraft = draft,
                    nodeCatalog = record.toSubscriptionNodeCatalog(),
                    refreshAfterSave = false,
                    message = if (record.nodes.isEmpty()) {
                        "Настройки загружены. Список узлов появится после первого обновления или Preview."
                    } else {
                        "Загружен сохранённый список: ${record.nodes.size} узлов. Preview обновит его с сервера."
                    },
                ),
            ),
        )
    }

    fun updateXraySubscriptionDraft(transform: (XraySubscriptionDraft) -> XraySubscriptionDraft) {
        val editor = state.xraySubscriptions.editor
        if (!editor.isOpen || editor.isPreviewing || editor.isSaving || editor.isPinging) return
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(
                editor = editor.copy(
                    draft = transform(editor.draft),
                    message = null,
                    error = null,
                ),
            ),
        )
    }

    fun toggleXraySubscriptionAdvanced() {
        val editor = state.xraySubscriptions.editor
        if (!editor.isOpen || editor.isPreviewing || editor.isSaving || editor.isPinging) return
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(
                editor = editor.copy(advancedExpanded = !editor.advancedExpanded),
            ),
        )
    }

    fun updateXraySubscriptionRefreshAfterSave(enabled: Boolean) {
        val editor = state.xraySubscriptions.editor
        if (!editor.isOpen || editor.isSaving || editor.isPinging) return
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(editor = editor.copy(refreshAfterSave = enabled)),
        )
    }

    fun updateXraySubscriptionRestart(enabled: Boolean) {
        val editor = state.xraySubscriptions.editor
        if (!editor.isOpen || editor.isSaving || editor.isPinging) return
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(editor = editor.copy(restartAfterMutation = enabled)),
        )
    }

    fun toggleXraySubscriptionNode(nodeKey: String) {
        val editor = state.xraySubscriptions.editor
        val excluded = nodeKey !in editor.draft.excludedNodeKeys
        setXraySubscriptionNodesExcluded(setOf(nodeKey), excluded)
    }

    fun setXraySubscriptionNodesExcluded(nodeKeys: Set<String>, excluded: Boolean) {
        val editor = state.xraySubscriptions.editor
        if (!editor.isOpen || editor.isPreviewing || editor.isSaving || editor.isPinging) return
        val availableKeys = editor.nodeCatalog.nodes.map(OutboundNode::key).filter(String::isNotBlank).toSet()
        val targets = nodeKeys.map(String::trim).filter { it.isNotBlank() && it in availableKeys }.toSet()
        if (targets.isEmpty()) return
        val nextExcluded = editor.draft.excludedNodeKeys.toMutableSet().apply {
            if (excluded) addAll(targets) else removeAll(targets)
        }.toList().sorted()
        if (nextExcluded == editor.draft.excludedNodeKeys) return
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(
                editor = editor.copy(
                    draft = editor.draft.copy(excludedNodeKeys = nextExcluded),
                    refreshAfterSave = true,
                    message = if (excluded) {
                        "Выбрано для исключения: ${targets.size}. Повторите Preview, затем сохраните и примените изменения."
                    } else {
                        "Возвращено узлов: ${targets.size}. Повторите Preview, затем сохраните и примените изменения."
                    },
                    error = null,
                ),
            ),
        )
    }

    fun closeXraySubscriptionEditor() {
        if (state.xraySubscriptions.editor.isSaving || state.xraySubscriptions.editor.isPinging) return
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(editor = XraySubscriptionEditorState()),
        )
    }

    suspend fun previewXraySubscription() {
        val endpoint = state.dashboard.endpoint
        val editor = state.xraySubscriptions.editor
        val draft = editor.draft
        if (
            endpoint.isBlank() || !editor.isOpen || editor.isPreviewing || editor.isSaving || editor.isPinging ||
            draft.validationError != null
        ) return
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(
                editor = editor.copy(isPreviewing = true, message = "Проверяем подписку без сохранения…", error = null),
            ),
        )
        try {
            val preview = dependencies.xraySubscriptions.preview(endpoint, draft.toSubscriptionSaveRequest())
            if (state.dashboard.endpoint != endpoint || state.xraySubscriptions.editor.draft != draft) return
            val previewWithLatency = preview.copy(
                nodes = preview.nodes.withPreservedLatencyFrom(editor.nodeCatalog.nodes),
            )
            state = state.copy(
                xraySubscriptions = state.xraySubscriptions.copy(
                    editor = state.xraySubscriptions.editor.copy(
                        isPreviewing = false,
                        preview = previewWithLatency,
                        nodeCatalog = previewWithLatency.toSubscriptionNodeCatalog(),
                        previewSignature = draft.previewSignature(),
                        message = "Preview: ${preview.count} из ${preview.sourceCount.coerceAtLeast(preview.count)} узлов.",
                        error = null,
                    ),
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishXraySubscriptionEditorFailure(error, "Не удалось получить preview подписки.")
        }
    }

    suspend fun pingXraySubscriptionNode(nodeKey: String) {
        pingXraySubscriptionNodes(setOf(nodeKey), pingAll = false)
    }

    suspend fun pingAllXraySubscriptionNodes() {
        val current = state.xraySubscriptions
        val editor = current.editor
        val record = current.items.firstOrNull { it.id == editor.draft.id } ?: return
        val excluded = editor.draft.excludedNodeKeys.toSet()
        val keys = record.nodes.asSequence()
            .filter { it.tag.isNotBlank() && it.key !in excluded }
            .map(OutboundNode::key)
            .filter(String::isNotBlank)
            .toSet()
        pingXraySubscriptionNodes(keys, pingAll = true)
    }

    private suspend fun pingXraySubscriptionNodes(nodeKeys: Set<String>, pingAll: Boolean) {
        val endpoint = state.dashboard.endpoint
        val current = state.xraySubscriptions
        val editor = current.editor
        val subscriptionId = editor.draft.id
        val record = current.items.firstOrNull { it.id == subscriptionId } ?: return
        val savedActiveKeys = record.nodes.asSequence()
            .filter { it.tag.isNotBlank() }
            .map(OutboundNode::key)
            .filter(String::isNotBlank)
            .toSet()
        val excluded = editor.draft.excludedNodeKeys.toSet()
        val keys = nodeKeys.map(String::trim)
            .filter { it.isNotBlank() && it in savedActiveKeys && it !in excluded }
            .distinct()
        if (
            endpoint.isBlank() || subscriptionId.isBlank() || !editor.isOpen || editor.isPreviewing ||
            editor.isSaving || editor.isPinging || keys.isEmpty()
        ) return

        state = state.copy(
            xraySubscriptions = current.copy(
                editor = editor.copy(
                    isPingingAll = pingAll,
                    pingingNodeKeys = keys.toSet(),
                    message = if (pingAll) {
                        "Проверяем задержку ${keys.size} узлов в фоне…"
                    } else {
                        "Проверяем задержку узла…"
                    },
                    error = null,
                ),
            ),
        )
        try {
            val result = dependencies.xraySubscriptions.pingNodes(endpoint, subscriptionId, keys)
            if (
                state.dashboard.endpoint != endpoint ||
                state.xraySubscriptions.editor.draft.id != subscriptionId
            ) return
            val message = when {
                result.failedCount <= 0 -> "Проверено узлов: ${result.okCount}."
                else -> "Доступно ${result.okCount} из ${result.requested}; без ответа: ${result.failedCount}."
            }
            val latest = state.xraySubscriptions
            val latestEditor = latest.editor
            state = state.copy(
                xraySubscriptions = latest.copy(
                    items = latest.items.map { item ->
                        if (item.id == subscriptionId) {
                            item.copy(nodes = item.nodes.withLatency(result.latencyByNodeKey))
                        } else {
                            item
                        }
                    },
                    editor = latestEditor.copy(
                        preview = latestEditor.preview?.copy(
                            nodes = latestEditor.preview.nodes.withLatency(result.latencyByNodeKey),
                        ),
                        nodeCatalog = latestEditor.nodeCatalog.copy(
                            nodes = latestEditor.nodeCatalog.nodes.withLatency(result.latencyByNodeKey),
                        ),
                        message = message,
                        error = null,
                    ),
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishXraySubscriptionEditorFailure(error, "Не удалось проверить задержку узлов подписки.")
        } finally {
            val latest = state.xraySubscriptions.editor
            if (
                state.dashboard.endpoint == endpoint && latest.isOpen && latest.draft.id == subscriptionId
            ) {
                state = state.copy(
                    xraySubscriptions = state.xraySubscriptions.copy(
                        editor = latest.copy(
                            isPingingAll = false,
                            pingingNodeKeys = latest.pingingNodeKeys - keys.toSet(),
                        ),
                    ),
                )
            }
        }
    }

    suspend fun saveXraySubscription() {
        val endpoint = state.dashboard.endpoint
        val editor = state.xraySubscriptions.editor
        val draft = editor.draft
        if (endpoint.isBlank() || !editor.isOpen || !editor.canSave) return
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(
                editor = editor.copy(isSaving = true, message = "Проверяем актуальность настроек…", error = null),
            ),
        )
        try {
            if (draft.id.isNotBlank()) {
                val fresh = dependencies.xraySubscriptions.list(endpoint)
                val serverRecord = fresh.subscriptions.firstOrNull { it.id == draft.id }
                    ?: throw XraySubscriptionsException("Подписка была удалена в веб-панели. Обновите список.")
                if (serverRecord.toSubscriptionDraft() != editor.savedDraft) {
                    throw XraySubscriptionsException(
                        "Подписка изменилась в веб-панели после открытия. Закройте редактор и откройте её заново.",
                    )
                }
            }
            val saved = dependencies.xraySubscriptions.upsert(endpoint, draft.toSubscriptionSaveRequest())
            val savedRecord = saved.subscription
                ?: throw XraySubscriptionsException("Сервер сохранил подписку без актуального snapshot.")
            var refreshError: String? = null
            var refreshed = false
            if (editor.refreshAfterSave) {
                try {
                    dependencies.xraySubscriptions.refresh(endpoint, savedRecord.id, editor.restartAfterMutation)
                    refreshed = true
                } catch (error: Exception) {
                    if (returnToLoginForExpiredSession(error)) return
                    refreshError = error.message?.takeIf(String::isNotBlank) ?: "Не удалось обновить подписку."
                }
            }
            val snapshot = dependencies.xraySubscriptions.list(endpoint)
            if (state.dashboard.endpoint != endpoint) return
            val message = when {
                refreshError != null -> "Подписка сохранена, но обновление не выполнено: $refreshError"
                refreshed -> "Подписка сохранена и generated-фрагмент обновлён."
                else -> "Подписка сохранена. Generated-фрагмент обновится по расписанию или вручную."
            }
            state = state.copy(
                xraySubscriptions = state.xraySubscriptions.copy(
                    items = snapshot.subscriptions.sortedBy { it.name.lowercase() },
                    routingBalancers = snapshot.routingBalancers,
                    hasLoaded = true,
                    editor = XraySubscriptionEditorState(),
                    message = message,
                    error = refreshError,
                ),
                dashboard = state.dashboard.copy(
                    lastOperation = "Сохранена подписка ${savedRecord.name}",
                    lastError = refreshError,
                ),
                logs = recordLog(
                    "subscriptions",
                    if (refreshError == null) LogLevel.Info else LogLevel.Warning,
                    message,
                ),
            )
            if (refreshed) refreshOutbounds(force = true)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishXraySubscriptionEditorFailure(error, "Не удалось сохранить подписку Xray.")
        }
    }

    suspend fun refreshXraySubscription(id: String, restart: Boolean = true) {
        val endpoint = state.dashboard.endpoint
        val current = state.xraySubscriptions
        if (endpoint.isBlank() || current.isBusy || current.items.none { it.id == id }) return
        state = state.copy(
            xraySubscriptions = current.copy(
                refreshingIds = setOf(id),
                message = "Обновляем подписку…",
                error = null,
            ),
        )
        try {
            val result = dependencies.xraySubscriptions.refresh(endpoint, id, restart)
            val snapshot = dependencies.xraySubscriptions.list(endpoint)
            if (state.dashboard.endpoint != endpoint) return
            state = state.copy(
                xraySubscriptions = state.xraySubscriptions.copy(
                    items = snapshot.subscriptions.sortedBy { it.name.lowercase() },
                    routingBalancers = snapshot.routingBalancers,
                    refreshingIds = emptySet(),
                    hasLoaded = true,
                    message = if (result.changed) "Подписка обновлена: ${result.count} узлов." else "Подписка проверена: изменений нет.",
                    error = null,
                ),
            )
            refreshOutbounds(force = true)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishXraySubscriptionsFailure(error, "Не удалось обновить подписку Xray.")
        }
    }

    suspend fun refreshDueXraySubscriptions(restart: Boolean = true) {
        val endpoint = state.dashboard.endpoint
        val current = state.xraySubscriptions
        if (endpoint.isBlank() || current.isBusy) return
        state = state.copy(
            xraySubscriptions = current.copy(isRefreshingDue = true, message = "Проверяем due-подписки…", error = null),
        )
        try {
            val result = dependencies.xraySubscriptions.refreshDue(endpoint, restart)
            val snapshot = dependencies.xraySubscriptions.list(endpoint)
            if (state.dashboard.endpoint != endpoint) return
            val failed = result.updated - result.okCount
            val message = when {
                result.updated == 0 -> "Просроченных подписок нет."
                failed > 0 -> "Due обновлены: ${result.okCount} из ${result.updated}; ошибок: $failed."
                else -> "Due-подписки обновлены: ${result.okCount}."
            }
            state = state.copy(
                xraySubscriptions = state.xraySubscriptions.copy(
                    items = snapshot.subscriptions.sortedBy { it.name.lowercase() },
                    routingBalancers = snapshot.routingBalancers,
                    isRefreshingDue = false,
                    hasLoaded = true,
                    message = message,
                    error = message.takeIf { failed > 0 },
                ),
            )
            if (result.updated > 0) refreshOutbounds(force = true)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishXraySubscriptionsFailure(error, "Не удалось обновить due-подписки.")
        }
    }

    suspend fun deleteXraySubscription(id: String, restart: Boolean = true) {
        val endpoint = state.dashboard.endpoint
        val current = state.xraySubscriptions
        if (endpoint.isBlank() || current.isBusy || current.items.none { it.id == id }) return
        state = state.copy(
            xraySubscriptions = current.copy(
                deletingIds = setOf(id),
                message = "Удаляем подписку и generated-фрагмент…",
                error = null,
            ),
        )
        try {
            dependencies.xraySubscriptions.delete(endpoint, id, restart = restart, removeFile = true)
            val snapshot = dependencies.xraySubscriptions.list(endpoint)
            if (state.dashboard.endpoint != endpoint) return
            state = state.copy(
                xraySubscriptions = state.xraySubscriptions.copy(
                    items = snapshot.subscriptions.sortedBy { it.name.lowercase() },
                    routingBalancers = snapshot.routingBalancers,
                    deletingIds = emptySet(),
                    hasLoaded = true,
                    message = "Подписка и generated-фрагмент удалены.",
                    error = null,
                ),
            )
            refreshOutbounds(force = true)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishXraySubscriptionsFailure(error, "Не удалось удалить подписку Xray.")
        }
    }

    suspend fun refreshXrayDatCatalog(force: Boolean = false) {
        val endpoint = state.dashboard.endpoint
        val current = state.xrayDat
        if (endpoint.isBlank() || !state.dashboard.availableCores.hasCore("xray")) return
        if (current.isLoadingCatalog || (!force && current.hasLoadedCatalog)) return
        state = state.copy(
            xrayDat = current.copy(
                isLoadingCatalog = true,
                catalogError = null,
            ),
        )
        try {
            val catalog = dependencies.xrayDat.loadCatalog(endpoint)
            if (state.dashboard.endpoint != endpoint) return
            val selectedKind = current.selectedKind.takeIf { kind -> catalog.files.any { it.kind == kind } }
                ?: catalog.files.firstOrNull()?.kind
                ?: current.selectedKind
            val selectedFile = current.selectedFilePath.takeIf { path ->
                catalog.files.any { it.path == path && it.kind == selectedKind }
            } ?: catalog.files.firstOrNull { it.kind == selectedKind }?.path.orEmpty()
            state = state.copy(
                xrayDat = state.xrayDat.copy(
                    files = catalog.files,
                    selectedKind = selectedKind,
                    selectedFilePath = selectedFile,
                    geodatInstalled = catalog.geodatInstalled,
                    geodatMessage = catalog.geodatMessage,
                    tags = emptyList(),
                    valueQuery = "",
                    lookupMatches = null,
                    isLookingUpValue = false,
                    lookupError = null,
                    selectedTag = null,
                    items = emptyList(),
                    isLoadingCatalog = false,
                    isLoadingTags = false,
                    isLoadingItems = false,
                    hasLoadedCatalog = true,
                    catalogError = if (catalog.files.isEmpty()) {
                        "В /opt/etc/xray/dat не найдены GeoIP / GeoSite DAT-файлы."
                    } else null,
                    tagsError = null,
                    itemsError = null,
                ),
            )
            if (selectedFile.isNotBlank() && catalog.geodatInstalled != false) {
                loadSelectedXrayDatTags()
            }
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    xrayDat = state.xrayDat.copy(isLoadingCatalog = false),
                )
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            state = state.copy(
                xrayDat = state.xrayDat.copy(
                    isLoadingCatalog = false,
                    hasLoadedCatalog = true,
                    catalogError = error.toCompanionLoadMessage("Не удалось загрузить каталог DAT-файлов."),
                ),
            )
        }
    }

    suspend fun selectXrayDatKind(kind: XrayDatKind) {
        val current = state.xrayDat
        if (current.isLoadingCatalog || current.isLoadingTags || current.isLoadingItems) return
        val file = current.files.firstOrNull { it.kind == kind }
        state = state.copy(
            xrayDat = current.copy(
                selectedKind = kind,
                selectedFilePath = file?.path.orEmpty(),
                tags = emptyList(),
                tagQuery = "",
                valueQuery = "",
                lookupMatches = null,
                isLookingUpValue = false,
                lookupError = null,
                selectedTag = null,
                items = emptyList(),
                itemQuery = "",
                tagsError = if (file == null) "Файлы ${kind.displayName} не найдены." else null,
                itemsError = null,
            ),
        )
        if (file != null && current.geodatInstalled != false) loadSelectedXrayDatTags()
    }

    suspend fun selectXrayDatFile(path: String) {
        val current = state.xrayDat
        val file = current.files.firstOrNull { it.path == path } ?: return
        if (current.isLoadingTags || current.isLoadingItems || current.selectedFilePath == path) return
        state = state.copy(
            xrayDat = current.copy(
                selectedKind = file.kind,
                selectedFilePath = file.path,
                tags = emptyList(),
                tagQuery = "",
                valueQuery = "",
                lookupMatches = null,
                isLookingUpValue = false,
                lookupError = null,
                selectedTag = null,
                items = emptyList(),
                itemQuery = "",
                tagsError = null,
                itemsError = null,
            ),
        )
        if (current.geodatInstalled != false) loadSelectedXrayDatTags()
    }

    fun updateXrayDatTagQuery(value: String) {
        if (state.xrayDat.isLoadingTags) return
        state = state.copy(xrayDat = state.xrayDat.copy(tagQuery = value))
    }

    fun updateXrayDatValueQuery(value: String) {
        if (state.xrayDat.isLookingUpValue) return
        state = state.copy(
            xrayDat = state.xrayDat.copy(
                valueQuery = value,
                lookupMatches = null,
                lookupError = null,
            ),
        )
    }

    suspend fun lookupXrayDatValue() {
        val endpoint = state.dashboard.endpoint
        val current = state.xrayDat
        val file = current.selectedFile ?: return
        val value = current.valueQuery.trim()
        if (value.isBlank() || current.isLookingUpValue || current.isLoadingTags) return
        state = state.copy(
            xrayDat = current.copy(
                isLookingUpValue = true,
                lookupMatches = null,
                lookupError = null,
            ),
        )
        try {
            val result = dependencies.xrayDat.lookupValue(endpoint, file, value)
            if (state.dashboard.endpoint != endpoint || state.xrayDat.selectedFilePath != file.path || state.xrayDat.valueQuery.trim() != value) return
            state = state.copy(
                xrayDat = state.xrayDat.copy(
                    lookupMatches = result.matches,
                    isLookingUpValue = false,
                    lookupError = null,
                ),
            )
        } catch (error: CancellationException) {
            if (
                state.dashboard.endpoint == endpoint &&
                state.xrayDat.selectedFilePath == file.path &&
                state.xrayDat.valueQuery.trim() == value
            ) {
                state = state.copy(
                    xrayDat = state.xrayDat.copy(isLookingUpValue = false),
                )
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            state = state.copy(
                xrayDat = state.xrayDat.copy(
                    isLookingUpValue = false,
                    lookupError = error.toCompanionLoadMessage("Не удалось найти значение в DAT-файле."),
                ),
            )
        }
    }

    fun updateXrayDatItemQuery(value: String) {
        if (state.xrayDat.isLoadingItems) return
        state = state.copy(xrayDat = state.xrayDat.copy(itemQuery = value, itemsError = null))
    }

    suspend fun selectXrayDatTag(tag: String) {
        val current = state.xrayDat
        if (current.isLoadingTags || current.isLoadingItems || current.tags.none { it.name == tag }) return
        state = state.copy(
            xrayDat = current.copy(
                selectedTag = tag,
                items = emptyList(),
                itemQuery = "",
                itemOffset = 0,
                itemTotal = null,
                searchCursor = 0,
                searchNextCursor = null,
                searchViewed = 0,
                searchMode = null,
                itemsError = null,
            ),
        )
        loadXrayDatItems(offset = 0)
    }

    fun closeXrayDatTag() {
        if (state.xrayDat.isLoadingItems) return
        state = state.copy(
            xrayDat = state.xrayDat.copy(
                selectedTag = null,
                items = emptyList(),
                itemQuery = "",
                itemOffset = 0,
                itemTotal = null,
                searchCursor = 0,
                searchNextCursor = null,
                searchViewed = 0,
                searchMode = null,
                itemsError = null,
            ),
        )
    }

    suspend fun searchXrayDatItems() {
        val current = state.xrayDat
        if (current.itemQuery.isBlank()) {
            loadXrayDatItems(offset = 0)
            return
        }
        loadXrayDatSearch(cursor = 0, append = false)
    }

    suspend fun clearXrayDatItemSearch() {
        if (state.xrayDat.isLoadingItems) return
        state = state.copy(xrayDat = state.xrayDat.copy(itemQuery = ""))
        loadXrayDatItems(offset = 0)
    }

    suspend fun previousXrayDatPage() {
        val current = state.xrayDat
        if (!current.canLoadPreviousPage || current.isLoadingItems) return
        loadXrayDatItems((current.itemOffset - current.itemLimit).coerceAtLeast(0))
    }

    suspend fun nextXrayDatPage() {
        val current = state.xrayDat
        if (!current.canLoadNextPage || current.isLoadingItems) return
        if (current.isItemSearch) {
            current.searchNextCursor?.let { loadXrayDatSearch(it, append = true) }
        } else {
            loadXrayDatItems(current.itemOffset + current.itemLimit)
        }
    }

    private suspend fun loadSelectedXrayDatTags() {
        val endpoint = state.dashboard.endpoint
        val file = state.xrayDat.selectedFile ?: return
        state = state.copy(
            xrayDat = state.xrayDat.copy(
                isLoadingTags = true,
                tagsError = null,
                selectedTag = null,
                items = emptyList(),
                itemsError = null,
            ),
        )
        try {
            val snapshot = withTimeoutOrNull(XRAY_DAT_READ_TIMEOUT_MILLIS) {
                dependencies.xrayDat.loadTags(endpoint, file)
            }
            if (state.dashboard.endpoint != endpoint || state.xrayDat.selectedFilePath != file.path) return
            if (snapshot == null) {
                state = state.copy(
                    xrayDat = state.xrayDat.copy(
                        isLoadingTags = false,
                        tagsError = "Чтение тегов DAT заняло слишком много времени. Повторите запрос или проверьте xk-geodat.",
                    ),
                )
                return
            }
            state = state.copy(
                xrayDat = state.xrayDat.copy(
                    tags = snapshot.tags,
                    isLoadingTags = false,
                    tagsError = if (snapshot.tags.isEmpty()) "В файле не найдены теги." else null,
                ),
            )
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint && state.xrayDat.selectedFilePath == file.path) {
                state = state.copy(
                    xrayDat = state.xrayDat.copy(isLoadingTags = false),
                )
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            state = state.copy(
                xrayDat = state.xrayDat.copy(
                    isLoadingTags = false,
                    tagsError = error.toCompanionLoadMessage("Не удалось прочитать теги DAT-файла."),
                ),
            )
        }
    }

    private suspend fun loadXrayDatItems(offset: Int) {
        val endpoint = state.dashboard.endpoint
        val current = state.xrayDat
        val file = current.selectedFile ?: return
        val tag = current.selectedTag ?: return
        if (current.isLoadingItems) return
        state = state.copy(
            xrayDat = current.copy(
                isLoadingItems = true,
                itemQuery = "",
                itemsError = null,
            ),
        )
        try {
            val page = withTimeoutOrNull(XRAY_DAT_READ_TIMEOUT_MILLIS) {
                dependencies.xrayDat.loadTagPage(endpoint, file, tag, offset, current.itemLimit)
            }
            if (!xrayDatRequestIsCurrent(endpoint, file.path, tag)) return
            if (page == null) {
                publishXrayDatItemsTimeout()
                return
            }
            state = state.copy(
                xrayDat = state.xrayDat.copy(
                    items = page.items,
                    itemOffset = page.offset,
                    itemLimit = page.limit,
                    itemTotal = page.total,
                    searchCursor = 0,
                    searchNextCursor = null,
                    searchViewed = 0,
                    searchMode = null,
                    isLoadingItems = false,
                    itemsError = null,
                ),
            )
        } catch (error: CancellationException) {
            if (xrayDatRequestIsCurrent(endpoint, file.path, tag)) {
                state = state.copy(
                    xrayDat = state.xrayDat.copy(isLoadingItems = false),
                )
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishXrayDatItemsFailure(error)
        }
    }

    private suspend fun loadXrayDatSearch(cursor: Int, append: Boolean) {
        val endpoint = state.dashboard.endpoint
        val current = state.xrayDat
        val file = current.selectedFile ?: return
        val tag = current.selectedTag ?: return
        val query = current.itemQuery.trim()
        if (query.isBlank() || current.isLoadingItems) return
        state = state.copy(xrayDat = current.copy(isLoadingItems = true, itemsError = null))
        try {
            val page = withTimeoutOrNull(XRAY_DAT_READ_TIMEOUT_MILLIS) {
                dependencies.xrayDat.searchTag(endpoint, file, tag, query, cursor, current.itemLimit)
            }
            if (!xrayDatRequestIsCurrent(endpoint, file.path, tag) || state.xrayDat.itemQuery.trim() != query) return
            if (page == null) {
                publishXrayDatItemsTimeout()
                return
            }
            state = state.copy(
                xrayDat = state.xrayDat.copy(
                    items = if (append) state.xrayDat.items + page.items else page.items,
                    itemOffset = 0,
                    itemTotal = page.total,
                    searchCursor = page.cursor,
                    searchNextCursor = page.nextCursor,
                    searchViewed = page.viewed,
                    searchMode = page.mode,
                    isLoadingItems = false,
                    itemsError = null,
                ),
            )
        } catch (error: CancellationException) {
            if (xrayDatRequestIsCurrent(endpoint, file.path, tag)) {
                state = state.copy(
                    xrayDat = state.xrayDat.copy(isLoadingItems = false),
                )
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishXrayDatItemsFailure(error)
        }
    }

    private fun xrayDatRequestIsCurrent(endpoint: String, filePath: String, tag: String): Boolean =
        state.dashboard.endpoint == endpoint && state.xrayDat.selectedFilePath == filePath && state.xrayDat.selectedTag == tag

    private fun publishXrayDatItemsFailure(error: Throwable) {
        state = state.copy(
            xrayDat = state.xrayDat.copy(
                isLoadingItems = false,
                itemsError = error.toCompanionLoadMessage("Не удалось прочитать содержимое DAT-тега."),
            ),
        )
    }

    private fun publishXrayDatItemsTimeout() {
        state = state.copy(
            xrayDat = state.xrayDat.copy(
                isLoadingItems = false,
                itemsError = "Чтение тега DAT заняло слишком много времени. Повторите запрос или проверьте xk-geodat.",
            ),
        )
    }

    suspend fun saveOutboundLink() {
        val endpoint = state.dashboard.endpoint
        val current = state.outbounds
        val editor = current.editor
        val filename = current.selectedFragment
        if (
            endpoint.isBlank() || filename.isBlank() || !editor.isOpen || !editor.canSave ||
            !editor.hasChanges || current.nodes.size > 1
        ) {
            return
        }
        val normalizedTag = cleanOutboundTag(editor.draftTag)
        state = state.copy(
            outbounds = current.copy(
                editor = editor.copy(
                    isSaving = true,
                    draftTag = normalizedTag,
                    message = "Проверяем, не изменился ли $filename на сервере…",
                    error = null,
                ),
            ),
        )
        try {
            val fresh = dependencies.outbounds.loadLink(endpoint, filename)
            if (!fresh.file.equals(filename, ignoreCase = true)) {
                throw OutboundsException("Сервер вернул другой outbounds-фрагмент. Сохранение остановлено.")
            }
            if (fresh.sourceFingerprint != editor.sourceFingerprint) {
                throw OutboundsException(
                    "$filename изменился на сервере после открытия редактора. Закройте редактор, обновите фрагмент и повторите правку.",
                )
            }
            state = state.copy(
                outbounds = state.outbounds.copy(
                    editor = state.outbounds.editor.copy(message = "Сохраняем ссылку в $filename…"),
                ),
            )
            val result = dependencies.outbounds.saveLink(
                baseUrl = endpoint,
                filename = filename,
                request = OutboundLinkSaveRequest(
                    url = editor.draftUrl.trim(),
                    outboundTag = normalizedTag,
                    restart = editor.restartAfterSave,
                ),
            )
            val nodes = dependencies.outbounds.load(endpoint, filename)
            val active = loadActiveOutboundOrNull(endpoint, filename)
            val saved = dependencies.outbounds.loadLink(endpoint, filename)
            if (state.dashboard.endpoint != endpoint || state.outbounds.selectedFragment != filename) return
            val restartFailed = result.restartRequested && !result.restarted
            val message = when {
                restartFailed -> "Proxy-ссылка сохранена, но сервер не подтвердил перезапуск Xkeen."
                result.restarted -> "Proxy-ссылка сохранена; Xkeen перезапущен."
                else -> "Proxy-ссылка сохранена без перезапуска Xkeen."
            }
            state = state.copy(
                outbounds = state.outbounds.copy(
                    activePath = nodes.path.ifBlank { saved.path },
                    nodes = nodes.nodes.sortWithActiveFirst(active),
                    activeNodeKey = active?.key,
                    activeNodeTag = active?.tag,
                    activeMessage = active?.message,
                    editor = OutboundEditorState(restartAfterSave = editor.restartAfterSave),
                    hasLoaded = true,
                    message = message,
                    error = message.takeIf { restartFailed },
                ),
                dashboard = state.dashboard.copy(
                    lastOperation = "Сохранён proxy-фрагмент $filename",
                    lastError = message.takeIf { restartFailed },
                ),
                logs = recordLog(
                    "outbounds",
                    if (restartFailed) LogLevel.Warning else LogLevel.Info,
                    message,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            publishOutboundsEditorFailure(error, "Не удалось сохранить proxy-ссылку.")
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
            if (returnToLoginForExpiredSession(error)) {
                return@onFailure
            }
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
                publishedContent = content.publishedText,
                draftContent = content.savedText,
                savedDraftContent = content.savedText,
                publishedRevision = content.publishedRevision,
                savedRevision = content.savedRevision,
                draftBaseRevision = content.draftBaseRevision,
                hasServerSavedDraft = content.hasSavedDraft,
                lastSavedAt = content.savedAt.ifBlank { current.lastSavedAt },
                lastAppliedAt = content.publishedAt.ifBlank { current.lastAppliedAt },
                usesJsonc = content.usesJsoncSidecar,
                isLoaded = true,
                isLoading = false,
                loadError = null,
            )
            val conflict = content.conflictCode?.let { code ->
                RoutingWriteState(
                    phase = RoutingWritePhase.Conflict,
                    code = code,
                    message = content.conflictMessage
                        ?: "Сохранённый draft расходится с опубликованной версией.",
                )
            } ?: RoutingWriteState()
            state = state.copy(
                routing = state.routing.copy(
                    documents = state.routing.documents.replaceDocument(loaded),
                    loadError = null,
                    write = conflict,
                    validation = RoutingValidation(
                        message = if (content.hasSavedDraft) {
                            "С сервера загружен сохранённый черновик. Проверьте его перед применением."
                        } else if (content.usesJsoncSidecar) {
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
                write = when {
                    state.routing.write.isPending -> state.routing.write
                    state.routing.write.phase == RoutingWritePhase.Conflict -> state.routing.write
                    else -> RoutingWriteState()
                },
            ),
        )
    }

    fun revertRoutingDraft() {
        val document = selectedRoutingDocument() ?: return
        val reverted = document.copy(
            draftContent = document.savedDraftContent,
        )
        state = state.copy(
            routing = state.routing.copy(
                documents = state.routing.documents.replaceDocument(reverted),
                mode = RoutingMode.Read,
                validation = RoutingValidation(
                    message = if (document.hasServerSavedDraft) {
                        "Локальные изменения отменены; восстановлен сохранённый server draft."
                    } else {
                        "Локальные изменения отменены; восстановлена опубликованная версия."
                    },
                ),
                preview = null,
                write = if (state.routing.write.phase == RoutingWritePhase.Conflict) {
                    state.routing.write
                } else {
                    RoutingWriteState()
                },
            ),
        )
    }

    suspend fun validateRouting() {
        val document = selectedRoutingDocument() ?: return
        if (
            !document.isLoaded ||
            state.routing.isValidationInFlight ||
            activeRoutingValidationRequest != null
        ) {
            return
        }

        val request = RoutingValidationRequest(
            documentId = document.id,
            draftContent = document.draftContent,
            connectionId = state.selectedConnectionId,
            endpoint = state.dashboard.endpoint,
        )
        activeRoutingValidationRequest = request
        state = state.copy(
            routing = state.routing.copy(
                isValidationInFlight = true,
                validation = RoutingValidation(
                    state = RoutingValidationState.Validating,
                    message = "Проверяем ${document.title} на сервере Xkeen UI…",
                ),
            ),
        )

        try {
            val result = dependencies.routingValidation.validate(
                baseUrl = request.endpoint,
                document = document,
            )
            if (!isCurrentRoutingValidationRequest(request)) {
                return
            }
            val confirmedValid = result.valid && result.diagnostics.none {
                it.severity == RoutingDiagnosticSeverity.Error
            }
            val finalState = if (confirmedValid) {
                RoutingValidationState.Valid
            } else {
                RoutingValidationState.Invalid
            }
            state = state.copy(
                routing = state.routing.copy(
                    validation = RoutingValidation(
                        state = finalState,
                        message = result.message,
                        serverDiagnostics = result.diagnostics,
                    ),
                ),
                logs = recordLog(
                    source = "routing",
                    level = if (confirmedValid) LogLevel.Info else LogLevel.Warning,
                    message = if (confirmedValid) {
                        "Сервер подтвердил routing-конфиг ${document.title}"
                    } else {
                        "Сервер отклонил routing-конфиг ${document.title}"
                    },
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!isCurrentRoutingValidationRequest(request)) {
                return
            }
            if (returnToLoginForExpiredSession(error)) return
            val message = error.toRoutingValidationMessage()
            state = state.copy(
                routing = state.routing.copy(
                    validation = RoutingValidation(
                        state = RoutingValidationState.Invalid,
                        message = message,
                        serverDiagnostics = listOf(
                            RoutingDiagnostic(
                                source = RoutingDiagnosticSource.Transport,
                                severity = RoutingDiagnosticSeverity.Error,
                                code = (error as? RoutingValidationException)?.diagnosticCode
                                    ?: "validation_request_failed",
                                message = message,
                            ),
                        ),
                    ),
                ),
                logs = recordLog("routing", LogLevel.Warning, message),
            )
        } finally {
            if (activeRoutingValidationRequest === request) {
                activeRoutingValidationRequest = null
                if (state.routing.isValidationInFlight) {
                    state = state.copy(
                        routing = state.routing.copy(isValidationInFlight = false),
                    )
                }
            }
        }
    }

    fun previewRouting() {
        val document = selectedRoutingDocument() ?: return
        if (state.routing.validation.state != RoutingValidationState.Valid) {
            if (!state.routing.isValidationInFlight && !state.routing.validation.isPending) {
                state = state.copy(
                    routing = state.routing.copy(
                        validation = state.routing.validation.copy(
                            state = RoutingValidationState.Dirty,
                            message = "Перед превью выполните проверку на сервере.",
                        ),
                    ),
                )
            }
            return
        }

        state = state.copy(
            routing = state.routing.copy(
                preview = buildRoutingPreview(document),
            ),
        )
    }

    suspend fun saveRouting() {
        val document = selectedRoutingDocument() ?: return
        if (state.routing.write.isPending || state.routing.isValidationInFlight) return
        if (state.routing.validation.state != RoutingValidationState.Valid) {
            state = state.copy(
                routing = state.routing.copy(
                    validation = state.routing.validation.copy(
                        state = RoutingValidationState.Dirty,
                        message = "Перед сохранением выполните server validate.",
                    ),
                ),
            )
            return
        }

        state = state.copy(
            routing = state.routing.copy(
                write = RoutingWriteState(
                    phase = RoutingWritePhase.Saving,
                    message = "Сохраняем проверенный draft на сервере…",
                ),
            ),
        )
        try {
            val result = dependencies.routingWrites.save(state.dashboard.endpoint, document)
            val current = selectedRoutingDocument() ?: return
            val draftChangedDuringRequest = current.draftContent != document.draftContent
            val updated = if (draftChangedDuringRequest) {
                result.document.copy(draftContent = current.draftContent)
            } else {
                result.document
            }
            state = state.copy(
                routing = state.routing.copy(
                    documents = state.routing.documents.replaceDocument(updated),
                    validation = if (draftChangedDuringRequest) {
                        RoutingValidation(
                            state = RoutingValidationState.Dirty,
                            message = "Server draft сохранён, но локальный текст уже изменился. Проверьте его снова.",
                        )
                    } else {
                        result.validation
                    },
                    write = RoutingWriteState(
                        phase = RoutingWritePhase.Success,
                        message = "Черновик сохранён на сервере без применения.",
                    ),
                ),
                dashboard = state.dashboard.copy(
                    lastOperation = result.lastOperation,
                    lastError = null,
                ),
                logs = recordLog("routing", LogLevel.Info, result.logMessage),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            handleRoutingWriteFailure(error, document, "Не удалось сохранить routing-черновик.")
        }
    }

    fun updateLogFilter(filter: LogFilter) {
        state = state.copy(logs = state.logs.copy(filter = filter))
    }

    fun updateXrayLogStreamFilter(filter: XrayLogStreamFilter) {
        state = state.copy(logs = state.logs.copy(streamFilter = filter))
    }

    fun updateXrayLogLevelFilter(filter: XrayLogLevelFilter) {
        state = state.copy(logs = state.logs.copy(levelFilter = filter))
    }

    fun updateXrayLogSearchQuery(value: String) {
        state = state.copy(logs = state.logs.copy(searchQuery = value.take(LOGS_SEARCH_LIMIT)))
    }

    fun setXrayLogRegexEnabled(enabled: Boolean) {
        state = state.copy(logs = state.logs.copy(useRegex = enabled))
    }

    fun setXrayLogDeviceNamesVisible(enabled: Boolean) {
        state = state.copy(logs = state.logs.copy(showDeviceNames = enabled))
    }

    fun setXrayLogDomainsVisible(enabled: Boolean) {
        state = state.copy(logs = state.logs.copy(showDomains = enabled))
    }

    fun setXrayLogsFollowNewest(enabled: Boolean) {
        state = state.copy(logs = state.logs.copy(followNewest = enabled))
    }

    fun setXrayLogsCompactRows(enabled: Boolean) {
        state = state.copy(logs = state.logs.copy(compactRows = enabled))
    }

    fun updateXrayLogsDisplayLimit(limit: Int) {
        val normalized = limit.coerceIn(MIN_LOGS_ENTRY_LIMIT, LOGS_ENTRY_LIMIT)
        val current = state.logs
        if (current.displayLimit == normalized) return
        if (normalized > current.displayLimit) {
            logCursors.clear()
        }
        logsTransportGeneration += 1
        state = state.copy(
            logs = current.copy(
                displayLimit = normalized,
                entries = current.entries.cappedLogsBuffer(normalized),
            ),
        )
    }

    fun setXrayLogsPausedByUser(paused: Boolean) {
        val current = state.logs
        if (current.isPausedByUser == paused) return
        logsTransportGeneration += 1
        state = state.copy(
            logs = current.copy(
                isPausedByUser = paused,
                connection = LogsConnectionState.Disconnected,
                statusMessage = if (paused) {
                    "Обновление приостановлено. Загруженная история сохранена."
                } else {
                    "Возобновляем поток логов…"
                },
                reconnectAttempt = 0,
            ),
        )
        updateLogsDiagnostic()
    }

    suspend fun refreshXrayLogsStatus() {
        val endpoint = state.dashboard.endpoint
        if (endpoint.isBlank() || state.phase != AppPhase.Ready || state.logs.isXrayLogControlBusy) return
        val controlGeneration = xrayLogsControlGeneration
        try {
            val snapshot = dependencies.xrayLogsControl.loadStatus(endpoint)
            if (
                state.dashboard.endpoint != endpoint ||
                state.phase != AppPhase.Ready ||
                state.logs.isXrayLogControlBusy ||
                controlGeneration != xrayLogsControlGeneration
            ) {
                return
            }
            val current = state.logs
            val level = snapshot.logLevel.normalizedControllerXrayLogLevel()
            state = state.copy(
                logs = current.copy(
                    xrayLogLevel = level,
                    preferredXrayLogLevel = level.takeUnless { it == "none" }
                        ?: current.preferredXrayLogLevel,
                    xrayLogControlError = null,
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    logs = state.logs.copy(
                        xrayLogControlError = error.toCompanionLoadMessage(
                            "Не удалось проверить состояние логирования Xray.",
                        ),
                    ),
                )
            }
        }
    }

    suspend fun setXrayLogsCollectionEnabled(enabled: Boolean) {
        val endpoint = state.dashboard.endpoint
        val previous = state.logs
        if (endpoint.isBlank() || state.phase != AppPhase.Ready || previous.isXrayLogControlBusy) return
        if (previous.xrayLogLevel != null && (previous.xrayLogLevel != "none") == enabled) return

        val requestedLevel = previous.preferredXrayLogLevel
            .normalizedControllerEnabledXrayLogLevel()
            .let { level ->
                if (enabled && previous.showDomains && level in setOf("warning", "error")) "info" else level
            }
        val controlGeneration = ++xrayLogsControlGeneration
        logsTransportGeneration += 1
        state = state.copy(
            logs = previous.copy(
                isXrayLogControlBusy = true,
                xrayLogControlMessage = if (enabled) {
                    "Включаем запись логов Xray…"
                } else {
                    "Полностью останавливаем запись логов Xray…"
                },
                xrayLogControlError = null,
                connection = LogsConnectionState.Disconnected,
                statusMessage = if (enabled) {
                    "Xray применяет уровень логирования $requestedLevel."
                } else {
                    "Поток остановлен; Xray сохраняет последний снимок логов."
                },
                reconnectAttempt = 0,
            ),
        )
        updateLogsDiagnostic()

        try {
            val result = if (enabled) {
                dependencies.xrayLogsControl.enable(endpoint, requestedLevel)
            } else {
                dependencies.xrayLogsControl.disable(endpoint)
            }
            if (
                state.dashboard.endpoint != endpoint ||
                state.phase != AppPhase.Ready ||
                controlGeneration != xrayLogsControlGeneration
            ) {
                return
            }
            logCursors.clear()
            val level = result.logLevel.normalizedControllerXrayLogLevel()
            val coreNote = if (!result.xrayRestarted && result.detail.isNotBlank()) {
                " Ядро Xray уже остановлено."
            } else {
                ""
            }
            state = state.copy(
                logs = state.logs.copy(
                    xrayLogLevel = level,
                    preferredXrayLogLevel = if (enabled) level else requestedLevel,
                    isXrayLogControlBusy = false,
                    xrayLogControlMessage = if (enabled) {
                        "Логи включены · loglevel=$level.$coreNote"
                    } else {
                        "Логи полностью остановлены · loglevel=none.$coreNote"
                    },
                    xrayLogControlError = null,
                    connection = LogsConnectionState.Disconnected,
                    statusMessage = if (enabled) {
                        "Логи включены; подключаем онлайн-поток…"
                    } else {
                        "Запись логов Xray остановлена. Последний снимок сохранён."
                    },
                    reconnectAttempt = 0,
                ),
            )
            updateLogsDiagnostic()
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint && controlGeneration == xrayLogsControlGeneration) {
                state = state.copy(
                    logs = state.logs.copy(
                        xrayLogLevel = previous.xrayLogLevel,
                        preferredXrayLogLevel = previous.preferredXrayLogLevel,
                        isXrayLogControlBusy = false,
                        xrayLogControlMessage = null,
                        connection = LogsConnectionState.Disconnected,
                        statusMessage = "Операция логов прервана; состояние будет проверено заново.",
                    ),
                )
                updateLogsDiagnostic()
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    logs = state.logs.copy(
                        xrayLogLevel = previous.xrayLogLevel,
                        preferredXrayLogLevel = previous.preferredXrayLogLevel,
                        isXrayLogControlBusy = false,
                        xrayLogControlMessage = null,
                        xrayLogControlError = error.toCompanionLoadMessage(
                            if (enabled) {
                                "Не удалось включить запись логов Xray."
                            } else {
                                "Не удалось полностью остановить запись логов Xray."
                            },
                        ),
                        connection = LogsConnectionState.Disconnected,
                        statusMessage = "Операция логов не выполнена; восстанавливаем поток…",
                        reconnectAttempt = 0,
                    ),
                )
                updateLogsDiagnostic()
            }
        }
    }

    suspend fun refreshXrayLogDevices(refreshRouter: Boolean = true) {
        val endpoint = state.dashboard.endpoint
        if (endpoint.isBlank() || state.phase != AppPhase.Ready || state.logs.isLoadingDevices) return
        state = state.copy(
            logs = state.logs.copy(
                isLoadingDevices = true,
                devicesError = null,
            ),
        )
        try {
            val snapshot = dependencies.xrayLogsControl.loadDevices(endpoint, refreshRouter)
            if (state.dashboard.endpoint != endpoint || state.phase != AppPhase.Ready) return
            applyXrayLogDevicesSnapshot(snapshot)
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(logs = state.logs.copy(isLoadingDevices = false))
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    logs = state.logs.copy(
                        isLoadingDevices = false,
                        devicesError = error.toCompanionLoadMessage("Не удалось загрузить имена устройств."),
                    ),
                )
            }
        }
    }

    suspend fun saveXrayLogDevice(ip: String, name: String): Boolean {
        val endpoint = state.dashboard.endpoint
        if (endpoint.isBlank() || state.phase != AppPhase.Ready || state.logs.isLoadingDevices) return false
        if (ip.isBlank() || name.isBlank()) {
            state = state.copy(
                logs = state.logs.copy(
                    devicesError = if (ip.isBlank()) "Введите IP-адрес устройства." else "Введите имя устройства.",
                ),
            )
            return false
        }
        state = state.copy(logs = state.logs.copy(isLoadingDevices = true, devicesError = null))
        return try {
            val snapshot = dependencies.xrayLogsControl.saveDevice(endpoint, ip, name)
            if (state.dashboard.endpoint != endpoint || state.phase != AppPhase.Ready) return false
            applyXrayLogDevicesSnapshot(snapshot)
            true
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(logs = state.logs.copy(isLoadingDevices = false))
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return false
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    logs = state.logs.copy(
                        isLoadingDevices = false,
                        devicesError = error.toCompanionLoadMessage("Не удалось сохранить имя устройства."),
                    ),
                )
            }
            false
        }
    }

    suspend fun deleteXrayLogDevice(ip: String): Boolean {
        val endpoint = state.dashboard.endpoint
        if (endpoint.isBlank() || state.phase != AppPhase.Ready || state.logs.isLoadingDevices) return false
        state = state.copy(logs = state.logs.copy(isLoadingDevices = true, devicesError = null))
        return try {
            val snapshot = dependencies.xrayLogsControl.deleteDevice(endpoint, ip)
            if (state.dashboard.endpoint != endpoint || state.phase != AppPhase.Ready) return false
            applyXrayLogDevicesSnapshot(snapshot)
            true
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(logs = state.logs.copy(isLoadingDevices = false))
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return false
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    logs = state.logs.copy(
                        isLoadingDevices = false,
                        devicesError = error.toCompanionLoadMessage("Не удалось удалить имя устройства."),
                    ),
                )
            }
            false
        }
    }

    /** Clears only the native viewer. Server log files and their cursors are left untouched. */
    fun clearXrayLogsView() {
        state = state.copy(
            logs = state.logs.copy(
                entries = state.logs.entries.filterNot { entry ->
                    entry.isXrayLogEntry()
                },
            ),
        )
    }

    /**
     * Starts one cursor-polling ownership generation.  Compose cancels this suspend call while
     * the process is backgrounded; the generation also makes a late response from the old
     * foreground harmless when a new lifecycle pass begins.
     */
    suspend fun runLogsTransport() {
        if (state.phase != AppPhase.Ready || state.logs.isPausedByUser) return
        val generation = ++logsTransportGeneration
        var reconnectAttempt = 0
        state = state.copy(
            logs = state.logs.copy(
                connection = if (state.logs.hasLoadedHistory) {
                    LogsConnectionState.Reconnecting
                } else {
                    LogsConnectionState.Connecting
                },
                statusMessage = if (state.logs.hasLoadedHistory) {
                    "Возобновляем поток логов…"
                } else {
                    "Загружаем историю логов…"
                },
                reconnectAttempt = 0,
            ),
        )
        updateLogsDiagnostic()

        while (generation == logsTransportGeneration && state.phase == AppPhase.Ready) {
            try {
                val update = dependencies.logsTransport.read(
                    baseUrl = state.dashboard.endpoint,
                    cursors = logCursors.toMap(),
                    limit = state.logs.displayLimit.coerceAtMost(500),
                    includeDomainHintsSeed = "domain-hints-seed" !in logCursors,
                )
                if (generation != logsTransportGeneration || state.phase != AppPhase.Ready) return
                applyLogsTransportUpdate(update)
                reconnectAttempt = 0
                delay(LOGS_POLL_INTERVAL_MILLIS)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (generation != logsTransportGeneration || state.phase != AppPhase.Ready) return
                if (error.isAuthenticationRequired()) {
                    state = state.copy(
                        logs = state.logs.copy(
                            connection = LogsConnectionState.AuthRequired,
                            statusMessage = "Сессия для потока логов истекла. Требуется вход.",
                        ),
                    )
                    updateLogsDiagnostic()
                    returnToLoginForExpiredSession(error)
                    return
                }
                reconnectAttempt += 1
                state = state.copy(
                    logs = state.logs.copy(
                        connection = LogsConnectionState.Reconnecting,
                        statusMessage = "Поток логов временно недоступен: ${error.toCompanionLoadMessage("повторяем подключение")}",
                        reconnectAttempt = reconnectAttempt,
                    ),
                )
                updateLogsDiagnostic()
                delay(logReconnectDelayMillis(reconnectAttempt))
            }
        }
    }

    /** Pause only the transport.  Buffered history and the rest of the workspace stay intact. */
    fun pauseLogsTransport() {
        logsTransportGeneration += 1
        if (
            state.phase != AppPhase.Ready ||
            state.logs.connection == LogsConnectionState.AuthRequired ||
            state.logs.isPausedByUser ||
            (state.logs.connection == LogsConnectionState.Disconnected && !state.logs.hasLoadedHistory)
        ) {
            return
        }
        state = state.copy(
            logs = state.logs.copy(
                connection = LogsConnectionState.Disconnected,
                statusMessage = "Поток логов приостановлен. Загруженная история сохранена.",
                reconnectAttempt = 0,
            ),
        )
        updateLogsDiagnostic()
    }

    fun selectPortsDocument(documentId: PortsDocumentId) {
        val current = state.portsEditor
        if (current.isSaving || current.selectedId == documentId) return
        state = state.copy(
            portsEditor = current.copy(
                selectedId = documentId,
                message = current.documents.firstOrNull { it.id == documentId }
                    ?.takeIf(PortsEditorDocument::hasLoaded)
                    ?.let { "${it.id.fileName} открыт." }
                    ?: "Загружаем ${documentId.fileName}…",
                error = null,
            ),
        )
    }

    suspend fun loadSelectedPortsDocument(force: Boolean = false) {
        val endpoint = state.dashboard.endpoint
        val documentId = state.portsEditor.selectedId
        val document = state.portsEditor.documents.firstOrNull { it.id == documentId } ?: return
        if (endpoint.isBlank() || state.portsEditor.isSaving || document.isLoading) return
        if (!force && document.hasLoaded) return

        state = state.copy(
            portsEditor = state.portsEditor.copy(
                documents = state.portsEditor.documents.replacePortsDocument(
                    document.copy(isLoading = true, error = null),
                ),
                message = "Загружаем ${documentId.fileName}…",
                error = null,
            ),
        )
        try {
            val content = dependencies.portsEditor.load(endpoint, documentId)
            if (state.dashboard.endpoint != endpoint) return
            val current = state.portsEditor.documents.firstOrNull { it.id == documentId } ?: return
            state = state.copy(
                portsEditor = state.portsEditor.copy(
                    documents = state.portsEditor.documents.replacePortsDocument(
                        current.copy(
                            content = content,
                            savedContent = content,
                            hasLoaded = true,
                            isLoading = false,
                            error = null,
                        ),
                    ),
                    message = "${documentId.fileName} загружен.",
                    error = null,
                ),
            )
        } catch (error: CancellationException) {
            val current = state.portsEditor.documents.firstOrNull { it.id == documentId }
            if (state.dashboard.endpoint == endpoint && current != null) {
                state = state.copy(
                    portsEditor = state.portsEditor.copy(
                        documents = state.portsEditor.documents.replacePortsDocument(
                            current.copy(isLoading = false),
                        ),
                    ),
                )
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint != endpoint) return
            val message = error.toCompanionLoadMessage("Не удалось загрузить ${documentId.fileName}.")
            val current = state.portsEditor.documents.firstOrNull { it.id == documentId } ?: return
            state = state.copy(
                portsEditor = state.portsEditor.copy(
                    documents = state.portsEditor.documents.replacePortsDocument(
                        current.copy(isLoading = false, error = message),
                    ),
                    message = message,
                    error = message,
                ),
            )
        }
    }

    fun updatePortsDocument(value: String) {
        val current = state.portsEditor
        val document = current.selectedDocument ?: return
        if (!document.hasLoaded || current.isBusy || value == document.content) return
        state = state.copy(
            portsEditor = current.copy(
                documents = current.documents.replacePortsDocument(document.copy(content = value)),
                message = "${document.id.fileName} изменён. Сохранение перезапустит xkeen.",
                error = null,
            ),
        )
    }

    fun revertPortsDocument() {
        val current = state.portsEditor
        val document = current.selectedDocument ?: return
        if (current.isBusy || !document.hasChanges) return
        state = state.copy(
            portsEditor = current.copy(
                documents = current.documents.replacePortsDocument(
                    document.copy(content = document.savedContent),
                ),
                message = "Локальные изменения ${document.id.fileName} отменены.",
                error = null,
            ),
        )
    }

    suspend fun savePortsDocument() {
        val endpoint = state.dashboard.endpoint
        val current = state.portsEditor
        val document = current.selectedDocument ?: return
        if (endpoint.isBlank() || current.isBusy || !document.hasChanges) return

        state = state.copy(
            portsEditor = current.copy(
                isSaving = true,
                message = "Проверяем и сохраняем ${document.id.fileName}…",
                error = null,
            ),
        )
        try {
            if (document.id.isJson) {
                try {
                    JSONObject(document.content)
                } catch (error: Exception) {
                    throw PortsEditorException(
                        "xkeen.json содержит некорректный JSON. Исправьте синтаксис перед сохранением.",
                        error,
                    )
                }
            }
            val fresh = dependencies.portsEditor.load(endpoint, document.id)
            if (fresh != document.savedContent) {
                throw PortsEditorException(
                    "${document.id.fileName} изменился на сервере после открытия. " +
                        "Локальная перезапись остановлена; отмените изменения и обновите файл с сервера.",
                )
            }
            val result = dependencies.portsEditor.save(
                baseUrl = endpoint,
                document = document.id,
                content = document.content,
                restart = true,
            )
            if (state.dashboard.endpoint != endpoint || state.portsEditor.selectedId != document.id) return
            val saved = document.copy(savedContent = document.content)
            val message = if (result.restarted) {
                "${document.id.fileName} сохранён; xkeen перезапущен."
            } else {
                "${document.id.fileName} сохранён, но перезапуск xkeen не подтверждён."
            }
            state = state.copy(
                portsEditor = state.portsEditor.copy(
                    documents = state.portsEditor.documents.replacePortsDocument(saved),
                    isSaving = false,
                    message = message,
                    error = null,
                ),
                dashboard = state.dashboard.copy(
                    lastOperation = "Сохранён ${document.id.fileName}",
                    lastError = null,
                ),
                logs = recordLog(
                    source = "ports",
                    level = if (result.restarted) LogLevel.Info else LogLevel.Warning,
                    message = message,
                ),
            )
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(portsEditor = state.portsEditor.copy(isSaving = false))
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint && state.portsEditor.selectedId == document.id) {
                val message = error.toCompanionLoadMessage("Не удалось сохранить ${document.id.fileName}.")
                state = state.copy(
                    portsEditor = state.portsEditor.copy(
                        isSaving = false,
                        message = message,
                        error = message,
                    ),
                )
            }
        }
    }

    suspend fun refreshMihomoConfig(force: Boolean = false) {
        val endpoint = state.dashboard.endpoint
        val current = state.mihomoConfig
        if (endpoint.isBlank() || current.isBusy || (!force && current.hasLoaded)) return
        state = state.copy(
            mihomoConfig = current.copy(
                operation = MihomoConfigOperationPhase.Loading,
                message = "Загружаем активный YAML-профиль Mihomo…",
                validationLog = "",
            ),
        )
        try {
            val snapshot = dependencies.mihomoConfig.load(endpoint)
            if (state.dashboard.endpoint != endpoint) return
            state = state.copy(
                mihomoConfig = MihomoConfigState(
                    content = snapshot.content,
                    savedContent = snapshot.content,
                    activeProfile = snapshot.activeProfile,
                    hasLoaded = true,
                    operation = MihomoConfigOperationPhase.Idle,
                    message = "Активный YAML-профиль загружен.",
                ),
            )
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    mihomoConfig = state.mihomoConfig.copy(operation = MihomoConfigOperationPhase.Idle),
                )
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    mihomoConfig = state.mihomoConfig.copy(
                        operation = MihomoConfigOperationPhase.Failure,
                        message = error.toCompanionLoadMessage("Не удалось загрузить config.yaml Mihomo."),
                    ),
                )
            }
        }
    }

    fun updateMihomoConfig(value: String) {
        val current = state.mihomoConfig
        if (!current.hasLoaded || current.isBusy || value == current.content) return
        state = state.copy(
            mihomoConfig = current.copy(
                content = value,
                operation = MihomoConfigOperationPhase.Idle,
                message = "YAML изменён. Перед сохранением проверьте его ядром Mihomo.",
                validationLog = "",
                validatedContent = null,
                editorHighlight = null,
            ),
        )
    }

    fun revertMihomoConfig() {
        val current = state.mihomoConfig
        if (!current.hasLoaded || current.isBusy || !current.hasChanges) return
        state = state.copy(
            mihomoConfig = current.copy(
                content = current.savedContent,
                operation = MihomoConfigOperationPhase.Idle,
                message = "Локальные изменения отменены.",
                validationLog = "",
                validatedContent = null,
                editorHighlight = null,
            ),
        )
    }

    suspend fun validateMihomoConfig() {
        val endpoint = state.dashboard.endpoint
        val content = state.mihomoConfig.content
        if (endpoint.isBlank() || content.isBlank() || state.mihomoConfig.isBusy) return
        state = state.copy(
            mihomoConfig = state.mihomoConfig.copy(
                operation = MihomoConfigOperationPhase.Validating,
                message = "Проверяем YAML через mihomo -t…",
                validationLog = "",
                validatedContent = null,
            ),
        )
        try {
            val result = dependencies.mihomoConfig.validate(endpoint, content)
            if (state.dashboard.endpoint != endpoint || state.mihomoConfig.content != content) return
            state = state.copy(
                mihomoConfig = state.mihomoConfig.copy(
                    operation = if (result.valid) {
                        MihomoConfigOperationPhase.Success
                    } else {
                        MihomoConfigOperationPhase.Failure
                    },
                    message = if (result.valid) {
                        "Mihomo подтвердил корректность YAML."
                    } else {
                        "Mihomo отклонил YAML; исправьте ошибки перед сохранением."
                    },
                    validationLog = result.log,
                    validatedContent = content.takeIf { result.valid },
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint && state.mihomoConfig.content == content) {
                state = state.copy(
                    mihomoConfig = state.mihomoConfig.copy(
                        operation = MihomoConfigOperationPhase.Failure,
                        message = error.toCompanionLoadMessage("Не удалось проверить YAML Mihomo."),
                    ),
                )
            }
        }
    }

    suspend fun saveMihomoConfig(restart: Boolean) {
        val endpoint = state.dashboard.endpoint
        val content = state.mihomoConfig.content
        val current = state.mihomoConfig
        if (
            endpoint.isBlank() || content.isBlank() || current.isBusy || !current.hasChanges ||
            current.validatedContent != content
        ) {
            return
        }
        state = state.copy(
            mihomoConfig = current.copy(
                operation = if (restart) {
                    MihomoConfigOperationPhase.Restarting
                } else {
                    MihomoConfigOperationPhase.Saving
                },
                message = if (restart) {
                    "Сохраняем YAML и перезапускаем Mihomo…"
                } else {
                    "Сохраняем YAML с резервной копией…"
                },
            ),
        )
        try {
            val fresh = dependencies.mihomoConfig.load(endpoint)
            if (fresh.content != current.savedContent) {
                throw MihomoConfigException(
                    "config.yaml изменился на сервере после открытия. Локальная перезапись остановлена; отмените изменения и загрузите файл заново.",
                )
            }
            val snapshot = dependencies.mihomoConfig.save(endpoint, content, restart)
            if (state.dashboard.endpoint != endpoint || state.mihomoConfig.content != content) return
            state = state.copy(
                mihomoConfig = state.mihomoConfig.copy(
                    content = snapshot.content,
                    savedContent = snapshot.content,
                    activeProfile = snapshot.activeProfile,
                    operation = MihomoConfigOperationPhase.Success,
                    message = if (restart) {
                        "YAML сохранён; Mihomo перезапущен."
                    } else {
                        "YAML сохранён в активный профиль."
                    },
                    validatedContent = snapshot.content,
                    editorHighlight = null,
                ),
                dashboard = state.dashboard.copy(
                    lastOperation = if (restart) "Mihomo YAML сохранён и применён" else "Mihomo YAML сохранён",
                ),
                logs = recordLog(
                    source = "mihomo",
                    level = LogLevel.Info,
                    message = if (restart) "config.yaml сохранён и Mihomo перезапущен" else "config.yaml сохранён",
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint && state.mihomoConfig.content == content) {
                state = state.copy(
                    mihomoConfig = state.mihomoConfig.copy(
                        operation = MihomoConfigOperationPhase.Failure,
                        message = error.toCompanionLoadMessage("Не удалось сохранить YAML Mihomo."),
                    ),
                )
            }
        }
    }

    suspend fun refreshMihomoTemplates(force: Boolean = false) {
        val endpoint = state.dashboard.endpoint
        val current = state.mihomoTemplates
        if (endpoint.isBlank() || current.isBusy || (!force && current.hasLoaded)) return
        state = state.copy(
            mihomoTemplates = current.copy(
                isLoadingList = true,
                message = "Загружаем шаблоны Mihomo…",
                error = null,
            ),
        )
        try {
            val templates = dependencies.mihomoTemplates.list(endpoint)
            if (state.dashboard.endpoint != endpoint) return
            val selectedName = state.mihomoTemplates.selectedName?.takeIf { selected ->
                templates.any { it.name == selected }
            }
            state = state.copy(
                mihomoTemplates = state.mihomoTemplates.copy(
                    templates = templates,
                    selectedName = selectedName,
                    selectedContent = state.mihomoTemplates.selectedContent.takeIf {
                        selectedName != null
                    }.orEmpty(),
                    hasLoaded = true,
                    isLoadingList = false,
                    message = if (templates.isEmpty()) {
                        "Шаблоны Mihomo не найдены."
                    } else {
                        "Загружено шаблонов: ${templates.size}."
                    },
                    error = null,
                ),
            )
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    mihomoTemplates = state.mihomoTemplates.copy(isLoadingList = false),
                )
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint) {
                val message = error.toCompanionLoadMessage("Не удалось загрузить шаблоны Mihomo.")
                state = state.copy(
                    mihomoTemplates = state.mihomoTemplates.copy(
                        isLoadingList = false,
                        message = message,
                        error = message,
                    ),
                )
            }
        }
    }

    suspend fun loadMihomoTemplate(name: String, force: Boolean = false) {
        val endpoint = state.dashboard.endpoint
        val current = state.mihomoTemplates
        if (
            endpoint.isBlank() || name.isBlank() || current.isBusy ||
            (!force && current.selectedName == name)
        ) {
            return
        }
        state = state.copy(
            mihomoTemplates = current.copy(
                isLoadingTemplate = true,
                message = "Загружаем шаблон $name…",
                error = null,
            ),
        )
        try {
            val content = dependencies.mihomoTemplates.load(endpoint, name)
            if (state.dashboard.endpoint != endpoint) return
            state = state.copy(
                mihomoTemplates = state.mihomoTemplates.copy(
                    selectedName = name,
                    selectedContent = content,
                    isLoadingTemplate = false,
                    message = "Шаблон $name загружен для просмотра.",
                    error = null,
                ),
            )
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(
                    mihomoTemplates = state.mihomoTemplates.copy(isLoadingTemplate = false),
                )
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint) {
                val message = error.toCompanionLoadMessage("Не удалось загрузить шаблон $name.")
                state = state.copy(
                    mihomoTemplates = state.mihomoTemplates.copy(
                        isLoadingTemplate = false,
                        message = message,
                        error = message,
                    ),
                )
            }
        }
    }

    fun closeMihomoTemplatePreview() {
        val templates = state.mihomoTemplates
        if (templates.isBusy || templates.selectedName == null) return
        state = state.copy(
            mihomoTemplates = templates.copy(
                selectedName = null,
                selectedContent = "",
                message = "Просмотр шаблона закрыт.",
                error = null,
            ),
        )
    }

    fun applySelectedMihomoTemplateToEditor() {
        val templates = state.mihomoTemplates
        val name = templates.selectedName ?: return
        val config = state.mihomoConfig
        if (!config.hasLoaded || config.isBusy || templates.isBusy) {
            state = state.copy(
                mihomoTemplates = templates.copy(
                    message = "Сначала дождитесь загрузки активного config.yaml.",
                    error = "Активный config.yaml ещё не загружен.",
                ),
            )
            return
        }
        state = state.copy(
            mainTab = MainTab.Home,
            workspaceSection = WorkspaceSection.MihomoRouting,
            mihomoConfig = config.copy(
                content = templates.selectedContent,
                operation = MihomoConfigOperationPhase.Idle,
                message = "Шаблон $name загружен в редактор. Проверьте YAML перед сохранением.",
                validationLog = "",
                validatedContent = null,
                editorHighlight = null,
            ),
            mihomoTemplates = templates.copy(
                message = "Шаблон $name передан в редактор config.yaml.",
                error = null,
            ),
            logs = recordLog(
                source = "mihomo",
                level = LogLevel.Info,
                message = "Шаблон $name загружен в редактор config.yaml",
            ),
        )
    }

    fun updateMihomoNodeSource(value: String) {
        val current = state.mihomoNode
        if (current.isImporting || value == current.source) return
        state = state.copy(
            mihomoNode = current.copy(
                source = value,
                message = "Источник готов к добавлению в черновик config.yaml.",
                error = null,
                lastInsertedNames = emptyList(),
            ),
        )
    }

    fun closeMihomoNodeWorkspace() {
        if (state.mihomoNode.isImporting) return
        state = state.copy(
            mainTab = MainTab.Home,
            workspaceSection = WorkspaceSection.MihomoRouting,
        )
    }

    fun selectMihomoNodeMode(mode: MihomoNodeImportMode) {
        val current = state.mihomoNode
        if (current.isImporting || mode == current.mode) return
        state = state.copy(
            mihomoNode = current.copy(
                mode = mode,
                message = "Выбран тип: ${mode.displayName}.",
                error = null,
                lastInsertedNames = emptyList(),
            ),
        )
    }

    fun toggleMihomoNodeGroup(name: String) {
        val cleanName = name.trim()
        val current = state.mihomoNode
        if (current.isImporting || cleanName.isBlank()) return
        val groups = current.selectedGroups.toMutableSet()
        if (!groups.add(cleanName)) groups.remove(cleanName)
        state = state.copy(mihomoNode = current.copy(selectedGroups = groups, error = null))
    }

    fun setAllMihomoNodeGroups(names: List<String>, selected: Boolean) {
        val current = state.mihomoNode
        if (current.isImporting) return
        state = state.copy(
            mihomoNode = current.copy(
                selectedGroups = if (selected) names.map(String::trim).filter(String::isNotBlank).toSet() else emptySet(),
                error = null,
            ),
        )
    }

    fun updateMihomoNodeAutoUpdate(enabled: Boolean) {
        val current = state.mihomoNode
        if (current.isImporting || current.autoUpdateSubscriptions == enabled) return
        state = state.copy(
            mihomoNode = current.copy(
                autoUpdateSubscriptions = enabled,
                error = null,
            ),
        )
    }

    fun updateMihomoNodeInterval(hours: Int) {
        val current = state.mihomoNode
        val safeHours = hours.coerceIn(1, 168)
        if (current.isImporting || current.subscriptionIntervalHours == safeHours) return
        state = state.copy(
            mihomoNode = current.copy(
                subscriptionIntervalHours = safeHours,
                error = null,
            ),
        )
    }

    suspend fun importMihomoNodeDraft() {
        val endpoint = state.dashboard.endpoint
        val node = state.mihomoNode
        val config = state.mihomoConfig
        if (endpoint.isBlank() || node.isImporting || config.isBusy) return
        if (!config.hasLoaded || config.content.isBlank()) {
            val message = "Сначала загрузите активный config.yaml Mihomo."
            state = state.copy(mihomoNode = node.copy(message = message, error = message))
            return
        }
        if (node.source.isBlank()) {
            val message = "Вставьте ссылку узла, подписку или конфигурацию."
            state = state.copy(mihomoNode = node.copy(message = message, error = message))
            return
        }
        state = state.copy(
            mihomoNode = node.copy(
                isImporting = true,
                message = "Разбираем источник и обновляем черновик…",
                error = null,
            ),
        )
        try {
            val result = dependencies.mihomoNode.importDraft(
                endpoint,
                MihomoNodeImportRequest(
                    content = config.content,
                    source = node.source,
                    mode = node.mode,
                    groups = node.selectedGroups.filter { it in mihomoProxyGroupNames(config.content) }.sorted(),
                    autoUpdateSubscriptions = node.autoUpdateSubscriptions,
                    intervalHours = node.subscriptionIntervalHours,
                ),
            )
            if (state.dashboard.endpoint != endpoint) return
            if (state.mihomoConfig.content != config.content) {
                state = state.copy(
                    mihomoNode = state.mihomoNode.copy(
                        isImporting = false,
                        message = "Черновик config.yaml изменился во время импорта. Повторите добавление узла.",
                        error = "Результат импорта не применён к изменившемуся черновику.",
                    ),
                )
                return
            }
            val names = result.insertedNames
            val count = names.size
            val skipped = result.skippedCount.takeIf { it > 0 }?.let { " Пропущено: $it." }.orEmpty()
            val baseMessage = if (result.insertedKind == "provider") {
                "Источник добавлен в proxy-providers. Проверьте выделенный фрагмент.$skipped"
            } else if (result.insertedKind == "mixed") {
                "Добавлено элементов: $count. Проверьте выделенный фрагмент.$skipped"
            } else {
                "Добавлено узлов: $count. Проверьте выделенный фрагмент.$skipped"
            }
            val refreshMessage = when {
                !result.subscriptionWarning.isNullOrBlank() -> " Автообновление не сохранено: ${result.subscriptionWarning}"
                result.registeredSubscriptions > 0 -> " Автообновление подписок: ${result.registeredSubscriptions}."
                else -> ""
            }
            val message = baseMessage + refreshMessage
            state = state.copy(
                mainTab = MainTab.Home,
                workspaceSection = WorkspaceSection.MihomoRouting,
                mihomoConfig = config.copy(
                    content = result.content,
                    operation = MihomoConfigOperationPhase.Idle,
                    message = message,
                    validationLog = "",
                    validatedContent = null,
                    editorHighlight = MihomoEditorHighlight(
                        start = result.highlightStart,
                        end = result.highlightEnd,
                        token = System.nanoTime(),
                    ),
                ),
                mihomoNode = state.mihomoNode.copy(
                    source = "",
                    isImporting = false,
                    message = message,
                    error = null,
                    lastInsertedNames = names,
                ),
                logs = recordLog(
                    source = "mihomo",
                    level = LogLevel.Info,
                    message = "Узел Mihomo добавлен в черновик config.yaml: ${names.joinToString()}",
                ),
            )
        } catch (error: CancellationException) {
            if (state.dashboard.endpoint == endpoint) {
                state = state.copy(mihomoNode = state.mihomoNode.copy(isImporting = false))
            }
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            if (state.dashboard.endpoint == endpoint) {
                val message = error.toCompanionLoadMessage("Не удалось добавить узел Mihomo.")
                state = state.copy(
                    mihomoNode = state.mihomoNode.copy(
                        isImporting = false,
                        message = message,
                        error = message,
                    ),
                )
            }
        }
    }

    fun consumeMihomoEditorHighlight(token: Long) {
        val current = state.mihomoConfig
        if (current.editorHighlight?.token != token) return
        state = state.copy(mihomoConfig = current.copy(editorHighlight = null))
    }

    suspend fun issueTerminalConnection(
        sessionId: String?,
        lastSequence: Long,
        columns: Int,
        rows: Int,
    ): PtyConnectionSpec {
        try {
            return dependencies.terminal.issueConnection(
                baseUrl = state.dashboard.endpoint,
                sessionId = sessionId,
                lastSequence = lastSequence,
                columns = columns,
                rows = rows,
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            returnToLoginForExpiredSession(error)
            throw error
        }
    }

    suspend fun disconnect() {
        val connection = selectedConnection() ?: return
        if (state.isSessionBusy || state.serviceOperation.isPending) return
        state = state.copy(isSessionBusy = true)
        val result = try {
            dependencies.session.disconnect(connection)
        } catch (_: Exception) {
            dependencies.session.expire(connection).copy(
                statusSummary = "Сессия удалена с устройства",
                logMessage = "Локальная мобильная сессия удалена после ошибки выхода на сервере",
            )
        }
        closeSession(
            result = result,
            phase = AppPhase.Connections,
            message = null,
        )
    }

    private fun openSession(result: SessionOpenResult) {
        val eventTime = dependencies.journal.shortTime()
        val updatedConnections = state.connections.replaceConnection(result.connection)
        dependencies.connections.update(result.connection)
        logsTransportGeneration += 1
        xrayLogsControlGeneration += 1
        logCursors.clear()
        xrayLogDomainResolver.clear()
        val newLogs = dependencies.logs.record(
            current = LogsState(),
            source = "auth",
            level = LogLevel.Info,
            message = result.logMessage,
        )
        val workspaceDashboard = unloadedDashboardState().copy(
            instanceLabel = result.connection.name,
            endpoint = result.connection.baseUrl,
            statusSummary = "Сессия открыта; загружаем подтверждённое состояние узла…",
            lastOperation = result.lastOperation,
            recentEvents = listOf(
                RecentEvent(eventTime, result.eventTitle, result.eventSubtitle),
            ),
        )
        state = state.copy(
            phase = AppPhase.Ready,
            connections = updatedConnections,
            loginForm = state.loginForm.copy(password = ""),
            keeneticLoginForm = state.keeneticLoginForm.copy(password = ""),
            isKeeneticAuthRequired = false,
            isSessionBusy = false,
            isWorkspaceRefreshing = false,
            sessionMessage = null,
            dashboard = workspaceDashboard,
            routing = unloadedRoutingState(),
            inbounds = unloadedInboundsState(),
            outbounds = unloadedOutboundsState(),
            xraySubscriptions = unloadedXraySubscriptionsState(),
            xrayDat = unloadedXrayDatState(),
            mihomoConfig = unloadedMihomoConfigState(),
            mihomoTemplates = unloadedMihomoTemplatesState(),
            mihomoNode = unloadedMihomoNodeState(),
            portsEditor = unloadedPortsEditorState(),
            diagnostics = initialDiagnostics().replaceDiagnostic(
                label = "Мобильная сессия",
                status = "Готово",
                severity = DiagnosticSeverity.Ok,
            ),
            logs = newLogs,
            serviceOperation = ServiceOperationState(),
            pendingAction = null,
        )
    }

    private fun updateSessionStatus(result: SessionPairResult.Status) {
        val updatedConnections = state.connections.replaceConnection(result.connection)
        dependencies.connections.update(result.connection)
        state = state.copy(
            phase = AppPhase.PairLogin,
            connections = updatedConnections,
            keeneticLoginForm = state.keeneticLoginForm.copy(password = ""),
            isKeeneticAuthRequired = false,
            isSessionBusy = false,
            isWorkspaceRefreshing = false,
            sessionMessage = result.message,
            dashboard = state.dashboard.copy(statusSummary = result.statusSummary),
            diagnostics = state.diagnostics.replaceDiagnostic(
                label = "Мобильная сессия",
                status = result.statusSummary,
                severity = DiagnosticSeverity.Warning,
            ),
            logs = recordLog("auth", LogLevel.Warning, result.message),
        )
    }

    private fun closeSession(
        result: SessionCloseResult,
        phase: AppPhase,
        message: String?,
    ) {
        val updatedConnections = state.connections.replaceConnection(result.connection)
        dependencies.connections.update(result.connection)
        logsTransportGeneration += 1
        xrayLogsControlGeneration += 1
        logCursors.clear()
        xrayLogDomainResolver.clear()
        val closedLogs = dependencies.logs.record(
            current = state.logs.copy(
                connection = if (phase == AppPhase.PairLogin) {
                    LogsConnectionState.AuthRequired
                } else {
                    LogsConnectionState.Disconnected
                },
                statusMessage = if (phase == AppPhase.PairLogin) {
                    "Для потока логов требуется вход."
                } else {
                    "Поток логов отключён."
                },
                reconnectAttempt = 0,
            ),
            source = "auth",
            level = LogLevel.Warning,
            message = result.logMessage,
        )
        state = state.copy(
            phase = phase,
            connections = updatedConnections,
            loginForm = state.loginForm.copy(password = ""),
            keeneticLoginForm = state.keeneticLoginForm.copy(password = ""),
            isKeeneticAuthRequired = false,
            isSessionBusy = false,
            isWorkspaceRefreshing = false,
            sessionMessage = message,
            mainTab = MainTab.Routing,
            workspaceSection = WorkspaceSection.XrayRouting,
            dashboard = state.dashboard.copy(statusSummary = result.statusSummary),
            inbounds = unloadedInboundsState(),
            outbounds = unloadedOutboundsState(),
            xraySubscriptions = unloadedXraySubscriptionsState(),
            xrayDat = unloadedXrayDatState(),
            mihomoConfig = unloadedMihomoConfigState(),
            mihomoTemplates = unloadedMihomoTemplatesState(),
            mihomoNode = unloadedMihomoNodeState(),
            portsEditor = unloadedPortsEditorState(),
            diagnostics = state.diagnostics.replaceDiagnostic(
                label = "Мобильная сессия",
                status = result.statusSummary,
                severity = DiagnosticSeverity.Warning,
            ),
            logs = closedLogs,
            serviceOperation = ServiceOperationState(),
            pendingAction = null,
        )
    }

    private fun sessionFailed(error: Exception, action: String) {
        val message = "$action: ${sessionErrorMessage(error)}"
        state = state.copy(
            isSessionBusy = false,
            sessionMessage = message,
            dashboard = state.dashboard.copy(statusSummary = action),
            logs = recordLog("auth", LogLevel.Warning, message),
        )
    }

    private fun requireKeeneticLogin(error: Throwable, action: String): Boolean {
        val failure = (error as? CompanionTransportException)?.failure ?: return false
        if (failure.kind != CompanionTransportFailureKind.KeeneticAuthenticationRequired) {
            return false
        }
        val message = "$action: ${failure.userMessage}"
        logsTransportGeneration += 1
        state = state.copy(
            phase = AppPhase.PairLogin,
            isKeeneticAuthRequired = true,
            keeneticLoginForm = state.keeneticLoginForm.copy(password = ""),
            isSessionBusy = false,
            sessionMessage = message,
            dashboard = state.dashboard.copy(statusSummary = "Требуется вход в Keenetic"),
            logs = recordLog("auth", LogLevel.Warning, message),
        )
        return true
    }

    /**
     * A 401 from an authenticated workspace endpoint means the stored server session no longer
     * exists.  Clear only this node's material and make the required re-login explicit instead of
     * leaving the user in a superficially ready workspace with failing reads.
     */
    private fun returnToLoginForExpiredSession(error: Throwable): Boolean {
        val failure = (error as? CompanionTransportException)?.failure ?: return false
        if (failure.kind == CompanionTransportFailureKind.KeeneticAuthenticationRequired) {
            return requireKeeneticLogin(error, "Удалённая сессия Keenetic истекла")
        }
        if (failure.kind != CompanionTransportFailureKind.AuthenticationRequired) {
            return false
        }
        val connection = selectedConnection() ?: return false
        closeSession(
            result = dependencies.session.expire(connection),
            phase = AppPhase.PairLogin,
            message = "Сессия на Xkeen UI истекла. Войдите снова.",
        )
        return true
    }

    private suspend fun performServiceAction(action: ServiceAction) {
        if (state.serviceOperation.isPending) return
        val endpoint = state.dashboard.endpoint
        val pendingMessage = when (action) {
            ServiceAction.Start -> "Запускаем xkeen и ждём подтверждение сервера…"
            ServiceAction.Stop -> "Останавливаем xkeen и ждём подтверждение сервера…"
            ServiceAction.Restart -> "Перезапускаем xkeen и ждём подтверждение сервера…"
        }
        state = state.copy(
            serviceOperation = ServiceOperationState(
                phase = ServiceOperationPhase.Pending,
                action = action,
                message = pendingMessage,
            ),
            dashboard = state.dashboard.copy(
                statusSummary = pendingMessage,
                lastOperation = "Выполняется: ${action.label.lowercase()}",
                lastError = null,
            ),
        )

        try {
            val result = dependencies.serviceActions.perform(endpoint, action)
            val actionTime = dependencies.journal.shortTime()
            applyConfirmedServiceSnapshot(result.snapshot)
            state = state.copy(
                serviceOperation = ServiceOperationState(
                    phase = ServiceOperationPhase.Success,
                    action = action,
                    message = result.statusSummary,
                ),
                dashboard = state.dashboard.copy(
                    statusSummary = result.statusSummary,
                    lastOperation = result.lastOperation,
                    lastError = null,
                    recentEvents = listOf(
                        RecentEvent(actionTime, result.eventTitle, result.eventSubtitle),
                    ) + state.dashboard.recentEvents.take(2),
                ),
                logs = recordLog("service", LogLevel.Info, result.logMessage),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            serviceOperationFailed(
                endpoint = endpoint,
                error = error,
                fallback = "Не удалось выполнить действие «${action.label}».",
                action = action,
            )
        }
    }

    private suspend fun serviceOperationFailed(
        endpoint: String,
        error: Exception,
        fallback: String,
        action: ServiceAction? = null,
        targetCore: String? = null,
    ) {
        if (returnToLoginForExpiredSession(error)) return

        val refreshed = try {
            Result.success(dependencies.serviceActions.load(endpoint))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            Result.failure(error)
        }
        refreshed.onSuccess(::applyConfirmedServiceSnapshot)
        val refreshError = refreshed.exceptionOrNull()
        if (refreshError != null && returnToLoginForExpiredSession(refreshError)) return

        val detail = error.toCompanionLoadMessage(fallback = "Повторите попытку позже.")
        val message = if (detail.trimEnd('.', ' ') == fallback.trimEnd('.', ' ')) {
            fallback
        } else {
            "$fallback $detail"
        }
        state = state.copy(
            serviceOperation = ServiceOperationState(
                phase = ServiceOperationPhase.Failure,
                action = action,
                targetCore = targetCore,
                message = message,
            ),
            dashboard = state.dashboard.copy(
                statusSummary = "Ошибка управления сервисом",
                lastOperation = fallback,
                lastError = message,
            ),
            diagnostics = state.diagnostics.replaceDiagnostic(
                label = "Управление сервисом",
                status = message,
                severity = DiagnosticSeverity.Error,
            ),
            logs = recordLog("service", LogLevel.Error, message),
        )
    }

    private suspend fun applyRouting() {
        val document = selectedRoutingDocument() ?: return
        if (state.routing.write.isPending) return
        state = state.copy(
            routing = state.routing.copy(
                write = RoutingWriteState(
                    phase = RoutingWritePhase.Applying,
                    message = "Применяем сохранённую revision и ждём restart xkeen…",
                ),
            ),
        )
        try {
            val result = dependencies.routingWrites.apply(state.dashboard.endpoint, document)
            val current = selectedRoutingDocument() ?: return
            val draftChangedDuringRequest = current.draftContent != document.draftContent
            val updated = if (draftChangedDuringRequest) {
                result.document.copy(draftContent = current.draftContent)
            } else {
                result.document
            }
            val appliedAt = result.document.lastAppliedAt ?: dependencies.journal.shortTime()
            state = state.copy(
                routing = state.routing.copy(
                    documents = state.routing.documents.replaceDocument(updated),
                    mode = if (draftChangedDuringRequest) RoutingMode.Edit else RoutingMode.Read,
                    validation = if (draftChangedDuringRequest) {
                        RoutingValidation(
                            state = RoutingValidationState.Dirty,
                            message = "Сохранённая revision применена, но новый локальный текст требует проверки.",
                        )
                    } else {
                        result.validation
                    },
                    preview = result.preview,
                    write = RoutingWriteState(
                        phase = RoutingWritePhase.Success,
                        message = "Routing применён; restart xkeen подтверждён сервером.",
                    ),
                ),
                dashboard = state.dashboard.copy(
                    lastOperation = result.lastOperation,
                    lastError = null,
                    recentEvents = listOf(
                        RecentEvent(appliedAt, result.eventTitle, result.eventSubtitle),
                    ) + state.dashboard.recentEvents.take(2),
                ),
                logs = recordLog("routing", LogLevel.Info, result.logMessage),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (returnToLoginForExpiredSession(error)) return
            handleRoutingWriteFailure(error, document, "Не удалось применить routing-конфигурацию.")
        }
    }

    private fun handleRoutingWriteFailure(
        error: Exception,
        requestDocument: RoutingDocument,
        fallback: String,
    ) {
        val conflict = error as? RoutingWriteConflictException
        val current = selectedRoutingDocument() ?: requestDocument
        val serverDocument = conflict?.serverDocument
        val updated = if (serverDocument != null) {
            current.fromServer(serverDocument).copy(draftContent = current.draftContent)
        } else {
            current
        }
        val message = error.message?.takeIf(String::isNotBlank) ?: fallback
        state = state.copy(
            routing = state.routing.copy(
                documents = state.routing.documents.replaceDocument(updated),
                write = RoutingWriteState(
                    phase = if (conflict != null) RoutingWritePhase.Conflict else RoutingWritePhase.Failure,
                    code = conflict?.conflictCode ?: (error as? RoutingWriteException)?.code,
                    message = message,
                ),
            ),
            dashboard = state.dashboard.copy(
                lastOperation = fallback,
                lastError = message,
            ),
            logs = recordLog(
                "routing",
                if (conflict != null) LogLevel.Warning else LogLevel.Error,
                message,
            ),
        )
    }

    private fun publishInboundsFailure(error: Exception, fallback: String) {
        val message = error.message?.takeIf(String::isNotBlank) ?: fallback
        state = state.copy(
            inbounds = state.inbounds.copy(
                isLoading = false,
                isApplying = false,
                message = message,
                error = message,
            ),
            dashboard = state.dashboard.copy(lastError = message),
            logs = recordLog("inbounds", LogLevel.Warning, message),
        )
    }

    private fun publishOutboundsFailure(
        error: Exception,
        fallback: String,
        nodeKey: String? = null,
    ) {
        val message = error.message?.takeIf(String::isNotBlank) ?: fallback
        state = state.copy(
            outbounds = state.outbounds.copy(
                isLoading = false,
                isPingingAll = false,
                pingingNodeKeys = nodeKey?.let { state.outbounds.pingingNodeKeys - it } ?: emptySet(),
                message = message,
                error = message,
            ),
            dashboard = state.dashboard.copy(lastError = message),
            logs = recordLog("outbounds", LogLevel.Warning, message),
        )
    }

    private fun publishOutboundsEditorFailure(error: Exception, fallback: String) {
        val message = error.message?.takeIf(String::isNotBlank) ?: fallback
        state = state.copy(
            outbounds = state.outbounds.copy(
                editor = state.outbounds.editor.copy(
                    isLoading = false,
                    isSaving = false,
                    message = null,
                    error = message,
                ),
            ),
            dashboard = state.dashboard.copy(lastError = message),
            logs = recordLog("outbounds", LogLevel.Warning, message),
        )
    }

    private fun publishOutboundsPoolEditorFailure(error: Exception, fallback: String) {
        val message = error.message?.takeIf(String::isNotBlank) ?: fallback
        state = state.copy(
            outbounds = state.outbounds.copy(
                poolEditor = state.outbounds.poolEditor.copy(
                    isLoading = false,
                    isSaving = false,
                    message = null,
                    error = message,
                ),
            ),
            dashboard = state.dashboard.copy(lastError = message),
            logs = recordLog("outbounds", LogLevel.Warning, message),
        )
    }

    private fun publishXraySubscriptionsFailure(error: Exception, fallback: String) {
        val message = error.message?.takeIf(String::isNotBlank) ?: fallback
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(
                isLoading = false,
                refreshingIds = emptySet(),
                deletingIds = emptySet(),
                isRefreshingDue = false,
                message = message,
                error = message,
            ),
            dashboard = state.dashboard.copy(lastError = message),
            logs = recordLog("subscriptions", LogLevel.Warning, message),
        )
    }

    private fun publishXraySubscriptionEditorFailure(error: Exception, fallback: String) {
        val message = error.message?.takeIf(String::isNotBlank) ?: fallback
        state = state.copy(
            xraySubscriptions = state.xraySubscriptions.copy(
                editor = state.xraySubscriptions.editor.copy(
                    isPreviewing = false,
                    isSaving = false,
                    message = null,
                    error = message,
                ),
            ),
            dashboard = state.dashboard.copy(lastError = message),
            logs = recordLog("subscriptions", LogLevel.Warning, message),
        )
    }

    private suspend fun loadActiveOutboundOrNull(
        endpoint: String,
        filename: String,
    ): ActiveOutboundSnapshot? = try {
        dependencies.outbounds.loadActive(endpoint, filename)
    } catch (error: CompanionTransportException) {
        if (
            error.failure.kind == CompanionTransportFailureKind.AuthenticationRequired ||
            error.failure.kind == CompanionTransportFailureKind.KeeneticAuthenticationRequired
        ) {
            throw error
        }
        null
    } catch (_: Exception) {
        null
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

    private fun applyLogsTransportUpdate(update: LogsTransportUpdate) {
        val previousEntries = state.logs.entries
        var entries = previousEntries
        if (update.domainHintsSeeded) {
            logCursors["domain-hints-seed"] = "loaded"
        }
        val domainHints = xrayLogDomainResolver.ingest(
            update.domainHintEntries + update.streams.flatMap(RemoteLogStream::entries),
        )
        update.streams.forEach { stream ->
            if (stream.cursor.isNotBlank()) {
                logCursors[stream.source] = stream.cursor
            } else {
                logCursors.remove(stream.source)
            }
            if (!stream.available) return@forEach
            val entryPrefix = "${stream.source}:"
            val incoming = stream.entries
                .asReversed()
                .filter { entry -> entry.id.isNotBlank() }
            entries = when (stream.mode) {
                "snapshot" -> {
                    val retained = entries.filterNot { entry -> entry.id.startsWith(entryPrefix) }
                    (incoming + retained).deduplicateLogEntries()
                }

                else -> (incoming + entries).deduplicateLogEntries()
            }
        }
        val availability = mobileLogSources.associateWith { source ->
            update.streams.firstOrNull { stream -> stream.source == source }?.available == true
        }
        val unavailableCount = availability.count { (_, available) -> !available }
        val message = when {
            unavailableCount == 0 -> "Поток логов подключён и обновляется автоматически."
            unavailableCount == availability.size -> "Подключено, но Xray log-файлы пока недоступны."
            else -> "Поток подключён; часть Xray log-файлов пока недоступна."
        }
        state = state.copy(
            logs = state.logs.copy(
                entries = entries.cappedLogsBuffer(
                    state.logs.displayLimit.coerceIn(MIN_LOGS_ENTRY_LIMIT, LOGS_ENTRY_LIMIT),
                ),
                connection = LogsConnectionState.Connected,
                statusMessage = message,
                reconnectAttempt = 0,
                hasLoadedHistory = true,
                streamAvailability = availability,
                destinationDomainsByIp = domainHints,
            ),
        )
        updateLogsDiagnostic()
    }

    private fun applyXrayLogDevicesSnapshot(snapshot: XrayLogDevicesSnapshot) {
        state = state.copy(
            logs = state.logs.copy(
                devices = snapshot.devices,
                hasLoadedDevices = true,
                isLoadingDevices = false,
                devicesError = null,
                routerDevicesError = snapshot.routerError,
            ),
        )
    }

    private fun updateLogsDiagnostic() {
        val logs = state.logs
        val severity = when (logs.connection) {
            LogsConnectionState.Connected -> DiagnosticSeverity.Ok
            LogsConnectionState.Connecting,
            LogsConnectionState.Reconnecting,
            LogsConnectionState.AuthRequired,
            -> DiagnosticSeverity.Warning

            LogsConnectionState.Disconnected -> DiagnosticSeverity.Warning
        }
        state = state.copy(
            diagnostics = state.diagnostics.replaceDiagnostic(
                label = "Поток логов",
                status = logs.statusMessage,
                severity = severity,
            ),
        )
    }

    private fun selectedConnection(): Connection? =
        state.connections.firstOrNull { it.id == state.selectedConnectionId }

    private fun sessionErrorMessage(error: Exception): String = when (error) {
        is MobileSessionException -> error.message.orEmpty()
        is IllegalArgumentException -> error.message.orEmpty()
        is CompanionTransportException -> error.failure.userMessage

        else -> error.message?.takeIf(String::isNotBlank)
            ?: "Повторите попытку позже."
    }

    private fun selectedRoutingDocument(): RoutingDocument? =
        state.routing.documents.firstOrNull { it.id == state.routing.selectedDocumentId }

    private fun isCurrentRoutingValidationRequest(request: RoutingValidationRequest): Boolean =
        state.selectedConnectionId == request.connectionId &&
            state.dashboard.endpoint == request.endpoint &&
            state.routing.selectedDocumentId == request.documentId &&
            state.routing.documents.firstOrNull { it.id == request.documentId }?.draftContent == request.draftContent

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

    private fun applyConfirmedServiceSnapshot(snapshot: ConfirmedServiceSnapshot) {
        applyCoreStatus(
            CoreStatus(
                availableCores = snapshot.availableCores,
                currentCore = snapshot.activeCore,
            ),
        )
        state = state.copy(
            dashboard = state.dashboard.copy(serviceState = snapshot.serviceState),
        )
    }

    private fun applyCoreStatusLoadFailure(error: Throwable) {
        val message = error.toCompanionLoadMessage(
            fallback = "Не удалось обновить состояние Xkeen UI.",
        )
        val severity = when ((error as? CompanionTransportException)?.failure?.kind) {
            CompanionTransportFailureKind.KeeneticAuthenticationRequired,
            CompanionTransportFailureKind.AuthenticationRequired,
            CompanionTransportFailureKind.AccessDenied,
            CompanionTransportFailureKind.SetupRequired,
            -> DiagnosticSeverity.Warning

            else -> DiagnosticSeverity.Error
        }
        state = state.copy(
            dashboard = state.dashboard.copy(
                statusSummary = message,
                lastOperation = "Не удалось обновить состояние Xkeen UI",
                lastError = message,
            ),
            diagnostics = state.diagnostics.replaceDiagnostic(
                label = "Сеть и доступ",
                status = message,
                severity = severity,
            ),
            logs = recordLog("transport", LogLevel.Warning, message),
        )
    }
}

private fun InboundsState.fromServer(
    index: InboundsFragmentIndex,
    snapshot: InboundsSnapshot,
    selectedFragment: String,
): InboundsState = copy(
    fragments = index.items,
    selectedFragment = selectedFragment,
    activePath = snapshot.path.ifBlank {
        index.directory.trimEnd('/').takeIf(String::isNotBlank)?.let { "$it/$selectedFragment" }
            ?: selectedFragment
    },
    appliedMode = snapshot.mode,
    selectedMode = snapshot.mode,
    rawServerMode = snapshot.rawMode,
    isLoading = false,
    hasLoaded = true,
    message = snapshot.inboundsStatusMessage(),
    error = null,
)

private fun InboundsSnapshot.inboundsStatusMessage(): String = when {
    mode != null -> "Активный режим: ${mode.displayName}."
    rawMode == "custom" -> "Обнаружен пользовательский режим. Выберите пресет для применения."
    else -> "Режим не определён. Проверьте выбранный inbound-фрагмент."
}

private fun OutboundsState.fromServer(
    index: OutboundsFragmentIndex,
    snapshot: OutboundsSnapshot,
    selectedFragment: String,
    active: ActiveOutboundSnapshot?,
): OutboundsState = copy(
    fragments = index.items,
    selectedFragment = selectedFragment,
    activePath = snapshot.path.ifBlank {
        index.directory.trimEnd('/').takeIf(String::isNotBlank)?.let { "$it/$selectedFragment" }
            ?: selectedFragment
    },
    nodes = snapshot.nodes.sortWithActiveFirst(active),
    activeNodeKey = active?.key,
    activeNodeTag = active?.tag,
    activeMessage = active?.message,
    isLoading = false,
    isPingingAll = false,
    pingingNodeKeys = emptySet(),
    hasLoaded = true,
    editor = if (this.selectedFragment == selectedFragment) {
        editor
    } else {
        OutboundEditorState(restartAfterSave = editor.restartAfterSave)
    },
    poolEditor = if (this.selectedFragment == selectedFragment) {
        poolEditor
    } else {
        OutboundPoolEditorState(
            restartAfterSave = poolEditor.restartAfterSave,
            replacePool = false,
        )
    },
    message = snapshot.outboundsStatusMessage(),
    error = null,
)

private fun OutboundsSnapshot.outboundsStatusMessage(): String = when (nodes.size) {
    0 -> "Proxy-узлы в выбранном фрагменте не найдены."
    1 -> "Один proxy-узел из текущего outbounds-фрагмента."
    else -> "Пул proxy-узлов: ${nodes.size}."
}

private fun subscriptionListMessage(items: List<XraySubscriptionRecord>): String {
    val nodes = items.sumOf(XraySubscriptionRecord::lastCount)
    return when (items.size) {
        0 -> "Подписки Xray ещё не добавлены."
        1 -> "Одна подписка · $nodes узлов."
        else -> "Подписок: ${items.size} · узлов: $nodes."
    }
}

private fun XraySubscriptionRecord.toSubscriptionDraft(): XraySubscriptionDraft = XraySubscriptionDraft(
    id = id,
    name = name,
    tag = tag,
    url = url,
    nameFilter = nameFilter,
    typeFilter = typeFilter,
    transportFilter = transportFilter,
    excludedNodeKeys = excludedNodeKeys,
    enabled = enabled,
    pingEnabled = pingEnabled,
    routingMode = XraySubscriptionRoutingMode.fromApi(routingMode),
    routingAutoRule = routingAutoRule,
    routingBalancerTags = routingBalancerTags,
    sockoptMark255 = sockoptMark255,
    intervalHours = intervalHours.toString(),
)

private fun XraySubscriptionRecord.toSubscriptionNodeCatalog(): XraySubscriptionNodeCatalog =
    XraySubscriptionNodeCatalog(
        source = XraySubscriptionNodeCatalogSource.SavedSnapshot,
        nodes = nodes,
        count = lastCount,
        sourceCount = sourceCount,
        filteredOutCount = filteredOutCount,
        warnings = warnings,
        errors = errors,
        sourceFormat = sourceFormat.orEmpty(),
        fetchMode = fetchMode.orEmpty(),
        profileUpdateIntervalHours = profileUpdateIntervalHours,
        updatedAtEpochSeconds = lastUpdateEpochSeconds,
    )

private fun XraySubscriptionPreview.toSubscriptionNodeCatalog(): XraySubscriptionNodeCatalog =
    XraySubscriptionNodeCatalog(
        source = XraySubscriptionNodeCatalogSource.LivePreview,
        nodes = nodes,
        count = count,
        sourceCount = sourceCount,
        filteredOutCount = filteredOutCount,
        warnings = warnings,
        errors = errors,
        sourceFormat = sourceFormat,
        fetchMode = fetchMode,
        profileUpdateIntervalHours = profileUpdateIntervalHours,
    )

private fun XraySubscriptionDraft.toSubscriptionSaveRequest(): XraySubscriptionSaveRequest =
    XraySubscriptionSaveRequest(
        id = id,
        name = name,
        tag = tag,
        url = url,
        nameFilter = nameFilter,
        typeFilter = typeFilter,
        transportFilter = transportFilter,
        excludedNodeKeys = excludedNodeKeys,
        enabled = enabled,
        pingEnabled = pingEnabled,
        routingMode = routingMode.apiValue,
        routingAutoRule = routingAutoRule,
        routingBalancerTags = routingBalancerTags,
        sockoptMark255 = sockoptMark255,
        intervalHours = intervalHours.toIntOrNull()?.coerceIn(1, 168) ?: 24,
    )

private fun List<OutboundNode>.sortWithActiveFirst(active: ActiveOutboundSnapshot?): List<OutboundNode> =
    sortedByDescending { node ->
        node.key.isNotBlank() && node.key == active?.key ||
            node.tag.isNotBlank() && node.tag == active?.tag
    }

private fun List<OutboundNode>.withLatency(latency: Map<String, OutboundLatency>): List<OutboundNode> =
    map { node -> latency[node.key]?.let { node.copy(latency = it) } ?: node }

private fun List<OutboundNode>.withPreservedLatencyFrom(previous: List<OutboundNode>): List<OutboundNode> {
    val latency = previous.mapNotNull { node -> node.latency?.let { node.key to it } }.toMap()
    return withLatency(latency)
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

/**
 * Fast local syntax feedback only.  It is intentionally never used to decide whether a routing
 * document is valid: Xray/preflight diagnostics from [RoutingValidationPort] remain authoritative.
 */
internal fun collectLocalRoutingSyntaxIssues(draft: String): List<RoutingDiagnostic> {
    if (draft.isBlank()) {
        return listOf(
            RoutingDiagnostic(
                source = RoutingDiagnosticSource.LocalSyntax,
                severity = RoutingDiagnosticSeverity.Error,
                code = "empty_document",
                message = "Документ пуст: сервер всё равно выполнит проверку, но Xray-конфиг должен быть JSON-объектом.",
            ),
        )
    }

    val cleaned = stripJsoncCommentsForLocalSyntax(draft)
    return try {
        // JSONObject deliberately enforces an object root, which is the required Xray config
        // shape.  Comments are stripped first because loaded routing fragments may be JSONC.
        JSONObject(cleaned)
        emptyList()
    } catch (error: Exception) {
        val location = error.message?.let { message ->
            localJsonSyntaxLocation(draft, message)
        }
        listOf(
            RoutingDiagnostic(
                source = RoutingDiagnosticSource.LocalSyntax,
                severity = RoutingDiagnosticSeverity.Error,
                code = "invalid_json_syntax",
                message = "Локально обнаружен некорректный JSON/JSONC: " +
                    (error.message?.substringBefore(" at character")?.trim()
                        ?.takeIf(String::isNotBlank)
                        ?: "проверьте синтаксис."),
                line = location?.first,
                column = location?.second,
            ),
        )
    }
}

private fun stripJsoncCommentsForLocalSyntax(source: String): String = buildString(source.length) {
    var index = 0
    var inString = false
    var escaped = false
    while (index < source.length) {
        val character = source[index]
        if (inString) {
            append(character)
            when {
                escaped -> escaped = false
                character == '\\' -> escaped = true
                character == '"' -> inString = false
            }
            index += 1
            continue
        }

        when {
            character == '"' -> {
                inString = true
                append(character)
                index += 1
            }

            character == '#' -> {
                while (index < source.length && source[index] != '\n') {
                    append(if (source[index] == '\r') '\r' else ' ')
                    index += 1
                }
            }

            character == '/' && source.getOrNull(index + 1) == '/' -> {
                while (index < source.length && source[index] != '\n') {
                    append(if (source[index] == '\r') '\r' else ' ')
                    index += 1
                }
            }

            character == '/' && source.getOrNull(index + 1) == '*' -> {
                while (index < source.length) {
                    val closesComment = source[index] == '*' && source.getOrNull(index + 1) == '/'
                    append(if (source[index] == '\n' || source[index] == '\r') source[index] else ' ')
                    index += 1
                    if (closesComment && index < source.length) {
                        append(' ')
                        index += 1
                        break
                    }
                }
            }

            else -> {
                append(character)
                index += 1
            }
        }
    }
}

private fun localJsonSyntaxLocation(source: String, errorMessage: String): Pair<Int, Int>? {
    val characterIndex = Regex("(?:at character|at)\\s+(\\d+)")
        .find(errorMessage)
        ?.groupValues
        ?.getOrNull(1)
        ?.toIntOrNull()
        ?.coerceIn(0, source.length)
        ?: return null
    val before = source.take(characterIndex)
    return (before.count { it == '\n' } + 1) to
        (characterIndex - (before.lastIndexOf('\n') + 1) + 1)
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

private fun List<PortsEditorDocument>.replacePortsDocument(
    updated: PortsEditorDocument,
): List<PortsEditorDocument> = map { document ->
    if (document.id == updated.id) updated else document
}

private fun List<Connection>.replaceConnection(updated: Connection): List<Connection> =
    map { connection -> if (connection.id == updated.id) updated else connection }

private fun Throwable.toRoutingLoadMessage(): String = toCompanionLoadMessage(
    fallback = "Не удалось загрузить конфигурации с Xkeen UI.",
)

private fun Throwable.toRoutingValidationMessage(): String = toCompanionLoadMessage(
    fallback = "Не удалось получить результат проверки с Xkeen UI. Повторите попытку.",
)

private fun Throwable.toCompanionLoadMessage(fallback: String): String =
    (this as? CompanionTransportException)?.failure?.userMessage
        ?: message?.takeIf { it.isNotBlank() }
        ?: fallback

private fun ServiceState.workspaceStatusSummary(): String =
    when (this) {
        ServiceState.Unknown -> "Состояние сервиса ещё не подтверждено сервером"
        ServiceState.Running -> "Сервис работает; состояние подтверждено сервером"
        ServiceState.Stopped -> "Сервис остановлен; состояние подтверждено сервером"
        ServiceState.Restarting -> "Сервер выполняет перезапуск"
    }

private const val LOGS_POLL_INTERVAL_MILLIS = 2_000L
private const val LOGS_SEARCH_LIMIT = 240
private const val MIN_LOGS_ENTRY_LIMIT = 50
private const val LOGS_ENTRY_LIMIT = 600
private const val LOCAL_LOGS_RESERVE = 20

private fun List<LogEntry>.cappedLogsBuffer(limit: Int): List<LogEntry> {
    val localEntries = filterNot(LogEntry::isXrayLogEntry).take(LOCAL_LOGS_RESERVE)
    val remoteEntries = filter(LogEntry::isXrayLogEntry)
        .sortedXrayLogsChronologically()
        .asReversed()
        .take(limit)
    return (localEntries + remoteEntries).deduplicateLogEntries()
}

internal fun logReconnectDelayMillis(attempt: Int): Long =
    when (attempt.coerceAtLeast(1)) {
        1 -> 1_000L
        2 -> 2_000L
        3 -> 4_000L
        4 -> 8_000L
        else -> 15_000L
    }

private fun Throwable.isAuthenticationRequired(): Boolean =
    (this as? CompanionTransportException)?.failure?.kind in setOf(
        CompanionTransportFailureKind.KeeneticAuthenticationRequired,
        CompanionTransportFailureKind.AuthenticationRequired,
    )

private fun String.normalizedControllerXrayLogLevel(): String =
    trim().lowercase().takeIf { it in setOf("none", "error", "warning", "info", "debug") } ?: "none"

private fun String.normalizedControllerEnabledXrayLogLevel(): String =
    normalizedControllerXrayLogLevel().takeUnless { it == "none" } ?: "info"

private fun List<LogEntry>.deduplicateLogEntries(): List<LogEntry> {
    val seenIds = mutableSetOf<String>()
    return filter { entry ->
        entry.id.isBlank() || seenIds.add(entry.id)
    }
}

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
): List<DiagnosticItem> {
    val replacement = DiagnosticItem(label, status, severity)
    return if (any { it.label == label }) {
        map { item -> if (item.label == label) replacement else item }
    } else {
        this + replacement
    }
}
