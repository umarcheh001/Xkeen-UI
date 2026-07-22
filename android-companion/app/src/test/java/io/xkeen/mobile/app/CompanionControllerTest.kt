package io.xkeen.mobile.app

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
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
    fun manualWorkspaceRefreshReloadsRuntimeAndVisibleServerContent() = runTest {
        lateinit var controller: CompanionController
        val source = FakeXrayConfigSource()
        var runtimeLoads = 0
        val serviceActions = object : ServiceActionsPort by DemoServiceActionsPort() {
            override suspend fun load(baseUrl: String): ConfirmedServiceSnapshot {
                runtimeLoads += 1
                assertTrue(controller.state.isWorkspaceRefreshing)
                return ConfirmedServiceSnapshot(
                    serviceState = ServiceState.Running,
                    activeCore = "Mihomo",
                    availableCores = listOf("Xray", "Mihomo"),
                )
            }
        }
        controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                workspaceSection = WorkspaceSection.XrayRouting,
                dashboard = demoDashboardState().copy(
                    serviceState = ServiceState.Stopped,
                    activeCore = "Xray",
                ),
                routing = demoRoutingState(),
            ),
            dependencies = testDependencies(
                serviceActions = serviceActions,
                xrayConfigSource = source,
            ),
        )

        controller.refreshWorkspaceFromServer()

        assertEquals(1, runtimeLoads)
        assertEquals(ServiceState.Running, controller.state.dashboard.serviceState)
        assertEquals("Mihomo", controller.state.dashboard.activeCore)
        assertEquals(listOf("05_routing.json"), source.loadedFiles)
        assertEquals("remote:05_routing.json", controller.state.routing.selectedDocumentId)
        assertFalse(controller.state.isWorkspaceRefreshing)
    }

    @Test
    fun manualWorkspaceRefreshPreservesLocalRoutingDraft() = runTest {
        val source = FakeXrayConfigSource()
        val routing = demoRoutingState()
        val selected = routing.documents.first { it.id == routing.selectedDocumentId }
        val localDraft = selected.draftContent + "\n// local mobile edit"
        val dirtyRouting = routing.copy(
            documents = routing.documents.map { document ->
                if (document.id == selected.id) document.copy(draftContent = localDraft) else document
            },
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                workspaceSection = WorkspaceSection.XrayRouting,
                dashboard = demoDashboardState(),
                routing = dirtyRouting,
            ),
            dependencies = testDependencies(xrayConfigSource = source),
        )

        controller.refreshWorkspaceFromServer()

        assertTrue(source.loadedFiles.isEmpty())
        assertEquals(
            localDraft,
            controller.state.routing.documents.first { it.id == selected.id }.draftContent,
        )
        assertFalse(controller.state.isWorkspaceRefreshing)
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
    fun keeneticChallengeSwitchesPairScreenToRouterCredentials() = runTest {
        val connection = Connection(
            id = "remote-node",
            name = "Удалённый узел",
            baseUrl = "https://node.keenetic.pro:8443",
            status = ConnectionStatus.NeedsAuth,
            lastSeen = "Требуется вход",
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.PairLogin,
                connections = listOf(connection),
                selectedConnectionId = connection.id,
            ),
            dependencies = testDependencies(
                connections = InMemoryConnectionsPort(StoredConnections(listOf(connection), connection.id)),
                session = object : SessionPort by DemoSessionPort() {
                    override suspend fun pair(connection: Connection): SessionPairResult =
                        throw CompanionTransportException(
                            CompanionTransportFailure(
                                kind = CompanionTransportFailureKind.KeeneticAuthenticationRequired,
                                userMessage = "Для удалённого доступа сначала войдите в Keenetic.",
                                statusCode = 401,
                                serverCode = "keenetic_auth_required",
                            ),
                        )
                },
            ),
        )

        controller.pair()

        assertEquals(AppPhase.PairLogin, controller.state.phase)
        assertTrue(controller.state.isKeeneticAuthRequired)
        assertEquals("Требуется вход в Keenetic", controller.state.dashboard.statusSummary)
        assertTrue(controller.state.sessionMessage.orEmpty().contains("сначала войдите в Keenetic"))
    }

    @Test
    fun successfulKeeneticLoginContinuesToSeparateXkeenLoginStep() = runTest {
        val connection = Connection(
            id = "remote-node",
            name = "Удалённый узел",
            baseUrl = "https://node.keenetic.pro:8443",
            status = ConnectionStatus.NeedsAuth,
            lastSeen = "Требуется вход",
        )
        var submittedCredentials: LoginForm? = null
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.PairLogin,
                connections = listOf(connection),
                selectedConnectionId = connection.id,
                keeneticLoginForm = LoginForm("router-admin", "router-secret"),
                isKeeneticAuthRequired = true,
            ),
            dependencies = testDependencies(
                connections = InMemoryConnectionsPort(StoredConnections(listOf(connection), connection.id)),
                session = object : SessionPort by DemoSessionPort() {
                    override suspend fun authorizeKeenetic(
                        connection: Connection,
                        credentials: LoginForm,
                    ): SessionPairResult {
                        submittedCredentials = credentials
                        return SessionPairResult.Status(
                            connection = connection,
                            statusSummary = "Требуется вход",
                            message = "Введите учётные данные Xkeen UI.",
                        )
                    }
                },
            ),
        )

        controller.authorizeKeenetic()

        assertEquals(LoginForm("router-admin", "router-secret"), submittedCredentials)
        assertFalse(controller.state.isKeeneticAuthRequired)
        assertEquals("", controller.state.keeneticLoginForm.password)
        assertEquals("Введите учётные данные Xkeen UI.", controller.state.sessionMessage)
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
    fun validateRoutingPublishesOnlyServerDiagnosticsAsCanonicalResult() = runTest {
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
        assertEquals(1, validation.serverDiagnostics.size)
        assertEquals(RoutingDiagnosticSource.Server, validation.serverDiagnostics.single().source)
        assertEquals(validation.serverDiagnostics, validation.diagnostics)
        assertEquals("Ожидалась закрывающая скобка.", validation.displayMessage)
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

    @Test
    fun inboundsLoadsServerModeAndPublishesOnlyConfirmedApplyResult() = runTest {
        val port = FakeInboundsPort()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(inbounds = port),
        )

        controller.refreshInbounds()

        assertEquals("03_inbounds.json", controller.state.inbounds.selectedFragment)
        assertEquals(InboundsMode.Hybrid, controller.state.inbounds.appliedMode)
        assertEquals(InboundsMode.Hybrid, controller.state.inbounds.selectedMode)
        assertEquals("/opt/etc/xray/configs/03_inbounds.json", controller.state.inbounds.activePath)

        controller.selectInboundsMode(InboundsMode.Redirect)
        controller.updateInboundsRestartAfterApply(false)
        controller.applyInboundsMode()

        assertEquals(InboundsMode.Redirect, port.appliedMode)
        assertEquals(false, port.restartRequested)
        assertEquals(InboundsMode.Redirect, controller.state.inbounds.appliedMode)
        assertFalse(controller.state.inbounds.hasChanges)
        assertTrue(controller.state.inbounds.message.contains("без перезапуска"))
    }

    @Test
    fun outboundsLoadsActiveNodeAndPublishesConfirmedLatency() = runTest {
        val port = FakeOutboundsPort()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(outbounds = port),
        )

        controller.refreshOutbounds()

        val loaded = controller.state.outbounds
        assertEquals("04_outbounds.json", loaded.selectedFragment)
        assertEquals("node-nl", loaded.nodes.first().key)
        assertTrue(loaded.isActive(loaded.nodes.first()))
        assertEquals(47L, loaded.nodes.first().latency?.delayMillis)

        controller.pingOutbound("node-de")

        assertEquals("node-de", port.pingedKey)
        assertEquals(61L, controller.state.outbounds.nodes.first { it.key == "node-de" }.latency?.delayMillis)
        assertTrue(controller.state.outbounds.pingingNodeKeys.isEmpty())
    }

    @Test
    fun outboundsEditorPreviewsNormalizesAndSafelySavesSingleLink() = runTest {
        val port = FakeOutboundsPort(includeSecondNode = false)
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(outbounds = port),
        )
        controller.refreshOutbounds()
        controller.openOutboundsEditor()

        controller.updateOutboundDraftUrl(
            "trojan://secret@de.example.net:443?security=tls&type=ws&path=socket#Germany",
        )
        controller.updateOutboundDraftTag("my proxy/de")
        controller.normalizeOutboundDraft()
        controller.updateOutboundsRestartAfterSave(false)

        assertTrue(controller.state.outbounds.editor.preview.isValid)
        assertTrue(controller.state.outbounds.editor.draftUrl.contains("path=%2Fsocket"))
        controller.saveOutboundLink()

        assertEquals("my_proxy_de", port.savedLink?.outboundTag)
        assertEquals(false, port.savedLink?.restart)
        assertFalse(controller.state.outbounds.editor.isOpen)
        assertTrue(controller.state.outbounds.message.contains("без перезапуска"))
    }

    @Test
    fun outboundsEditorStopsSaveWhenServerFileChanged() = runTest {
        val port = FakeOutboundsPort(includeSecondNode = false)
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(outbounds = port),
        )
        controller.refreshOutbounds()
        controller.openOutboundsEditor()
        controller.updateOutboundDraftUrl(
            "trojan://secret@de.example.net:443?security=tls#Germany",
        )
        port.sourceFingerprint = "external-change"

        controller.saveOutboundLink()

        assertNull(port.savedLink)
        assertTrue(controller.state.outbounds.editor.isOpen)
        assertTrue(controller.state.outbounds.editor.error.orEmpty().contains("изменился на сервере"))
    }

    @Test
    fun outboundsEditorDoesNotOverwriteSingleNodeManagedSubscription() = runTest {
        val port = FakeOutboundsPort(includeSecondNode = false, managedKind = "subscription")
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(outbounds = port),
        )
        controller.refreshOutbounds()

        controller.openOutboundsEditor()

        assertTrue(controller.state.outbounds.editor.isOpen)
        assertFalse(controller.state.outbounds.editor.canEdit)
        assertTrue(controller.state.outbounds.editor.error.orEmpty().contains("generated-фрагмент подписки"))
    }

    @Test
    fun outboundsPoolParsesNormalizesAndSafelySavesReadyLinks() = runTest {
        val port = FakeOutboundsPort()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(outbounds = port),
        )
        controller.refreshOutbounds()
        controller.openOutboundsPoolEditor()
        controller.updateOutboundPoolInput(
            """
                netherlands | vless://123e4567-e89b-12d3-a456-426614174000@nl.example.net:443?security=tls&type=ws&path=socket#NL
                trojan://secret@de.example.net:443?security=tls#Germany
            """.trimIndent(),
        )
        controller.addOutboundPoolInput()
        controller.updateOutboundPoolRestartAfterSave(false)
        controller.updateOutboundPoolReplaceMode(true)

        val draft = controller.state.outbounds.poolEditor
        assertEquals(2, draft.entries.size)
        assertTrue(draft.entries.all(OutboundPoolEntryDraft::isValid))
        assertTrue(draft.entries.first().url.contains("path=%2Fsocket"))
        assertTrue(draft.canSave)

        controller.saveOutboundPool()

        assertEquals(listOf("netherlands", "Germany"), port.savedPool?.entries?.map(OutboundPoolSaveEntry::tag))
        assertEquals(false, port.savedPool?.restart)
        assertEquals(true, port.savedPool?.replacePool)
        assertEquals(false, port.savedPool?.sockoptMark255)
        assertFalse(controller.state.outbounds.poolEditor.isOpen)
        assertTrue(controller.state.outbounds.message.contains("заменён"))
    }

    @Test
    fun outboundsPoolStopsOnSubscriptionAndExternalFileChange() = runTest {
        val subscriptionPort = FakeOutboundsPort(managedKind = "subscription")
        val subscriptionController = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(outbounds = subscriptionPort),
        )
        subscriptionController.refreshOutbounds()
        subscriptionController.openOutboundsPoolEditor()

        assertFalse(subscriptionController.state.outbounds.poolEditor.canEdit)
        assertTrue(subscriptionController.state.outbounds.poolEditor.error.orEmpty().contains("подписки"))

        val changedPort = FakeOutboundsPort()
        val changedController = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(outbounds = changedPort),
        )
        changedController.refreshOutbounds()
        changedController.openOutboundsPoolEditor()
        changedController.updateOutboundPoolInput(
            "vless://123e4567-e89b-12d3-a456-426614174000@nl.example.net:443?security=tls#NL",
        )
        changedController.addOutboundPoolInput()
        changedPort.sourceFingerprint = "external-change"

        changedController.saveOutboundPool()

        assertNull(changedPort.savedPool)
        assertTrue(changedController.state.outbounds.poolEditor.isOpen)
        assertTrue(changedController.state.outbounds.poolEditor.error.orEmpty().contains("изменился на сервере"))
    }

    @Test
    fun xraySubscriptionsRequireCurrentPreviewThenSaveAndRefreshExplicitly() = runTest {
        val port = FakeXraySubscriptionsPort()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(xraySubscriptions = port),
        )

        controller.refreshXraySubscriptions()
        controller.openNewXraySubscription()
        controller.updateXraySubscriptionDraft {
            it.copy(
                name = "Mobile provider",
                tag = "mobile",
                url = "https://provider.example/subscription",
            )
        }

        assertFalse(controller.state.xraySubscriptions.editor.canSave)
        controller.previewXraySubscription()
        assertTrue(controller.state.xraySubscriptions.editor.previewIsCurrent)
        assertTrue(controller.state.xraySubscriptions.editor.canSave)

        controller.saveXraySubscription()

        assertEquals("mobile", port.saved?.tag)
        assertEquals("mobile", port.refreshedId)
        assertFalse(controller.state.xraySubscriptions.editor.isOpen)
        assertTrue(controller.state.xraySubscriptions.message.contains("generated-фрагмент"))
    }

    @Test
    fun xraySubscriptionEditStopsWhenWebPanelChangedSavedRecord() = runTest {
        val port = FakeXraySubscriptionsPort()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(xraySubscriptions = port),
        )
        controller.refreshXraySubscriptions()
        controller.openXraySubscription("provider")
        controller.updateXraySubscriptionDraft { it.copy(name = "Mobile edit") }
        port.record = port.record.copy(intervalHours = 12)

        controller.saveXraySubscription()

        assertNull(port.saved)
        assertTrue(controller.state.xraySubscriptions.editor.isOpen)
        assertTrue(controller.state.xraySubscriptions.editor.error.orEmpty().contains("веб-панели"))
    }

    @Test
    fun xraySubscriptionNodeExclusionInvalidatesPreview() = runTest {
        val port = FakeXraySubscriptionsPort()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(xraySubscriptions = port),
        )
        controller.openNewXraySubscription()
        controller.updateXraySubscriptionDraft { it.copy(url = "https://provider.example/sub") }
        controller.previewXraySubscription()

        controller.toggleXraySubscriptionNode("node-1")

        assertFalse(controller.state.xraySubscriptions.editor.previewIsCurrent)
        assertFalse(controller.state.xraySubscriptions.editor.canSave)
    }

    @Test
    fun existingXraySubscriptionOpensWithFullSavedNodeCatalog() = runTest {
        val port = FakeXraySubscriptionsPort()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(xraySubscriptions = port),
        )

        controller.refreshXraySubscriptions()
        controller.openXraySubscription("provider")

        val editor = controller.state.xraySubscriptions.editor
        assertEquals(XraySubscriptionNodeCatalogSource.SavedSnapshot, editor.nodeCatalog.source)
        assertEquals(listOf("node-1", "node-2"), editor.nodeCatalog.nodes.map(OutboundNode::key))
        assertNull(editor.preview)
        assertFalse(editor.requiresPreview)
    }

    @Test
    fun bulkNodeExclusionRequiresPreviewAndEnablesRefreshAfterSave() = runTest {
        val port = FakeXraySubscriptionsPort()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(xraySubscriptions = port),
        )
        controller.refreshXraySubscriptions()
        controller.openXraySubscription("provider")

        controller.setXraySubscriptionNodesExcluded(setOf("node-1", "node-2"), excluded = true)

        val editor = controller.state.xraySubscriptions.editor
        assertEquals(listOf("node-1", "node-2"), editor.draft.excludedNodeKeys)
        assertTrue(editor.refreshAfterSave)
        assertTrue(editor.requiresPreview)
        assertFalse(editor.canSave)
    }

    @Test
    fun subscriptionBulkPingKeepsPartialResultsAndClearsBusyState() = runTest {
        val port = FakeXraySubscriptionsPort()
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(xraySubscriptions = port),
        )
        controller.refreshXraySubscriptions()
        controller.openXraySubscription("provider")

        controller.pingAllXraySubscriptionNodes()

        val editor = controller.state.xraySubscriptions.editor
        assertEquals(listOf("node-1", "node-2"), port.pingedKeys)
        assertEquals(44L, editor.nodeCatalog.nodes.first { it.key == "node-1" }.latency?.delayMillis)
        assertEquals("error", editor.nodeCatalog.nodes.first { it.key == "node-2" }.latency?.status)
        assertTrue(editor.message.orEmpty().contains("Доступно 1 из 2"))
        assertFalse(editor.isPinging)
    }

    @Test
    fun cancellingSubscriptionBulkPingAlwaysClearsBusyState() = runTest {
        val port = FakeXraySubscriptionsPort().apply {
            pingStarted = CompletableDeferred()
            pingGate = CompletableDeferred()
        }
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(xraySubscriptions = port),
        )
        controller.refreshXraySubscriptions()
        controller.openXraySubscription("provider")

        val job = launch { controller.pingAllXraySubscriptionNodes() }
        port.pingStarted?.await()
        assertTrue(controller.state.xraySubscriptions.editor.isPingingAll)
        job.cancel()
        job.join()

        assertFalse(controller.state.xraySubscriptions.editor.isPinging)
        assertTrue(controller.state.xraySubscriptions.editor.pingingNodeKeys.isEmpty())
    }

    @Test
    fun datViewerLoadsCatalogTagsItemsAndServerSearchReadOnly() = runTest {
        val port = FakeXrayDatPort()
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                dashboard = unloadedDashboardState().copy(
                    endpoint = "https://router.example",
                    availableCores = listOf("Xray"),
                ),
            ),
            dependencies = testDependencies(xrayDat = port),
        )

        controller.refreshXrayDatCatalog()

        assertTrue(controller.state.xrayDat.hasLoadedCatalog)
        assertEquals("geosite.dat", controller.state.xrayDat.selectedFile?.name)
        assertEquals(listOf("DISCORD", "GITHUB"), controller.state.xrayDat.tags.map(XrayDatTag::name))

        controller.selectXrayDatTag("DISCORD")
        assertEquals("DISCORD", controller.state.xrayDat.selectedTag)
        assertEquals("discord.com", controller.state.xrayDat.items.single().value)

        controller.updateXrayDatItemQuery("app")
        controller.searchXrayDatItems()
        assertEquals("discordapp.com", controller.state.xrayDat.items.single().value)
        assertTrue(controller.state.xrayDat.isItemSearch)

        controller.closeXrayDatTag()
        controller.updateXrayDatValueQuery("discord.com")
        controller.lookupXrayDatValue()
        assertEquals("DISCORD", controller.state.xrayDat.lookupMatches?.single()?.name)
        assertEquals(1, port.catalogLoads)
        assertEquals(listOf("DISCORD"), port.loadedTags)
        assertEquals(listOf("app"), port.searchQueries)
        assertEquals(listOf("discord.com"), port.lookupQueries)
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun datViewerStopsSpinnerWhenTagReadTimesOut() = runTest {
        val port = FakeXrayDatPort().apply { suspendTagPage = true }
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                dashboard = unloadedDashboardState().copy(
                    endpoint = "https://router.example",
                    availableCores = listOf("Xray"),
                ),
            ),
            dependencies = testDependencies(xrayDat = port),
        )

        controller.refreshXrayDatCatalog()
        val read = async { controller.selectXrayDatTag("DISCORD") }
        runCurrent()
        assertTrue(controller.state.xrayDat.isLoadingItems)

        advanceTimeBy(35_000)
        read.await()

        assertFalse(controller.state.xrayDat.isLoadingItems)
        assertTrue(controller.state.xrayDat.itemsError.orEmpty().contains("слишком много времени"))
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun datViewerStopsSpinnerWhenTagReadIsCancelled() = runTest {
        val port = FakeXrayDatPort().apply { suspendTagPage = true }
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                dashboard = unloadedDashboardState().copy(
                    endpoint = "https://router.example",
                    availableCores = listOf("Xray"),
                ),
            ),
            dependencies = testDependencies(xrayDat = port),
        )

        controller.refreshXrayDatCatalog()
        val read = launch { controller.selectXrayDatTag("DISCORD") }
        runCurrent()
        assertTrue(controller.state.xrayDat.isLoadingItems)

        read.cancel()
        read.join()

        assertFalse(controller.state.xrayDat.isLoadingItems)
    }

    @Test
    fun mihomoYamlRequiresValidationOfExactDraftBeforeSave() = runTest {
        val port = FakeMihomoConfigPort()
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                dashboard = unloadedDashboardState().copy(
                    endpoint = "https://router.example",
                    availableCores = listOf("Mihomo"),
                ),
            ),
            dependencies = testDependencies(mihomoConfig = port),
        )

        controller.refreshMihomoConfig()
        controller.updateMihomoConfig("port: 7891\n")
        controller.saveMihomoConfig(restart = false)
        assertEquals(0, port.saveCalls)

        controller.validateMihomoConfig()
        assertTrue(controller.state.mihomoConfig.isCurrentContentValid)
        controller.saveMihomoConfig(restart = true)

        assertEquals(1, port.saveCalls)
        assertTrue(port.lastRestart)
        assertFalse(controller.state.mihomoConfig.hasChanges)
    }

    @Test
    fun mihomoYamlRefusesToOverwriteExternalServerChange() = runTest {
        val port = FakeMihomoConfigPort()
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                dashboard = unloadedDashboardState().copy(endpoint = "https://router.example"),
            ),
            dependencies = testDependencies(mihomoConfig = port),
        )

        controller.refreshMihomoConfig()
        controller.updateMihomoConfig("port: 7891\n")
        controller.validateMihomoConfig()
        port.remoteContent = "port: 7892\n"
        controller.saveMihomoConfig(restart = false)

        assertEquals(0, port.saveCalls)
        assertEquals(MihomoConfigOperationPhase.Failure, controller.state.mihomoConfig.operation)
        assertTrue(controller.state.mihomoConfig.message.contains("изменился на сервере"))
        assertEquals("port: 7891\n", controller.state.mihomoConfig.content)
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
    inbounds: InboundsPort = DemoInboundsPort(),
    outbounds: OutboundsPort = DemoOutboundsPort(),
    xraySubscriptions: XraySubscriptionsPort = DemoXraySubscriptionsPort(),
    xrayDat: XrayDatPort = DemoXrayDatPort(),
    mihomoConfig: MihomoConfigPort = FakeMihomoConfigPort(),
    portsEditor: PortsEditorPort = DemoPortsEditorPort(),
    terminal: TerminalPort = FakeTerminalPort(),
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
        inbounds = inbounds,
        outbounds = outbounds,
        xraySubscriptions = xraySubscriptions,
        xrayDat = xrayDat,
        mihomoConfig = mihomoConfig,
        portsEditor = portsEditor,
        terminal = terminal,
        logs = logs ?: DemoLogsPort(effectiveJournal),
        logsTransport = logsTransport,
        journal = effectiveJournal,
        xrayConfigSource = xrayConfigSource,
        coreStatusSource = coreStatusSource,
    )
}

private class FakeMihomoConfigPort : MihomoConfigPort {
    var saveCalls = 0
    var lastRestart = false
    var remoteContent = "port: 7890\n"

    override suspend fun load(baseUrl: String): MihomoConfigSnapshot = MihomoConfigSnapshot(remoteContent)

    override suspend fun validate(baseUrl: String, content: String): MihomoValidationResult =
        MihomoValidationResult(valid = true, log = "configuration test is successful")

    override suspend fun save(baseUrl: String, content: String, restart: Boolean): MihomoConfigSnapshot {
        saveCalls += 1
        lastRestart = restart
        remoteContent = content.trimEnd()
        return MihomoConfigSnapshot(remoteContent, "default.yaml")
    }
}

private class FakeTerminalPort : TerminalPort {
    override suspend fun issueConnection(
        baseUrl: String,
        sessionId: String?,
        lastSequence: Long,
        columns: Int,
        rows: Int,
    ): PtyConnectionSpec = PtyConnectionSpec("wss://router.example/ws/pty?token=test")
}

private class FakeXrayDatPort : XrayDatPort {
    private val geosite = XrayDatFile(
        XrayDatKind.GeoSite,
        "geosite.dat",
        "/opt/etc/xray/dat/geosite.dat",
    )
    private val geoip = XrayDatFile(
        XrayDatKind.GeoIp,
        "geoip.dat",
        "/opt/etc/xray/dat/geoip.dat",
    )
    var catalogLoads = 0
    var suspendTagPage = false
    val loadedTags = mutableListOf<String>()
    val searchQueries = mutableListOf<String>()
    val lookupQueries = mutableListOf<String>()

    override suspend fun loadCatalog(baseUrl: String): XrayDatCatalog {
        catalogLoads += 1
        return XrayDatCatalog(listOf(geosite, geoip), geodatInstalled = true)
    }

    override suspend fun loadTags(baseUrl: String, file: XrayDatFile): XrayDatTagsSnapshot =
        XrayDatTagsSnapshot(
            file,
            if (file.kind == XrayDatKind.GeoSite) {
                listOf(XrayDatTag("DISCORD", 40), XrayDatTag("GITHUB", 28))
            } else {
                listOf(XrayDatTag("PRIVATE", 12))
            },
        )

    override suspend fun loadTagPage(
        baseUrl: String,
        file: XrayDatFile,
        tag: String,
        offset: Int,
        limit: Int,
    ): XrayDatItemsPage {
        loadedTags += tag
        if (suspendTagPage) awaitCancellation()
        return XrayDatItemsPage(file, tag, listOf(XrayDatItem("domain", "discord.com")), offset, limit, 1)
    }

    override suspend fun searchTag(
        baseUrl: String,
        file: XrayDatFile,
        tag: String,
        query: String,
        cursor: Int,
        limit: Int,
    ): XrayDatSearchPage {
        searchQueries += query
        return XrayDatSearchPage(
            file = file,
            tag = tag,
            query = query,
            items = listOf(XrayDatItem("domain", "discordapp.com")),
            cursor = cursor,
            nextCursor = null,
            viewed = 40,
            total = 40,
            mode = "contains",
        )
    }

    override suspend fun lookupValue(
        baseUrl: String,
        file: XrayDatFile,
        value: String,
    ): XrayDatLookupResult {
        lookupQueries += value
        return XrayDatLookupResult(file, value, listOf(XrayDatTag("DISCORD", 40)))
    }
}

private class FakeXraySubscriptionsPort : XraySubscriptionsPort {
    var record = XraySubscriptionRecord(
        id = "provider",
        name = "Provider",
        tag = "provider",
        url = "https://provider.example/sub",
        enabled = true,
        pingEnabled = true,
        routingMode = "safe-fallback",
        routingAutoRule = true,
        routingBalancerTags = emptyList(),
        sockoptMark255 = false,
        intervalHours = 24,
        outputFile = "04_outbounds.provider.json",
        lastOk = true,
        lastUpdateEpochSeconds = 100,
        lastCount = 2,
        sourceCount = 2,
        nodes = listOf(
            subscriptionTestNode("node-1", "provider--one", "Amsterdam"),
            subscriptionTestNode("node-2", "provider--two", "Frankfurt"),
        ),
    )
    var saved: XraySubscriptionSaveRequest? = null
    var refreshedId: String? = null
    var pingedKeys: List<String> = emptyList()
    var pingStarted: CompletableDeferred<Unit>? = null
    var pingGate: CompletableDeferred<Unit>? = null
    var pingResult = XraySubscriptionNodePingResult(
        requested = 2,
        updated = 2,
        okCount = 1,
        failedCount = 1,
        latencyByNodeKey = mapOf(
            "node-1" to OutboundLatency("ok", 44),
            "node-2" to OutboundLatency("error", message = "timeout"),
        ),
    )

    override suspend fun list(baseUrl: String): XraySubscriptionsSnapshot =
        XraySubscriptionsSnapshot(listOf(record))

    override suspend fun preview(
        baseUrl: String,
        request: XraySubscriptionSaveRequest,
    ): XraySubscriptionPreview = XraySubscriptionPreview(
        nodes = listOf(
            OutboundNode(
                key = "node-1",
                tag = "${request.tag.ifBlank { "sub" }}--node",
                name = "Amsterdam",
                protocol = "vless",
                transport = "xhttp",
                security = "reality",
                host = "nl.example.net",
                port = "443",
                sni = "cdn.example.net",
                detail = "",
            ),
        ),
        count = 1,
        sourceCount = 1,
        filteredOutCount = 0,
        warnings = emptyList(),
        errors = emptyList(),
        sourceFormat = "links",
        fetchMode = "direct",
        profileUpdateIntervalHours = 12,
        tagPrefix = request.tag.ifBlank { "sub" },
    )

    override suspend fun upsert(
        baseUrl: String,
        request: XraySubscriptionSaveRequest,
    ): XraySubscriptionMutationResult {
        saved = request
        val id = request.id.ifBlank { request.tag.ifBlank { "mobile" } }
        record = record.copy(
            id = id,
            name = request.name.ifBlank { id },
            tag = request.tag.ifBlank { id },
            url = request.url,
            enabled = request.enabled,
            pingEnabled = request.pingEnabled,
            routingMode = request.routingMode,
            routingAutoRule = request.routingAutoRule,
            routingBalancerTags = request.routingBalancerTags,
            sockoptMark255 = request.sockoptMark255,
            intervalHours = request.intervalHours,
            nameFilter = request.nameFilter,
            typeFilter = request.typeFilter,
            transportFilter = request.transportFilter,
            excludedNodeKeys = request.excludedNodeKeys,
        )
        return XraySubscriptionMutationResult(ok = true, id = id, subscription = record)
    }

    override suspend fun refresh(
        baseUrl: String,
        id: String,
        restart: Boolean,
    ): XraySubscriptionMutationResult {
        refreshedId = id
        record = record.copy(lastOk = true, lastCount = 1, sourceCount = 1)
        return XraySubscriptionMutationResult(ok = true, id = id, changed = true, count = 1)
    }

    override suspend fun refreshDue(baseUrl: String, restart: Boolean): XraySubscriptionsDueResult =
        XraySubscriptionsDueResult(0, 0, emptyList())

    override suspend fun pingNodes(
        baseUrl: String,
        id: String,
        nodeKeys: List<String>,
    ): XraySubscriptionNodePingResult {
        pingedKeys = nodeKeys
        pingStarted?.complete(Unit)
        pingGate?.await()
        val latency = pingResult.latencyByNodeKey.filterKeys { it in nodeKeys }
        return pingResult.copy(
            requested = nodeKeys.size,
            updated = latency.size,
            okCount = latency.values.count { it.delayMillis != null },
            failedCount = latency.values.count { it.status == "error" },
            latencyByNodeKey = latency,
        )
    }

    override suspend fun delete(
        baseUrl: String,
        id: String,
        restart: Boolean,
        removeFile: Boolean,
    ): XraySubscriptionMutationResult = XraySubscriptionMutationResult(ok = true, id = id, changed = true)
}

private fun subscriptionTestNode(key: String, tag: String, name: String): OutboundNode = OutboundNode(
    key = key,
    tag = tag,
    name = name,
    protocol = "vless",
    transport = "xhttp",
    security = "reality",
    host = "$key.example.net",
    port = "443",
    sni = "",
    detail = "",
)

private class FakeInboundsPort : InboundsPort {
    var appliedMode: InboundsMode? = null
    var restartRequested: Boolean? = null

    override suspend fun listFragments(baseUrl: String): InboundsFragmentIndex =
        InboundsFragmentIndex(
            directory = "/opt/etc/xray/configs",
            currentName = "03_inbounds.json",
            items = listOf(InboundsFragment("03_inbounds.json")),
        )

    override suspend fun load(baseUrl: String, filename: String): InboundsSnapshot =
        InboundsSnapshot(
            file = filename,
            path = "/opt/etc/xray/configs/$filename",
            rawMode = "mixed",
            mode = InboundsMode.Hybrid,
        )

    override suspend fun apply(
        baseUrl: String,
        filename: String,
        mode: InboundsMode,
        restart: Boolean,
    ): InboundsApplyResult {
        appliedMode = mode
        restartRequested = restart
        return InboundsApplyResult(
            file = filename,
            rawMode = mode.apiValue,
            mode = mode,
            restartRequested = restart,
            restarted = restart,
        )
    }
}

private class FakeOutboundsPort(
    private val includeSecondNode: Boolean = true,
    private val managedKind: String? = null,
) : OutboundsPort {
    var pingedKey: String? = null
    var savedLink: OutboundLinkSaveRequest? = null
    var savedPool: OutboundPoolSaveRequest? = null
    var sourceFingerprint = "source-v1"

    private val nodes = listOf(
        OutboundNode(
            key = "node-de",
            tag = "proxy-de",
            name = "Germany",
            protocol = "vless",
            transport = "xhttp",
            security = "reality",
            host = "de.example.net",
            port = "443",
            sni = "",
            detail = "",
        ),
        OutboundNode(
            key = "node-nl",
            tag = "proxy-nl",
            name = "Netherlands",
            protocol = "vless",
            transport = "xhttp",
            security = "reality",
            host = "nl.example.net",
            port = "443",
            sni = "",
            detail = "",
            latency = OutboundLatency("ok", 47),
        ),
    )

    override suspend fun listFragments(baseUrl: String): OutboundsFragmentIndex =
        OutboundsFragmentIndex(
            directory = "/opt/etc/xray/configs",
            currentName = "04_outbounds.json",
            items = listOf(OutboundsFragment("04_outbounds.json")),
        )

    override suspend fun load(baseUrl: String, filename: String): OutboundsSnapshot =
        OutboundsSnapshot(
            filename,
            "/opt/etc/xray/configs/$filename",
            if (includeSecondNode) nodes else listOf(nodes.last()),
        )

    override suspend fun loadActive(baseUrl: String, filename: String): ActiveOutboundSnapshot =
        ActiveOutboundSnapshot(true, "node-nl", "proxy-nl", "confirmed")

    override suspend fun loadLink(baseUrl: String, filename: String): OutboundLinkSnapshot =
        OutboundLinkSnapshot(
            file = filename,
            path = "/opt/etc/xray/configs/$filename",
            url = "vless://00000000-0000-4000-8000-000000000000@nl.example.net:443?security=reality&pbk=public-key#Netherlands",
            outboundTag = "proxy-nl",
            sourceFingerprint = sourceFingerprint,
            managedKind = managedKind,
        )

    override suspend fun saveLink(
        baseUrl: String,
        filename: String,
        request: OutboundLinkSaveRequest,
    ): OutboundLinkSaveResult {
        savedLink = request
        sourceFingerprint = "source-v2"
        return OutboundLinkSaveResult(filename, request.restart, request.restart)
    }

    override suspend fun savePool(
        baseUrl: String,
        filename: String,
        request: OutboundPoolSaveRequest,
    ): OutboundPoolSaveResult {
        savedPool = request
        sourceFingerprint = "source-v2"
        return OutboundPoolSaveResult(
            file = filename,
            updated = request.entries.size,
            replacedPool = request.replacePool,
            tags = request.entries.map(OutboundPoolSaveEntry::tag) + listOf("direct", "block"),
            restartRequested = request.restart,
            restarted = request.restart,
        )
    }

    override suspend fun ping(
        baseUrl: String,
        filename: String,
        nodeKey: String,
    ): OutboundLatency {
        pingedKey = nodeKey
        return OutboundLatency("ok", 61)
    }

    override suspend fun pingAll(
        baseUrl: String,
        filename: String,
        nodeKeys: List<String>,
    ): Map<String, OutboundLatency> = nodeKeys.associateWith { OutboundLatency("ok", 55) }
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
        limit: Int,
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
