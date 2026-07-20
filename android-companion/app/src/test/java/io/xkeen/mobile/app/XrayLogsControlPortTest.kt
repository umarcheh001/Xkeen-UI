package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class XrayLogsControlPortTest {
    @Test
    fun `web control port uses log endpoints and parses restart state`() = runTest {
        val http = RecordingXrayLogsHttpTransport(
            listOf(
                jsonResponse("""{"loglevel":"warning"}"""),
                jsonResponse("""{"ok":true,"loglevel":"info","xray_restarted":true,"detail":"started"}"""),
                jsonResponse("""{"ok":true,"xray_restarted":false,"detail":"xray not running"}"""),
            ),
        )
        val port = WebPanelXrayLogsControlPort(http)

        assertEquals("warning", port.loadStatus("https://node.lan").logLevel)
        assertEquals("info", port.enable("https://node.lan", "info").logLevel)
        val stopped = port.disable("https://node.lan")

        assertEquals("none", stopped.logLevel)
        assertFalse(stopped.xrayRestarted)
        assertEquals(
            listOf("/api/xray-logs/status", "/api/xray-logs/enable", "/api/xray-logs/disable"),
            http.requests.map { it.endpoint },
        )
        assertEquals("info", JSONObject(http.requests[1].body.orEmpty()).getString("loglevel"))
    }

    @Test
    fun `device port parses manual overrides and mutates aliases`() = runTest {
        val devices =
            """
            {
              "ok": true,
              "router_error": "",
              "devices": [
                {"ip":"192.168.1.83","name":"umar-pc","source":"manual","router_name":"Desktop","mac":"00:11:22:33:44:55"},
                {"ip":"192.168.1.35","name":"Телефон","source":"router"}
              ]
            }
            """.trimIndent()
        val http = RecordingXrayLogsHttpTransport(
            listOf(jsonResponse(devices), jsonResponse(devices), jsonResponse(devices)),
        )
        val port = WebPanelXrayLogsControlPort(http)

        val loaded = port.loadDevices("https://node.lan", refreshRouter = true)
        port.saveDevice("https://node.lan", "192.168.1.83", "umar-pc")
        port.deleteDevice("https://node.lan", "192.168.1.83")

        val manual = loaded.devices.single { it.ip == "192.168.1.83" }
        assertTrue(manual.isManual)
        assertEquals("Desktop", manual.routerName)
        assertEquals(
            listOf(
                "/api/xray-logs/devices?refresh=1",
                "/api/xray-logs/devices",
                "/api/xray-logs/devices/192.168.1.83",
            ),
            http.requests.map { it.endpoint },
        )
    }

    @Test
    fun `controller full stop preserves history and start promotes dns level to info`() = runTest {
        val control = RecordingXrayLogsControlPort()
        val existing = LogEntry("18:00:00", "xray-access", LogLevel.Info, "saved line", "access:1")
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                dashboard = demoDashboardState().copy(endpoint = "https://node.lan"),
                logs = LogsState(
                    entries = listOf(existing),
                    xrayLogLevel = "warning",
                    preferredXrayLogLevel = "warning",
                    showDomains = true,
                    connection = LogsConnectionState.Connected,
                    hasLoadedHistory = true,
                ),
            ),
            dependencies = defaultCompanionControllerDependencies().copy(xrayLogsControl = control),
        )

        controller.setXrayLogsCollectionEnabled(false)
        assertEquals("none", controller.state.logs.xrayLogLevel)
        assertEquals(listOf(existing), controller.state.logs.entries)
        assertFalse(controller.state.logs.isXrayLogControlBusy)

        controller.setXrayLogsCollectionEnabled(true)
        assertEquals("info", controller.state.logs.xrayLogLevel)
        assertEquals(listOf(false, true), control.enabledCalls)
        assertEquals(listOf("info"), control.enabledLevels)
        assertTrue(controller.state.logs.xrayLogControlMessage.orEmpty().contains("Логи включены"))
    }

    @Test
    fun `failed full stop restores known level and exposes error`() = runTest {
        val control = RecordingXrayLogsControlPort().apply { failDisable = true }
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                dashboard = demoDashboardState().copy(endpoint = "https://node.lan"),
                logs = LogsState(xrayLogLevel = "info"),
            ),
            dependencies = defaultCompanionControllerDependencies().copy(xrayLogsControl = control),
        )

        controller.setXrayLogsCollectionEnabled(false)

        assertEquals("info", controller.state.logs.xrayLogLevel)
        assertFalse(controller.state.logs.isXrayLogControlBusy)
        assertTrue(controller.state.logs.xrayLogControlError.orEmpty().contains("router write failed"))
    }
}

private class RecordingXrayLogsControlPort : XrayLogsControlPort {
    val enabledCalls = mutableListOf<Boolean>()
    val enabledLevels = mutableListOf<String>()
    var failDisable = false

    override suspend fun loadStatus(baseUrl: String): XrayLogsControlSnapshot = XrayLogsControlSnapshot("info")

    override suspend fun enable(baseUrl: String, logLevel: String): XrayLogsControlResult {
        enabledCalls += true
        enabledLevels += logLevel
        return XrayLogsControlResult(logLevel, xrayRestarted = true, detail = "started")
    }

    override suspend fun disable(baseUrl: String): XrayLogsControlResult {
        enabledCalls += false
        if (failDisable) error("router write failed")
        return XrayLogsControlResult("none", xrayRestarted = true, detail = "restarted")
    }

    override suspend fun loadDevices(baseUrl: String, refreshRouter: Boolean): XrayLogDevicesSnapshot =
        XrayLogDevicesSnapshot(emptyList())

    override suspend fun saveDevice(baseUrl: String, ip: String, name: String): XrayLogDevicesSnapshot =
        XrayLogDevicesSnapshot(listOf(XrayLogDevice(ip, name, "manual")))

    override suspend fun deleteDevice(baseUrl: String, ip: String): XrayLogDevicesSnapshot =
        XrayLogDevicesSnapshot(emptyList())
}

private class RecordingXrayLogsHttpTransport(
    private val responses: List<CompanionHttpResponse>,
) : CompanionHttpTransport {
    val requests = mutableListOf<CompanionHttpRequest>()
    private var index = 0

    private fun next(request: CompanionHttpRequest): CompanionHttpResponse {
        requests += request
        return responses[index++]
    }

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse = next(request)

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse = next(request)

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse = next(request)
}

private fun jsonResponse(body: String): CompanionHttpResponse = CompanionHttpResponse(
    statusCode = 200,
    body = body,
    headers = emptyMap(),
    contentType = "application/json",
)
