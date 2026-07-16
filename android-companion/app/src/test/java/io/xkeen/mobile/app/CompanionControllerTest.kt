package io.xkeen.mobile.app

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionControllerTest {
    @Test
    fun finishLaunchWithoutTrustedMaterialOpensPairLoginForLastSelectedConnection() = runTest {
        val selected = Connection(
            id = "saved-node",
            name = "Сохраненный узел",
            baseUrl = "https://saved.lan:8443",
            status = ConnectionStatus.Configured,
            lastSeen = "Готово",
        )
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Launching),
            dependencies = testDependencies(
                connections = InMemoryConnectionsPort(
                    StoredConnections(
                        connections = listOf(selected),
                        selectedConnectionId = selected.id,
                    ),
                ),
            ),
        )

        controller.finishLaunch()

        assertEquals(AppPhase.PairLogin, controller.state.phase)
        assertEquals(ConnectionStatus.NeedsAuth, controller.state.connections.single().status)
        assertEquals(selected.id, controller.state.selectedConnectionId)
        assertEquals(selected.name, controller.state.dashboard.instanceLabel)
        assertEquals(selected.baseUrl, controller.state.dashboard.endpoint)
        assertEquals("Сохраненная мобильная сессия не найдена. Войдите снова.", controller.state.sessionMessage)
    }

    @Test
    fun finishLaunchOpensReadyAfterTrustedServerValidatedRestore() = runTest {
        val selected = Connection(
            id = "trusted-node",
            name = "Доверенный узел",
            baseUrl = "https://trusted.lan:8443",
            status = ConnectionStatus.Configured,
            lastSeen = "Готово",
        )
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Launching),
            dependencies = testDependencies(
                connections = InMemoryConnectionsPort(
                    StoredConnections(
                        connections = listOf(selected),
                        selectedConnectionId = selected.id,
                    ),
                ),
                session = object : SessionPort by DemoSessionPort() {
                    override suspend fun restore(connection: Connection): SessionRestoreResult =
                        SessionRestoreResult.Open(
                            SessionOpenResult(
                                connection = connection.copy(
                                    status = ConnectionStatus.Configured,
                                    lastSeen = "Сессия восстановлена",
                                ),
                                statusSummary = "Готов к безопасному управлению",
                                lastOperation = "Мобильная сессия восстановлена",
                                eventTitle = "Сессия восстановлена",
                                eventSubtitle = "Авторизован: admin",
                                logMessage = "Доверенная мобильная сессия подтверждена сервером",
                            ),
                        )
                },
            ),
        )

        controller.finishLaunch()

        assertEquals(AppPhase.Ready, controller.state.phase)
        assertEquals(selected.id, controller.state.selectedConnectionId)
        assertEquals("Сессия восстановлена", controller.state.connections.single().lastSeen)
        assertTrue(controller.state.sessionMessage == null)
    }

    @Test
    fun restoredSessionClearsPreviousWorkspaceBeforeConfirmedServerSnapshot() = runTest {
        val connection = Connection(
            id = "new-node",
            name = "Новый узел",
            baseUrl = "https://new.lan",
            status = ConnectionStatus.Configured,
            lastSeen = "Готово",
        )
        val restored = SessionOpenResult(
            connection = connection,
            statusSummary = "Готово",
            lastOperation = "Сессия восстановлена",
            eventTitle = "Сессия восстановлена",
            eventSubtitle = "Новый узел",
            logMessage = "Сессия восстановлена",
        )
        val source = FakeXrayConfigSource()
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Launching,
                dashboard = demoDashboardState(),
                routing = demoRoutingState(),
            ),
            dependencies = testDependencies(
                connections = InMemoryConnectionsPort(
                    StoredConnections(listOf(connection), connection.id),
                ),
                xrayConfigSource = source,
                session = object : SessionPort {
                    override suspend fun pair(connection: Connection): SessionPairResult = error("Not used")

                    override suspend fun login(connection: Connection, credentials: LoginForm): SessionOpenResult =
                        error("Not used")

                    override suspend fun restore(connection: Connection): SessionRestoreResult =
                        SessionRestoreResult.Open(restored)

                    override suspend fun disconnect(connection: Connection): SessionCloseResult = error("Not used")

                    override fun expire(connection: Connection): SessionCloseResult = error("Not used")
                },
            ),
        )

        controller.finishLaunch()

        assertEquals(AppPhase.Ready, controller.state.phase)
        assertEquals("https://new.lan", controller.state.dashboard.endpoint)
        assertEquals(ServiceState.Unknown, controller.state.dashboard.serviceState)
        assertTrue(controller.state.dashboard.availableCores.isEmpty())
        assertTrue(controller.state.routing.documents.isEmpty())
        assertEquals("", controller.state.routing.selectedDocumentId)
        assertEquals(listOf("Сессия восстановлена"), controller.state.dashboard.recentEvents.map { it.title })

        controller.refreshWorkspaceSnapshot()

        assertEquals(ServiceState.Running, controller.state.dashboard.serviceState)
        assertEquals("Xray", controller.state.dashboard.activeCore)
        assertTrue(controller.state.dashboard.availableCores.hasCore("xray"))

        controller.refreshRoutingDocuments()

        assertEquals("remote:05_routing.json", controller.state.routing.selectedDocumentId)
        assertEquals(listOf("05_routing.json"), source.loadedFiles)
    }

    @Test
    fun editingConnectionKeepsStableIdAndMetadata() {
        val original = Connection(
            id = "stable-id",
            name = "Старое имя",
            baseUrl = "http://old.lan:8080",
            status = ConnectionStatus.NeedsAuth,
            lastSeen = "Вход устарел",
        )
        val connections = InMemoryConnectionsPort(
            initial = StoredConnections(listOf(original), original.id),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Connections,
                connections = listOf(original),
                selectedConnectionId = original.id,
            ),
            dependencies = testDependencies(connections = connections),
        )

        controller.editConnection(original.id)
        controller.updateConnectionDraftName("Новое имя")
        controller.updateConnectionDraftUrl("https://new.lan:8443")
        controller.saveConnectionDraft()

        val edited = controller.state.connections.single()
        assertEquals(original.id, edited.id)
        assertEquals("Новое имя", edited.name)
        assertEquals("https://new.lan:8443", edited.baseUrl)
        assertEquals(original.status, edited.status)
        assertEquals(original.lastSeen, edited.lastSeen)
        assertEquals(original.id, connections.load().selectedConnectionId)
        assertFalse(controller.state.connectionDraft.isEditing)
    }

    @Test
    fun successfulLoginClearsPasswordFromUiState() = runTest {
        val connection = Connection(
            id = "login-node",
            name = "Узел входа",
            baseUrl = "https://login.lan",
            status = ConnectionStatus.NeedsAuth,
            lastSeen = "Требуется вход",
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.PairLogin,
                connections = listOf(connection),
                selectedConnectionId = connection.id,
                loginForm = LoginForm(username = "admin", password = "erase-after-login"),
            ),
            dependencies = testDependencies(
                connections = InMemoryConnectionsPort(
                    StoredConnections(listOf(connection), connection.id),
                ),
            ),
        )

        controller.login()

        assertEquals(AppPhase.Ready, controller.state.phase)
        assertEquals("", controller.state.loginForm.password)
    }

    @Test
    fun failedLoginShowsServerCredentialMessageAndKeepsPasswordForCorrection() = runTest {
        val connection = Connection(
            id = "failed-login-node",
            name = "Узел входа",
            baseUrl = "https://login.lan",
            status = ConnectionStatus.NeedsAuth,
            lastSeen = "Требуется вход",
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.PairLogin,
                connections = listOf(connection),
                selectedConnectionId = connection.id,
                loginForm = LoginForm(username = "admin", password = "keep-for-fix"),
            ),
            dependencies = testDependencies(
                connections = InMemoryConnectionsPort(
                    StoredConnections(listOf(connection), connection.id),
                ),
                session = object : SessionPort by DemoSessionPort() {
                    override suspend fun login(
                        connection: Connection,
                        credentials: LoginForm,
                    ): SessionOpenResult = throw CompanionTransportException(
                        CompanionTransportFailure(
                            kind = CompanionTransportFailureKind.AuthenticationRequired,
                            userMessage = "Неверный логин или пароль. Осталось попыток: 4.",
                            statusCode = 401,
                            serverCode = "invalid_credentials",
                        ),
                    )
                },
            ),
        )

        controller.login()

        assertEquals(
            "Не удалось выполнить вход: Неверный логин или пароль. Осталось попыток: 4.",
            controller.state.sessionMessage,
        )
        assertEquals("keep-for-fix", controller.state.loginForm.password)
        assertFalse(controller.state.isSessionBusy)
    }

    @Test
    fun selectingBottomTabResetsItsContextSection() {
        val controller = CompanionController(
            CompanionUiState(
                phase = AppPhase.Ready,
                workspaceSection = WorkspaceSection.XraySubscriptions,
            ),
        )

        controller.selectTab(MainTab.Home)

        assertEquals(MainTab.Home, controller.state.mainTab)
        assertEquals(WorkspaceSection.MihomoRouting, controller.state.workspaceSection)

        controller.selectWorkspaceSection(WorkspaceSection.MihomoProviders)

        assertEquals(MainTab.Home, controller.state.mainTab)
        assertEquals(WorkspaceSection.MihomoProviders, controller.state.workspaceSection)
    }

    @Test
    fun switchingCoreUpdatesDashboardAndRestartLog() = runTest {
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(),
        )
        val previousLogCount = controller.state.logs.entries.size

        controller.switchCore("mihomo")

        assertEquals("Mihomo", controller.state.dashboard.activeCore)
        assertEquals(ServiceState.Running, controller.state.dashboard.serviceState)
        assertEquals("Ядро изменено на Mihomo", controller.state.dashboard.lastOperation)
        assertEquals(previousLogCount + 1, controller.state.logs.entries.size)
        assertEquals(
            "Ядро изменено на Mihomo; xkeen перезапущен",
            controller.state.logs.entries.first().message,
        )
    }

    @Test
    fun switchingCoreUsesLogsPortSeam() = runTest {
        val logsPort = FakeLogsPort(
            resultingState = LogsState(
                entries = listOf(
                    LogEntry("22:04:01", "custom", LogLevel.Warning, "Logged by seam"),
                ),
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(logs = logsPort),
        )

        controller.switchCore("mihomo")

        assertEquals(
            LogRecordRequest("service", LogLevel.Info, "Ядро изменено на Mihomo; xkeen перезапущен"),
            logsPort.requests.single(),
        )
        assertEquals("Logged by seam", controller.state.logs.entries.first().message)
    }

    @Test
    fun currentOrUnavailableCoreDoesNotChangeState() = runTest {
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(),
        )
        val initialState = controller.state

        controller.switchCore("xray")
        controller.switchCore("sing-box")

        assertEquals(initialState, controller.state)
    }

    @Test
    fun confirmedServiceActionExposesPendingBlocksRepeatsAndUsesServerSnapshot() = runTest {
        lateinit var controller: CompanionController
        var performCalls = 0
        val serviceActions = object : ServiceActionsPort {
            override suspend fun switchCore(baseUrl: String, core: String): CoreSwitchResult =
                error("Not used")

            override suspend fun perform(baseUrl: String, action: ServiceAction): ServiceActionResult {
                performCalls += 1
                assertEquals(ServiceOperationPhase.Pending, controller.state.serviceOperation.phase)
                assertEquals(ServiceAction.Start, controller.state.serviceOperation.action)
                controller.requestServiceAction(ServiceAction.Stop)
                assertNull(controller.state.pendingAction)
                return ServiceActionResult(
                    snapshot = ConfirmedServiceSnapshot(
                        serviceState = ServiceState.Running,
                        activeCore = "Mihomo",
                        availableCores = listOf("Xray", "Mihomo"),
                    ),
                    statusSummary = "Сервер подтвердил запуск",
                    lastOperation = "Сервис запущен сервером",
                    eventTitle = "Старт",
                    eventSubtitle = "Подтверждено",
                    logMessage = "server-confirmed start",
                )
            }

            override suspend fun load(baseUrl: String): ConfirmedServiceSnapshot = error("Not used")
        }
        controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(serviceActions = serviceActions),
        )

        controller.requestServiceAction(ServiceAction.Start)
        assertEquals(PendingAction.Service(ServiceAction.Start), controller.state.pendingAction)
        controller.confirmPendingAction()

        assertEquals(1, performCalls)
        assertEquals(ServiceOperationPhase.Success, controller.state.serviceOperation.phase)
        assertEquals("Сервер подтвердил запуск", controller.state.serviceOperation.message)
        assertEquals(ServiceState.Running, controller.state.dashboard.serviceState)
        assertEquals("Mihomo", controller.state.dashboard.activeCore)
        assertEquals("Сервис запущен сервером", controller.state.dashboard.lastOperation)
        assertNull(controller.state.dashboard.lastError)
    }

    @Test
    fun failedServiceActionIsExplicitAndStillRefreshesDashboardFromServer() = runTest {
        val serviceActions = object : ServiceActionsPort {
            override suspend fun switchCore(baseUrl: String, core: String): CoreSwitchResult =
                error("Not used")

            override suspend fun perform(baseUrl: String, action: ServiceAction): ServiceActionResult {
                throw ServiceActionException("Команда отклонена сервером.")
            }

            override suspend fun load(baseUrl: String): ConfirmedServiceSnapshot =
                ConfirmedServiceSnapshot(
                    serviceState = ServiceState.Stopped,
                    activeCore = "Mihomo",
                    availableCores = listOf("Xray", "Mihomo"),
                )
        }
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(serviceActions = serviceActions),
        )

        controller.requestServiceAction(ServiceAction.Restart)
        controller.confirmPendingAction()

        assertEquals(ServiceOperationPhase.Failure, controller.state.serviceOperation.phase)
        assertTrue(controller.state.serviceOperation.message.orEmpty().contains("Команда отклонена сервером"))
        assertEquals(ServiceState.Stopped, controller.state.dashboard.serviceState)
        assertEquals("Mihomo", controller.state.dashboard.activeCore)
        assertEquals(controller.state.serviceOperation.message, controller.state.dashboard.lastError)
        assertEquals(LogLevel.Error, controller.state.logs.entries.first().level)
    }

    @Test
    fun mihomoOnlyStatusMovesWorkspaceAwayFromXrayAndBlocksXrayNavigation() = runTest {
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                mainTab = MainTab.Routing,
                workspaceSection = WorkspaceSection.XraySubscriptions,
            ),
            dependencies = testDependencies(
                coreStatusSource = FakeCoreStatusSource(
                    CoreStatus(availableCores = listOf("Mihomo"), currentCore = "Mihomo"),
                ),
            ),
        )

        controller.refreshCoreStatus()

        assertEquals(listOf("Mihomo"), controller.state.dashboard.availableCores)
        assertEquals("Mihomo", controller.state.dashboard.activeCore)
        assertEquals(MainTab.Home, controller.state.mainTab)
        assertEquals(WorkspaceSection.MihomoRouting, controller.state.workspaceSection)

        controller.selectTab(MainTab.Routing)
        controller.selectWorkspaceSection(WorkspaceSection.PortsXray)

        assertEquals(MainTab.Home, controller.state.mainTab)
        assertEquals(WorkspaceSection.MihomoRouting, controller.state.workspaceSection)
    }

    @Test
    fun xrayOnlyStatusHidesAllMihomoBoundTabsAndSections() = runTest {
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                mainTab = MainTab.Generator,
                workspaceSection = WorkspaceSection.GeneratorTemplates,
            ),
            dependencies = testDependencies(
                coreStatusSource = FakeCoreStatusSource(
                    CoreStatus(availableCores = listOf("Xray"), currentCore = "Xray"),
                ),
            ),
        )

        controller.refreshCoreStatus()

        assertEquals(MainTab.Routing, controller.state.mainTab)
        assertEquals(WorkspaceSection.XrayRouting, controller.state.workspaceSection)
        assertFalse(MainTab.Home.isAvailableFor(controller.state.dashboard.availableCores))
        assertFalse(MainTab.Generator.isAvailableFor(controller.state.dashboard.availableCores))
        assertFalse(WorkspaceSection.MihomoRouting.isAvailableFor(controller.state.dashboard.availableCores))
        assertFalse(WorkspaceSection.PortsMihomo.isAvailableFor(controller.state.dashboard.availableCores))
        assertTrue(WorkspaceSection.PortsXray.isAvailableFor(controller.state.dashboard.availableCores))
    }

    @Test
    fun coreTransportFailureIsExposedThroughDashboardDiagnosticsAndLogs() = runTest {
        val failure = CompanionTransportException(
            CompanionTransportFailure(
                kind = CompanionTransportFailureKind.AuthenticationRequired,
                userMessage = "Требуется вход в Xkeen UI.",
                statusCode = 401,
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(
                coreStatusSource = object : CoreStatusSource {
                    override suspend fun load(baseUrl: String): CoreStatus = throw failure
                },
            ),
        )

        controller.refreshCoreStatus()

        assertEquals("Требуется вход в Xkeen UI.", controller.state.dashboard.statusSummary)
        assertEquals("Требуется вход в Xkeen UI.", controller.state.dashboard.lastError)
        assertEquals("Не удалось обновить состояние Xkeen UI", controller.state.dashboard.lastOperation)
        assertEquals(
            DiagnosticSeverity.Warning,
            controller.state.diagnostics.first { it.label == "Сеть и доступ" }.severity,
        )
        assertEquals("transport", controller.state.logs.entries.first().source)
        assertEquals("Требуется вход в Xkeen UI.", controller.state.logs.entries.first().message)
    }

    @Test
    fun initialWorkspaceOfflineFailureKeepsReadyAndIsRetryable() = runTest {
        val offline = CompanionTransportException(
            CompanionTransportFailure(
                kind = CompanionTransportFailureKind.Offline,
                userMessage = "Не удалось подключиться к Xkeen UI. Проверьте адрес, сеть или VPN.",
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                dashboard = unloadedDashboardState().copy(endpoint = "https://offline.lan"),
                routing = unloadedRoutingState(),
            ),
            dependencies = testDependencies(
                serviceActions = object : ServiceActionsPort {
                    override suspend fun switchCore(baseUrl: String, core: String): CoreSwitchResult =
                        error("Not used")

                    override suspend fun perform(baseUrl: String, action: ServiceAction): ServiceActionResult =
                        error("Not used")

                    override suspend fun load(baseUrl: String): ConfirmedServiceSnapshot = throw offline
                },
            ),
        )

        controller.refreshWorkspaceSnapshot()

        assertEquals(AppPhase.Ready, controller.state.phase)
        assertEquals(ServiceState.Unknown, controller.state.dashboard.serviceState)
        assertEquals(offline.failure.userMessage, controller.state.dashboard.lastError)
        assertEquals(
            DiagnosticSeverity.Error,
            controller.state.diagnostics.first { it.label == "Сеть и доступ" }.severity,
        )
        assertEquals("transport", controller.state.logs.entries.first().source)
    }

    @Test
    fun expiredWorkspaceSessionReturnsToLoginAndClearsItsMaterial() = runTest {
        val connection = Connection(
            id = "expired-node",
            name = "Узел с истекшей сессией",
            baseUrl = "https://expired.lan",
            status = ConnectionStatus.Configured,
            lastSeen = "Готово",
        )
        val sessionMaterials = InMemorySessionMaterialStore(
            listOf(
                StoredSessionMaterial(
                    connectionId = connection.id,
                    material = SessionMaterial(cookieHeader = "session=expired", csrfToken = "csrf"),
                    trustedForRestore = true,
                ),
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                connections = listOf(connection),
                selectedConnectionId = connection.id,
            ),
            dependencies = testDependencies(
                connections = InMemoryConnectionsPort(
                    StoredConnections(listOf(connection), connection.id),
                ),
                session = MobileSessionPort(
                    sessionMaterials,
                    object : CompanionHttpTransport {
                        override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse =
                            error("The session adapter is not used while expiring.")

                        override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse =
                            error("The session adapter is not used while expiring.")

                        override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
                            error("The session adapter is not used while expiring.")
                    },
                ),
                serviceActions = object : ServiceActionsPort {
                    override suspend fun switchCore(baseUrl: String, core: String): CoreSwitchResult =
                        error("Not used")

                    override suspend fun perform(baseUrl: String, action: ServiceAction): ServiceActionResult =
                        error("Not used")

                    override suspend fun load(baseUrl: String): ConfirmedServiceSnapshot = throw CompanionTransportException(
                        CompanionTransportFailure(
                            kind = CompanionTransportFailureKind.AuthenticationRequired,
                            userMessage = "Требуется вход в Xkeen UI.",
                            statusCode = 401,
                        ),
                    )
                },
            ),
        )

        controller.refreshWorkspaceSnapshot()

        assertEquals(AppPhase.PairLogin, controller.state.phase)
        assertEquals(ConnectionStatus.NeedsAuth, controller.state.connections.single().status)
        assertEquals("Сессия на Xkeen UI истекла. Войдите снова.", controller.state.sessionMessage)
        assertNull(sessionMaterials.load(connection.id))
    }

    @Test
    fun refreshRoutingUsesWebPanelFragmentContractAndLoadsCurrentFile() = runTest {
        val source = FakeXrayConfigSource()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(xrayConfigSource = source),
        )

        controller.refreshRoutingDocuments()

        assertEquals(
            listOf("03_inbounds.json", "05_routing.json", "06_bypass.jsonc"),
            controller.state.routing.documents.map { it.title },
        )
        assertEquals("remote:05_routing.json", controller.state.routing.selectedDocumentId)
        val selected = controller.state.routing.documents.first { it.id == controller.state.routing.selectedDocumentId }
        assertTrue(selected.isLoaded)
        assertTrue(selected.usesJsonc)
        assertEquals("// from server\n{\"routing\":{\"rules\":[]}}", selected.draftContent)
        assertEquals(listOf("05_routing.json"), source.loadedFiles)
        assertNull(controller.state.routing.loadError)
        assertFalse(controller.state.routing.isRefreshing)
    }

    @Test
    fun selectingRemoteDocumentLoadsItLazily() = runTest {
        val source = FakeXrayConfigSource()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(xrayConfigSource = source),
        )
        controller.refreshRoutingDocuments()

        controller.selectRoutingDocument("remote:06_bypass.jsonc")
        controller.loadSelectedRoutingDocument()

        val selected = controller.state.routing.documents.first { it.id == "remote:06_bypass.jsonc" }
        assertTrue(selected.isLoaded)
        assertEquals("{\"routing\":{\"rules\":[{\"type\":\"field\"}]}}", selected.draftContent)
        assertEquals(listOf("05_routing.json", "06_bypass.jsonc"), source.loadedFiles)
    }

    @Test
    fun validateRoutingUsesServerResultAndKeepsStructuredDiagnostics() = runTest {
        val server = FakeRoutingValidationPort(
            RoutingServerValidation(
                valid = false,
                message = "Xray отклонил outboundTag.",
                diagnostics = listOf(
                    RoutingDiagnostic(
                        source = RoutingDiagnosticSource.Server,
                        severity = RoutingDiagnosticSeverity.Error,
                        code = "routing_semantic_validate",
                        message = "outboundTag не найден",
                        line = 9,
                        column = 17,
                    ),
                ),
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(routingValidation = server),
        )

        controller.validateRouting()

        assertEquals("https://lab.lan:8443", server.requestedBaseUrl)
        assertEquals("05_routing.json", server.requestedDocument?.title)
        assertEquals(RoutingValidationState.Invalid, controller.state.routing.validation.state)
        assertEquals("Xray отклонил outboundTag.", controller.state.routing.validation.message)
        assertEquals(1, controller.state.routing.validation.serverDiagnostics.size)
        assertEquals(
            RoutingDiagnosticSource.Server,
            controller.state.routing.validation.serverDiagnostics.single().source,
        )
        assertEquals(9, controller.state.routing.validation.serverDiagnostics.single().line)
    }

    @Test
    fun validateRoutingKeepsLocalSyntaxIssuesSeparateFromServerDiagnostics() = runTest {
        val server = FakeRoutingValidationPort(
            RoutingServerValidation(
                valid = false,
                message = "Сервер не смог разобрать JSONC.",
                diagnostics = listOf(
                    RoutingDiagnostic(
                        source = RoutingDiagnosticSource.Server,
                        severity = RoutingDiagnosticSeverity.Error,
                        code = "invalid_json",
                        message = "Ожидалась закрывающая скобка.",
                        line = 2,
                        column = 1,
                    ),
                ),
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(routingValidation = server),
        )
        controller.updateRoutingDraft("{\n  \"routing\": {\n")

        controller.validateRouting()

        val validation = controller.state.routing.validation
        assertEquals(RoutingValidationState.Invalid, validation.state)
        assertEquals(1, validation.localSyntaxIssues.size)
        assertEquals(RoutingDiagnosticSource.LocalSyntax, validation.localSyntaxIssues.single().source)
        assertEquals(1, validation.serverDiagnostics.size)
        assertEquals(RoutingDiagnosticSource.Server, validation.serverDiagnostics.single().source)
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun validateRoutingDoesNotPublishAStaleServerResultOrStartASecondRequest() = runTest {
        val deferredResult = CompletableDeferred<RoutingServerValidation>()
        val port = object : RoutingValidationPort {
            var requests = 0

            override suspend fun validate(
                baseUrl: String,
                document: RoutingDocument,
            ): RoutingServerValidation {
                requests += 1
                return deferredResult.await()
            }
        }
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(routingValidation = port),
        )

        val firstRequest = launch { controller.validateRouting() }
        runCurrent()
        assertEquals(RoutingValidationState.Validating, controller.state.routing.validation.state)
        assertTrue(controller.state.routing.isValidationInFlight)
        controller.updateRoutingDraft("{\"routing\":{\"rules\":[ ]}}\n// newer draft")
        controller.validateRouting()
        assertEquals(1, port.requests)

        deferredResult.complete(
            RoutingServerValidation(
                valid = true,
                message = "Старый черновик подтвержден.",
                diagnostics = emptyList(),
            ),
        )
        advanceUntilIdle()
        firstRequest.join()

        assertEquals(RoutingValidationState.Dirty, controller.state.routing.validation.state)
        assertFalse(controller.state.routing.isValidationInFlight)
        assertEquals(
            "{\"routing\":{\"rules\":[ ]}}\n// newer draft",
            controller.state.routing.documents.first().draftContent,
        )
    }

    @Test
    fun validateRoutingKeepsEndpointCompatibilityCodeForTheUi() = runTest {
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(
                routingValidation = object : RoutingValidationPort {
                    override suspend fun validate(
                        baseUrl: String,
                        document: RoutingDocument,
                    ): RoutingServerValidation = throw RoutingValidationException(
                        message = "Обновите Xkeen UI на роутере.",
                        diagnosticCode = "validation_endpoint_unavailable",
                    )
                },
            ),
        )

        controller.validateRouting()

        val diagnostic = controller.state.routing.validation.serverDiagnostics.single()
        assertEquals(RoutingDiagnosticSource.Transport, diagnostic.source)
        assertEquals("validation_endpoint_unavailable", diagnostic.code)
        assertEquals("Обновите Xkeen UI на роутере.", diagnostic.message)
    }

    @Test
    fun validateRoutingExpiresOnlyTheSelectedSessionAfter401() = runTest {
        val connection = Connection(
            id = "validate-expired-node",
            name = "Узел проверки",
            baseUrl = "https://validate.lan",
            status = ConnectionStatus.Configured,
            lastSeen = "Готово",
        )
        val sessionMaterials = InMemorySessionMaterialStore(
            listOf(
                StoredSessionMaterial(
                    connectionId = connection.id,
                    material = SessionMaterial(cookieHeader = "session=expired", csrfToken = "csrf"),
                    trustedForRestore = true,
                ),
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                connections = listOf(connection),
                selectedConnectionId = connection.id,
                dashboard = demoDashboardState().copy(endpoint = connection.baseUrl),
            ),
            dependencies = testDependencies(
                connections = InMemoryConnectionsPort(
                    StoredConnections(listOf(connection), connection.id),
                ),
                session = MobileSessionPort(
                    sessionMaterials,
                    object : CompanionHttpTransport {
                        override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse =
                            error("Not used while expiring a validation session")

                        override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse =
                            error("Not used while expiring a validation session")

                        override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
                            error("Not used while expiring a validation session")
                    },
                ),
                routingValidation = object : RoutingValidationPort {
                    override suspend fun validate(
                        baseUrl: String,
                        document: RoutingDocument,
                    ): RoutingServerValidation = throw CompanionTransportException(
                        CompanionTransportFailure(
                            kind = CompanionTransportFailureKind.AuthenticationRequired,
                            userMessage = "Требуется вход в Xkeen UI.",
                            statusCode = 401,
                        ),
                    )
                },
            ),
        )

        controller.validateRouting()

        assertEquals(AppPhase.PairLogin, controller.state.phase)
        assertEquals(ConnectionStatus.NeedsAuth, controller.state.connections.single().status)
        assertNull(sessionMaterials.load(connection.id))
        assertEquals("Сессия на Xkeen UI истекла. Войдите снова.", controller.state.sessionMessage)
    }

    @Test
    fun saveRoutingUsesRoutingWritePortResult() = runTest {
        val original = demoRoutingState().documents.first()
        val updated = original.copy(
            savedDraftContent = original.draftContent + "\n// saved",
            lastSavedAt = "18:10",
        )
        val routingWrites = FakeRoutingWritePort(
            saveResult = RoutingSaveResult(
                document = updated,
                validation = RoutingValidation(
                    state = RoutingValidationState.Valid,
                    message = "Saved by test port",
                ),
                lastOperation = "Saved remotely",
                logMessage = "Saved ${updated.title}",
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                routing = demoRoutingState().copy(
                    validation = RoutingValidation(
                        state = RoutingValidationState.Valid,
                        message = "Validated",
                    ),
                ),
            ),
            dependencies = testDependencies(routingWrites = routingWrites),
        )

        controller.saveRouting()

        assertEquals(original.id, routingWrites.savedDocument?.id)
        val saved = controller.state.routing.documents.first { it.id == original.id }
        assertEquals("18:10", saved.lastSavedAt)
        assertEquals("Saved by test port", controller.state.routing.validation.message)
        assertEquals("Saved remotely", controller.state.dashboard.lastOperation)
        assertEquals(RoutingWritePhase.Success, controller.state.routing.write.phase)
    }

    @Test
    fun saveRoutingShowsRevisionConflictSeparatelyAndPreservesLocalDraft() = runTest {
        val original = demoRoutingState().documents.first().copy(
            draftContent = "// local\n{}",
            savedDraftContent = "// old saved\n{}",
            publishedRevision = "sha256:old-published",
            savedRevision = "sha256:old-saved",
        )
        val server = RoutingServerDocument(
            name = original.title,
            publishedContent = "// external\n{}",
            publishedRevision = "sha256:new-published",
            publishedAt = "18:20",
            usesJsonc = true,
            savedContent = "// other client\n{}",
            savedRevision = "sha256:new-saved",
            draftBaseRevision = "sha256:new-published",
            savedAt = "18:21",
            hasSavedDraft = true,
        )
        val writes = FakeRoutingWritePort(
            saveError = RoutingWriteConflictException(
                message = "Файл изменён извне.",
                conflictCode = "published_revision_conflict",
                serverDocument = server,
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                routing = demoRoutingState().copy(
                    documents = listOf(original),
                    selectedDocumentId = original.id,
                    validation = RoutingValidation(state = RoutingValidationState.Valid),
                ),
            ),
            dependencies = testDependencies(routingWrites = writes),
        )

        controller.saveRouting()

        val current = controller.state.routing.documents.single()
        assertEquals("// local\n{}", current.draftContent)
        assertEquals("// external\n{}", current.publishedContent)
        assertEquals("sha256:new-saved", current.savedRevision)
        assertEquals(RoutingWritePhase.Conflict, controller.state.routing.write.phase)
        assertEquals("published_revision_conflict", controller.state.routing.write.code)
        assertEquals(RoutingValidationState.Valid, controller.state.routing.validation.state)
    }

    @Test
    fun applyRoutingAdoptsOnlyServerConfirmedPublishedDocument() = runTest {
        val original = demoRoutingState().documents.first().copy(
            publishedContent = "// published\n{}",
            savedDraftContent = "// saved\n{}",
            draftContent = "// saved\n{}",
            publishedRevision = "sha256:published",
            savedRevision = "sha256:saved",
            draftBaseRevision = "sha256:published",
            hasServerSavedDraft = true,
        )
        val applied = original.copy(
            publishedContent = original.savedDraftContent,
            savedDraftContent = original.savedDraftContent,
            draftContent = original.savedDraftContent,
            publishedRevision = "sha256:applied",
            savedRevision = "sha256:applied",
            draftBaseRevision = "sha256:applied",
            hasServerSavedDraft = false,
            lastAppliedAt = "18:30",
        )
        val writes = FakeRoutingWritePort(
            applyResult = RoutingApplyResult(
                document = applied,
                validation = RoutingValidation(
                    state = RoutingValidationState.Valid,
                    message = "Applied by server",
                ),
                preview = RoutingPreview("Applied", emptyList()),
                lastOperation = "Applied remotely",
                eventTitle = "Applied",
                eventSubtitle = original.title,
                logMessage = "Applied ${original.title}",
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                routing = demoRoutingState().copy(
                    documents = listOf(original),
                    selectedDocumentId = original.id,
                    validation = RoutingValidation(state = RoutingValidationState.Valid),
                ),
            ),
            dependencies = testDependencies(routingWrites = writes),
        )

        controller.requestRoutingApply()
        controller.confirmPendingAction()

        val current = controller.state.routing.documents.single()
        assertEquals("sha256:applied", current.publishedRevision)
        assertFalse(current.hasServerSavedDraft)
        assertEquals(RoutingWritePhase.Success, controller.state.routing.write.phase)
        assertEquals("Applied remotely", controller.state.dashboard.lastOperation)
    }

    @Test
    fun dismissRoutingWriteResultClearsOnlySuccessfulConfirmation() {
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                routing = demoRoutingState().copy(
                    write = RoutingWriteState(
                        phase = RoutingWritePhase.Success,
                        message = "Routing применён; restart xkeen подтверждён сервером.",
                    ),
                ),
            ),
            dependencies = testDependencies(),
        )

        controller.dismissRoutingWriteResult()

        assertEquals(RoutingWritePhase.Idle, controller.state.routing.write.phase)
        assertEquals("", controller.state.routing.write.message)
    }

    @Test
    fun dismissRoutingWriteResultKeepsFailureVisible() {
        val failure = RoutingWriteState(
            phase = RoutingWritePhase.Failure,
            message = "Сервер отклонил публикацию.",
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                routing = demoRoutingState().copy(write = failure),
            ),
            dependencies = testDependencies(),
        )

        controller.dismissRoutingWriteResult()

        assertEquals(failure, controller.state.routing.write)
    }
}

private fun testDependencies(
    coreStatusSource: CoreStatusSource = FakeCoreStatusSource(
        CoreStatus(availableCores = listOf("Xray", "Mihomo"), currentCore = "Xray"),
    ),
    xrayConfigSource: XrayConfigSource = FakeXrayConfigSource(),
    connections: ConnectionsPort = InMemoryConnectionsPort(),
    session: SessionPort = DemoSessionPort(),
    serviceActions: ServiceActionsPort = DemoServiceActionsPort(),
    routingValidation: RoutingValidationPort = FakeRoutingValidationPort(),
    routingWrites: RoutingWritePort? = null,
    logs: LogsPort? = null,
    logsTransport: LogsTransportPort = FakeLogsTransportPort(),
    journal: CompanionJournalPort = FakeJournalPort(),
): CompanionControllerDependencies {
    val effectiveJournal = journal
    return CompanionControllerDependencies(
        connections = connections,
        session = session,
        serviceActions = serviceActions,
        routingValidation = routingValidation,
        routingWrites = routingWrites ?: DemoRoutingWritePort(effectiveJournal),
        logs = logs ?: DemoLogsPort(effectiveJournal),
        logsTransport = logsTransport,
        journal = effectiveJournal,
        xrayConfigSource = xrayConfigSource,
        coreStatusSource = coreStatusSource,
    )
}

private class FakeCoreStatusSource(
    private val coreStatus: CoreStatus,
) : CoreStatusSource {
    override suspend fun load(baseUrl: String): CoreStatus = coreStatus
}

private class FakeXrayConfigSource : XrayConfigSource {
    val loadedFiles = mutableListOf<String>()

    override suspend fun listFragments(baseUrl: String): XrayFragmentIndex =
        XrayFragmentIndex(
            directory = "/opt/etc/xray/configs",
            currentName = "05_routing.json",
            items = listOf(
                XrayFragmentInfo("03_inbounds.json", 120, 1000, false),
                XrayFragmentInfo("05_routing.json", 240, 1001, false),
                XrayFragmentInfo("06_bypass.jsonc", 180, 1002, false),
            ),
        )

    override suspend fun loadFragment(baseUrl: String, filename: String): XrayFragmentContent {
        loadedFiles += filename
        return when (filename) {
            "05_routing.json" -> XrayFragmentContent(
                text = "// from server\n{\"routing\":{\"rules\":[]}}",
                hasJsoncSidecar = true,
                usesJsoncSidecar = true,
            )

            else -> XrayFragmentContent(
                text = "{\"routing\":{\"rules\":[{\"type\":\"field\"}]}}",
                hasJsoncSidecar = false,
                usesJsoncSidecar = false,
            )
        }
    }
}

private class FakeLogsTransportPort : LogsTransportPort {
    override suspend fun read(
        baseUrl: String,
        cursors: Map<String, String>,
    ): LogsTransportUpdate = LogsTransportUpdate(emptyList())
}

private class FakeRoutingValidationPort(
    private val result: RoutingServerValidation = RoutingServerValidation(
        valid = true,
        message = "Validated",
        diagnostics = emptyList(),
    ),
) : RoutingValidationPort {
    var requestedBaseUrl: String? = null
    var requestedDocument: RoutingDocument? = null

    override suspend fun validate(
        baseUrl: String,
        document: RoutingDocument,
    ): RoutingServerValidation {
        requestedBaseUrl = baseUrl
        requestedDocument = document
        return result
    }
}

private class FakeRoutingWritePort(
    private val saveResult: RoutingSaveResult? = null,
    private val applyResult: RoutingApplyResult? = null,
    private val saveError: Exception? = null,
    private val applyError: Exception? = null,
) : RoutingWritePort {
    var savedDocument: RoutingDocument? = null
    var appliedDocument: RoutingDocument? = null

    override suspend fun save(baseUrl: String, document: RoutingDocument): RoutingSaveResult {
        savedDocument = document
        saveError?.let { throw it }
        return saveResult ?: RoutingSaveResult(
            document = document,
            validation = RoutingValidation(state = RoutingValidationState.Valid, message = "Saved"),
            lastOperation = "Saved",
            logMessage = "Saved ${document.title}",
        )
    }

    override suspend fun apply(baseUrl: String, document: RoutingDocument): RoutingApplyResult {
        appliedDocument = document
        applyError?.let { throw it }
        return applyResult ?: RoutingApplyResult(
            document = document.copy(lastAppliedAt = "18:10"),
            validation = RoutingValidation(state = RoutingValidationState.Valid, message = "Applied"),
            preview = RoutingPreview(headline = "Applied", details = emptyList()),
            lastOperation = "Applied",
            eventTitle = "Applied",
            eventSubtitle = document.title,
            logMessage = "Applied ${document.title}",
        )
    }
}

private data class LogRecordRequest(
    val source: String,
    val level: LogLevel,
    val message: String,
)

private class FakeLogsPort(
    private val resultingState: LogsState,
) : LogsPort {
    val requests = mutableListOf<LogRecordRequest>()

    override fun record(
        current: LogsState,
        source: String,
        level: LogLevel,
        message: String,
    ): LogsState {
        requests += LogRecordRequest(source, level, message)
        return resultingState
    }
}

private class FakeJournalPort : CompanionJournalPort {
    override fun shortTime(): String = "18:10"

    override fun longTime(): String = "18:10:42"
}
