package io.xkeen.mobile.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import org.json.JSONObject

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
    private val logCursors = mutableMapOf<String, String>()

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
            state = state.copy(
                phase = AppPhase.PairLogin,
                isSessionBusy = false,
                sessionMessage = "Не удалось подтвердить сохраненную сессию: ${sessionErrorMessage(error)}",
                dashboard = state.dashboard.copy(statusSummary = "Не удалось восстановить сессию"),
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
            sessionFailed(error, "Не удалось проверить узел")
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
            sessionFailed(error, "Не удалось выполнить вход")
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
        if (state.serviceOperation.isPending) return
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

    fun requestServiceAction(action: ServiceAction) {
        if (state.serviceOperation.isPending || state.pendingAction != null) return
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
        val localSyntaxIssues = collectLocalRoutingSyntaxIssues(request.draftContent)
        state = state.copy(
            routing = state.routing.copy(
                isValidationInFlight = true,
                validation = RoutingValidation(
                    state = RoutingValidationState.Validating,
                    message = "Проверяем ${document.title} на сервере Xkeen UI…",
                    localSyntaxIssues = localSyntaxIssues,
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
                        localSyntaxIssues = localSyntaxIssues,
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
                        localSyntaxIssues = localSyntaxIssues,
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

    /**
     * Starts one cursor-polling ownership generation.  Compose cancels this suspend call while
     * the process is backgrounded; the generation also makes a late response from the old
     * foreground harmless when a new lifecycle pass begins.
     */
    suspend fun runLogsTransport() {
        if (state.phase != AppPhase.Ready) return
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
        if (state.phase != AppPhase.Ready || state.logs.connection == LogsConnectionState.AuthRequired) return
        state = state.copy(
            logs = state.logs.copy(
                connection = LogsConnectionState.Disconnected,
                statusMessage = "Поток логов приостановлен, пока приложение в фоне.",
                reconnectAttempt = 0,
            ),
        )
        updateLogsDiagnostic()
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
        logCursors.clear()
        val newLogs = dependencies.logs.record(
            current = LogsState(),
            source = "auth",
            level = LogLevel.Info,
            message = result.logMessage,
        )
        state = state.copy(
            phase = AppPhase.Ready,
            connections = updatedConnections,
            loginForm = state.loginForm.copy(password = ""),
            isSessionBusy = false,
            sessionMessage = null,
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
            isSessionBusy = false,
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
        logCursors.clear()
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
            isSessionBusy = false,
            sessionMessage = message,
            mainTab = MainTab.Routing,
            workspaceSection = WorkspaceSection.XrayRouting,
            dashboard = state.dashboard.copy(statusSummary = result.statusSummary),
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

    /**
     * A 401 from an authenticated workspace endpoint means the stored server session no longer
     * exists.  Clear only this node's material and make the required re-login explicit instead of
     * leaving the user in a superficially ready workspace with failing reads.
     */
    private fun returnToLoginForExpiredSession(error: Throwable): Boolean {
        val failure = (error as? CompanionTransportException)?.failure ?: return false
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
        update.streams.forEach { stream ->
            if (stream.cursor.isNotBlank()) {
                logCursors[stream.source] = stream.cursor
            } else {
                logCursors.remove(stream.source)
            }
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
        val unavailable = update.streams.filterNot(RemoteLogStream::available)
        val message = when {
            unavailable.isEmpty() -> "Поток логов подключён и обновляется автоматически."
            unavailable.size == update.streams.size -> "Подключено, но Xray log-файлы пока недоступны."
            else -> "Поток подключён; часть Xray log-файлов пока недоступна."
        }
        state = state.copy(
            logs = state.logs.copy(
                entries = entries.take(LOGS_ENTRY_LIMIT),
                connection = LogsConnectionState.Connected,
                statusMessage = message,
                reconnectAttempt = 0,
                hasLoadedHistory = true,
            ),
        )
        updateLogsDiagnostic()
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

private const val LOGS_POLL_INTERVAL_MILLIS = 2_000L
private const val LOGS_ENTRY_LIMIT = 600

internal fun logReconnectDelayMillis(attempt: Int): Long =
    when (attempt.coerceAtLeast(1)) {
        1 -> 1_000L
        2 -> 2_000L
        3 -> 4_000L
        4 -> 8_000L
        else -> 15_000L
    }

private fun Throwable.isAuthenticationRequired(): Boolean =
    (this as? CompanionTransportException)?.failure?.kind ==
        CompanionTransportFailureKind.AuthenticationRequired

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
