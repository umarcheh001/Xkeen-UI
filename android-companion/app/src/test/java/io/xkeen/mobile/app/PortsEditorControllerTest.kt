package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PortsEditorControllerTest {
    @Test
    fun loadsEditsAndSavesSelectedDocumentWithRestart() = runTest {
        val port = FakePortsEditorPort()
        val controller = portsController(port)

        controller.loadSelectedPortsDocument()
        controller.updatePortsDocument("80\n443\n")
        controller.savePortsDocument()

        val document = controller.state.portsEditor.selectedDocument!!
        assertEquals("80\n443\n", document.savedContent)
        assertFalse(document.hasChanges)
        assertEquals(1, port.saveCalls)
        assertTrue(port.lastRestart)
        assertTrue(controller.state.portsEditor.message.contains("перезапущен"))
    }

    @Test
    fun switchingDocumentsPreservesUnsavedDrafts() = runTest {
        val controller = portsController(FakePortsEditorPort())
        controller.loadSelectedPortsDocument()
        controller.updatePortsDocument("8080\n")

        controller.selectPortsDocument(PortsDocumentId.IpExclude)
        controller.loadSelectedPortsDocument()
        controller.selectPortsDocument(PortsDocumentId.PortProxying)

        assertEquals("8080\n", controller.state.portsEditor.selectedDocument?.content)
        assertTrue(controller.state.portsEditor.selectedDocument?.hasChanges == true)
    }

    @Test
    fun refusesToOverwriteFileChangedOnServer() = runTest {
        val port = FakePortsEditorPort()
        val controller = portsController(port)
        controller.loadSelectedPortsDocument()
        controller.updatePortsDocument("443\n")
        port.remote[PortsDocumentId.PortProxying] = "8443\n"

        controller.savePortsDocument()

        assertEquals(0, port.saveCalls)
        assertTrue(controller.state.portsEditor.error.orEmpty().contains("изменился на сервере"))
        assertTrue(controller.state.portsEditor.selectedDocument?.hasChanges == true)
    }

    @Test
    fun rejectsInvalidXkeenJsonBeforeWrite() = runTest {
        val port = FakePortsEditorPort()
        val controller = portsController(port)
        controller.selectPortsDocument(PortsDocumentId.XkeenConfig)
        controller.loadSelectedPortsDocument()
        controller.updatePortsDocument("{ invalid")

        controller.savePortsDocument()

        assertEquals(0, port.saveCalls)
        assertTrue(controller.state.portsEditor.error.orEmpty().contains("некорректный JSON"))
    }
}

private fun portsController(port: PortsEditorPort): CompanionController = CompanionController(
    initialState = CompanionUiState(
        phase = AppPhase.Ready,
        mainTab = MainTab.Logs,
        workspaceSection = WorkspaceSection.PortsOverview,
        dashboard = demoDashboardState().copy(endpoint = "https://router.lan"),
        portsEditor = unloadedPortsEditorState(),
    ),
    dependencies = defaultCompanionControllerDependencies().copy(portsEditor = port),
)

private class FakePortsEditorPort : PortsEditorPort {
    val remote = PortsDocumentId.entries.associateWith { document ->
        if (document.isJson) "{}\n" else "# ${document.fileName}\n"
    }.toMutableMap()
    var saveCalls = 0
    var lastRestart = false

    override suspend fun load(baseUrl: String, document: PortsDocumentId): String =
        remote.getValue(document)

    override suspend fun save(
        baseUrl: String,
        document: PortsDocumentId,
        content: String,
        restart: Boolean,
    ): PortsSaveResult {
        saveCalls += 1
        lastRestart = restart
        remote[document] = content
        return PortsSaveResult(restarted = restart)
    }
}
