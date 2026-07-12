package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
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
}
