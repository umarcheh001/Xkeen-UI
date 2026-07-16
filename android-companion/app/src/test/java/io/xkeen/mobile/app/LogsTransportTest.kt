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
