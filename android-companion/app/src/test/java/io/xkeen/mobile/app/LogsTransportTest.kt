package io.xkeen.mobile.app

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LogsTransportTest {
    @Test
    fun `inactive logs screen does not claim that missing history was preserved`() {
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = defaultCompanionControllerDependencies(),
        )
        val initialMessage = controller.state.logs.statusMessage

        controller.pauseLogsTransport()

        assertEquals(LogsConnectionState.Disconnected, controller.state.logs.connection)
        assertEquals(initialMessage, controller.state.logs.statusMessage)
    }

    @Test
    fun `web logs transport parses history and sends opaque cursors`() = runTest {
        val transport = QueueLogsHttpTransport(listOf(logsResponse()))

        val result = WebPanelLogsTransport(transport).read(
            baseUrl = "https://node.lan",
            cursors = mapOf("error" to "cursor-error", "access" to "cursor-access"),
        )

        assertEquals(
            "/api/mobile/v1/logs?error-cursor=cursor-error&access-cursor=cursor-access",
            transport.requests.single().endpoint,
        )
        assertEquals(2, result.streams.size)
        assertEquals("xray-error", result.streams.first().entries.single().source)
        assertEquals(LogLevel.Error, result.streams.first().entries.single().level)
    }

    @Test
    fun `web logs transport clamps snapshot limit and encodes opaque cursor`() = runTest {
        val transport = QueueLogsHttpTransport(listOf(logsResponse()))

        WebPanelLogsTransport(transport).read(
            baseUrl = "https://node.lan",
            cursors = mapOf("error" to "opaque cursor/+= "),
            limit = 600,
        )

        assertEquals(
            "/api/mobile/v1/logs?limit=500&error-cursor=opaque+cursor%2F%2B%3D+",
            transport.requests.single().endpoint,
        )
    }

    @Test
    fun `web logs transport requests and parses one shot domain seed`() = runTest {
        val seededBody = logsResponse().copy(
            body = logsResponse().body.replace(
                "\"streams\": [",
                """
                "domain_seed": {
                  "entries": [
                    {
                      "id": "domain:1",
                      "time": "18:01:01",
                      "source": "xray-error",
                      "level": "info",
                      "message": "[Info] [312345] sniffed domain: example.com"
                    }
                  ]
                },
                "streams": [
                """.trimIndent(),
            ),
        )
        val transport = QueueLogsHttpTransport(listOf(seededBody))

        val result = WebPanelLogsTransport(transport).read(
            baseUrl = "https://node.lan",
            cursors = emptyMap(),
            limit = 200,
            includeDomainHintsSeed = true,
        )

        assertEquals("/api/mobile/v1/logs?include-domain-seed=1", transport.requests.single().endpoint)
        assertTrue(result.domainHintsSeeded)
        assertEquals("domain:1", result.domainHintEntries.single().id)
    }

    @Test
    fun `controller keeps history while background pause stops polling`() = runTest {
        val http = QueueLogsHttpTransport(listOf(logsResponse()))
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = defaultCompanionControllerDependencies(transport = http),
        )

        val job = launch { controller.runLogsTransport() }
        runCurrent()

        assertEquals(LogsConnectionState.Connected, controller.state.logs.connection)
        assertTrue(controller.state.logs.entries.any { it.source == "xray-error" })
        assertTrue(controller.state.logs.hasLoadedHistory)

        controller.pauseLogsTransport()
        advanceUntilIdle()
        assertEquals(LogsConnectionState.Disconnected, controller.state.logs.connection)
        assertEquals(1, http.requests.size)
        job.join()
    }

    @Test
    fun `controller exposes reconnecting state then resumes without clearing history`() = runTest {
        val offline = CompanionTransportException(
            CompanionTransportFailure(
                kind = CompanionTransportFailureKind.Offline,
                userMessage = "Нет сети",
            ),
        )
        val http = QueueLogsHttpTransport(listOf(offline, logsResponse()))
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = defaultCompanionControllerDependencies(transport = http),
        )

        val job = launch { controller.runLogsTransport() }
        runCurrent()
        assertEquals(LogsConnectionState.Reconnecting, controller.state.logs.connection)
        assertEquals(1, controller.state.logs.reconnectAttempt)
        assertEquals(1_000L, logReconnectDelayMillis(1))

        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(LogsConnectionState.Connected, controller.state.logs.connection)
        assertTrue(controller.state.logs.entries.isNotEmpty())

        controller.pauseLogsTransport()
        advanceUntilIdle()
        job.join()
    }

    @Test
    fun `authentication failure has a distinct logs state`() = runTest {
        val authError = CompanionTransportException(
            CompanionTransportFailure(
                kind = CompanionTransportFailureKind.AuthenticationRequired,
                userMessage = "Требуется вход",
            ),
        )
        val connection = Connection(
            id = "node-1",
            name = "Node",
            baseUrl = "https://node.lan",
            status = ConnectionStatus.Configured,
            lastSeen = "now",
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                phase = AppPhase.Ready,
                connections = listOf(connection),
                selectedConnectionId = connection.id,
            ),
            dependencies = defaultCompanionControllerDependencies(
                transport = QueueLogsHttpTransport(listOf(authError)),
            ),
        )

        controller.runLogsTransport()

        assertEquals(LogsConnectionState.AuthRequired, controller.state.logs.connection)
        assertTrue(controller.state.logs.statusMessage.contains("требуется вход", ignoreCase = true))
        assertEquals(AppPhase.PairLogin, controller.state.phase)
    }

    @Test
    fun `user pause prevents transport reads until explicitly resumed`() = runTest {
        val http = QueueLogsHttpTransport(listOf(logsResponse()))
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = defaultCompanionControllerDependencies(transport = http),
        )

        controller.setXrayLogsPausedByUser(true)
        controller.runLogsTransport()
        assertTrue(http.requests.isEmpty())
        assertTrue(controller.state.logs.isPausedByUser)

        controller.setXrayLogsPausedByUser(false)
        val job = launch { controller.runLogsTransport() }
        runCurrent()
        assertEquals(1, http.requests.size)
        controller.setXrayLogsPausedByUser(true)
        advanceUntilIdle()
        job.join()
    }

    @Test
    fun `combined buffer keeps recent entries from both full streams`() = runTest {
        val errorEntries = (0 until 400).map { index -> remoteEntry("error", index, index * 2) }
        val accessEntries = (0 until 400).map { index -> remoteEntry("access", index, index * 2 + 1) }
        val logsTransport = SequenceLogsTransportPort(
            listOf(
                LogsTransportUpdate(
                    streams = listOf(
                        RemoteLogStream("error", errorEntries, "error-cursor", "snapshot", true),
                        RemoteLogStream("access", accessEntries, "access-cursor", "snapshot", true),
                    ),
                ),
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = defaultCompanionControllerDependencies().copy(logsTransport = logsTransport),
        )

        val job = launch { controller.runLogsTransport() }
        runCurrent()

        val remote = controller.state.logs.entries.filter(LogEntry::isXrayLogEntry)
        assertEquals(600, remote.size)
        assertEquals(300, remote.count { it.source == "xray-error" })
        assertEquals(300, remote.count { it.source == "xray-access" })

        controller.pauseLogsTransport()
        advanceUntilIdle()
        job.join()
    }

    @Test
    fun `temporarily unavailable stream keeps already loaded history`() = runTest {
        val loaded = LogsTransportUpdate(
            streams = listOf(
                RemoteLogStream(
                    source = "error",
                    entries = listOf(remoteEntry("error", 1, 1)),
                    cursor = "error-cursor",
                    mode = "snapshot",
                    available = true,
                ),
                RemoteLogStream("access", emptyList(), "access-cursor", "snapshot", true),
            ),
        )
        val unavailable = LogsTransportUpdate(
            streams = listOf(
                RemoteLogStream("error", emptyList(), "", "snapshot", false),
                RemoteLogStream("access", emptyList(), "", "snapshot", false),
            ),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(phase = AppPhase.Ready),
            dependencies = defaultCompanionControllerDependencies().copy(
                logsTransport = SequenceLogsTransportPort(listOf(loaded, unavailable)),
            ),
        )

        val job = launch { controller.runLogsTransport() }
        runCurrent()
        advanceTimeBy(2_000)
        runCurrent()

        assertTrue(controller.state.logs.entries.any { it.id == "error:1" })
        assertEquals(false, controller.state.logs.streamAvailability["error"])

        controller.pauseLogsTransport()
        advanceUntilIdle()
        job.join()
    }
}

private fun remoteEntry(source: String, index: Int, offsetSeconds: Int): LogEntry {
    val hour = 18 + offsetSeconds / 3_600
    val minute = (offsetSeconds % 3_600) / 60
    val second = offsetSeconds % 60
    val time = "%02d:%02d:%02d".format(hour, minute, second)
    return LogEntry(
        id = "$source:$index",
        time = time,
        source = "xray-$source",
        level = LogLevel.Info,
        message = "2026/07/17 $time $source line $index",
    )
}

private class SequenceLogsTransportPort(
    private val updates: List<LogsTransportUpdate>,
) : LogsTransportPort {
    private var index = 0

    override suspend fun read(
        baseUrl: String,
        cursors: Map<String, String>,
        limit: Int,
    ): LogsTransportUpdate = updates.getOrElse(index++) { updates.last() }
}

private fun logsResponse(): CompanionHttpResponse = CompanionHttpResponse(
    statusCode = 200,
    contentType = "application/json",
    headers = emptyMap(),
    body =
        """
        {
          "ok": true,
          "data": {
            "streams": [
              {
                "source": "error",
                "mode": "snapshot",
                "cursor": "next-error",
                "available": true,
                "entries": [
                  {
                    "id": "error:1",
                    "time": "18:01:03",
                    "source": "xray-error",
                    "level": "error",
                    "message": "failed to resolve upstream"
                  }
                ]
              },
              {
                "source": "access",
                "mode": "snapshot",
                "cursor": "next-access",
                "available": true,
                "entries": []
              }
            ]
          }
        }
        """.trimIndent(),
)

private class QueueLogsHttpTransport(
    private val answers: List<Any>,
) : CompanionHttpTransport {
    val requests = mutableListOf<CompanionHttpRequest>()
    private var index = 0

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse {
        requests += request
        val answer = answers.getOrElse(index++) { error("No further logs response") }
        return when (answer) {
            is CompanionHttpResponse -> answer
            is Exception -> throw answer
            else -> error("Unsupported fake response")
        }
    }

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse =
        error("POST is not expected")

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
        error("DELETE is not expected")
}
