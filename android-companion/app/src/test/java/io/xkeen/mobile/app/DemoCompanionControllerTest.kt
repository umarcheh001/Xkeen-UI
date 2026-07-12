package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DemoCompanionControllerTest {
    @Test
    fun selectingBottomTabResetsItsContextSection() {
        val controller = DemoCompanionController(
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
        val controller = DemoCompanionController(CompanionUiState(phase = AppPhase.Ready))
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
    fun currentOrUnavailableCoreDoesNotChangeState() {
        val controller = DemoCompanionController(CompanionUiState(phase = AppPhase.Ready))
        val initialState = controller.state

        controller.switchCore("xray")
        controller.switchCore("sing-box")

        assertEquals(initialState, controller.state)
    }

    @Test
    fun mihomoOnlyStatusMovesWorkspaceAwayFromXrayAndBlocksXrayNavigation() = runTest {
        val controller = DemoCompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                mainTab = MainTab.Routing,
                workspaceSection = WorkspaceSection.XraySubscriptions,
            ),
            coreStatusSource = FakeCoreStatusSource(
                CoreStatus(availableCores = listOf("Mihomo"), currentCore = "Mihomo"),
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
        val controller = DemoCompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                mainTab = MainTab.Generator,
                workspaceSection = WorkspaceSection.GeneratorTemplates,
            ),
            coreStatusSource = FakeCoreStatusSource(
                CoreStatus(availableCores = listOf("Xray"), currentCore = "Xray"),
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
        val controller = DemoCompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            xrayConfigSource = source,
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
        val controller = DemoCompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            xrayConfigSource = source,
        )
        controller.refreshRoutingDocuments()

        controller.selectRoutingDocument("remote:06_bypass.jsonc")
        controller.loadSelectedRoutingDocument()

        val selected = controller.state.routing.documents.first { it.id == "remote:06_bypass.jsonc" }
        assertTrue(selected.isLoaded)
        assertEquals("{\"routing\":{\"rules\":[{\"type\":\"field\"}]}}", selected.draftContent)
        assertEquals(listOf("05_routing.json", "06_bypass.jsonc"), source.loadedFiles)
    }
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
