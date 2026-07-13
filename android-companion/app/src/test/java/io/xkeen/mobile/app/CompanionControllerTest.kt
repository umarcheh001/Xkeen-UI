package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionControllerTest {
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
    fun switchingCoreUpdatesDashboardAndRestartLog() {
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
    fun switchingCoreUsesLogsPortSeam() {
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
    fun currentOrUnavailableCoreDoesNotChangeState() {
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
    fun saveRoutingUsesRoutingWritePortResult() {
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
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = testDependencies(routingWrites = routingWrites),
        )

        controller.saveRouting()

        assertEquals(original.id, routingWrites.savedDocument?.id)
        val saved = controller.state.routing.documents.first { it.id == original.id }
        assertEquals("18:10", saved.lastSavedAt)
        assertEquals("Saved by test port", controller.state.routing.validation.message)
        assertEquals("Saved remotely", controller.state.dashboard.lastOperation)
    }
}

private fun testDependencies(
    coreStatusSource: CoreStatusSource = FakeCoreStatusSource(
        CoreStatus(availableCores = listOf("Xray", "Mihomo"), currentCore = "Xray"),
    ),
    xrayConfigSource: XrayConfigSource = FakeXrayConfigSource(),
    connections: ConnectionsPort = DemoConnectionsPort(),
    session: SessionPort = DemoSessionPort(),
    serviceActions: ServiceActionsPort = DemoServiceActionsPort(),
    routingWrites: RoutingWritePort? = null,
    logs: LogsPort? = null,
    journal: CompanionJournalPort = FakeJournalPort(),
): CompanionControllerDependencies {
    val effectiveJournal = journal
    return CompanionControllerDependencies(
        connections = connections,
        session = session,
        serviceActions = serviceActions,
        routingWrites = routingWrites ?: DemoRoutingWritePort(effectiveJournal),
        logs = logs ?: DemoLogsPort(effectiveJournal),
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

private class FakeRoutingWritePort(
    private val saveResult: RoutingSaveResult? = null,
    private val applyResult: RoutingApplyResult? = null,
) : RoutingWritePort {
    var savedDocument: RoutingDocument? = null
    var appliedDocument: RoutingDocument? = null

    override fun save(document: RoutingDocument): RoutingSaveResult {
        savedDocument = document
        return saveResult ?: RoutingSaveResult(
            document = document,
            validation = RoutingValidation(state = RoutingValidationState.Valid, message = "Saved"),
            lastOperation = "Saved",
            logMessage = "Saved ${document.title}",
        )
    }

    override fun apply(document: RoutingDocument): RoutingApplyResult {
        appliedDocument = document
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
