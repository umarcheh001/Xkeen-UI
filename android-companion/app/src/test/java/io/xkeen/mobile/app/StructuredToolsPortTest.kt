package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StructuredToolsPortTest {
    @Test
    fun mihomoPortLoadsValidatesAndSavesRawYaml() = runTest {
        val transport = RecordingStructuredToolsTransport(
            responses = ArrayDeque(
                listOf(
                    jsonResponse("""{"ok":true,"content":"port: 7890\n"}"""),
                    jsonResponse("""{"ok":true,"log":"configuration test is successful"}"""),
                    jsonResponse("""{"ok":true,"active_profile":"default.yaml"}"""),
                ),
            ),
        )
        val port = WebPanelMihomoConfigPort(transport)

        val loaded = port.load("https://router.example")
        val validation = port.validate("https://router.example", loaded.content)
        val saved = port.save("https://router.example", loaded.content, restart = false)

        assertEquals("port: 7890\n", loaded.content)
        assertTrue(validation.valid)
        assertEquals("default.yaml", saved.activeProfile)
        assertEquals(
            listOf("/api/mihomo-config", "/api/mihomo/validate_raw", "/api/mihomo/save_raw"),
            transport.requests.map { it.endpoint },
        )
        assertEquals("port: 7890\n", JSONObject(transport.requests[1].body.orEmpty()).getString("config"))
    }

    @Test
    fun mihomoValidationKeepsDomainFailureAsResult() = runTest {
        val transport = RecordingStructuredToolsTransport(
            ArrayDeque(listOf(jsonResponse("""{"ok":false,"log":"yaml: line 3"}"""))),
        )

        val result = WebPanelMihomoConfigPort(transport)
            .validate("https://router.example", "broken: [")

        assertFalse(result.valid)
        assertTrue(result.log.contains("line 3"))
    }

    @Test
    fun terminalPortIssuesScopedTokenAndBuildsResumeUrl() = runTest {
        val transport = RecordingStructuredToolsTransport(
            ArrayDeque(listOf(jsonResponse("""{"ok":true,"token":"one-time-token"}"""))),
        )

        val spec = WebPanelTerminalPort(transport).issueConnection(
            baseUrl = "https://router.example/panel",
            sessionId = "session-1",
            lastSequence = 42,
            columns = 120,
            rows = 36,
        )

        assertTrue(spec.webSocketUrl.startsWith("wss://router.example/panel/ws/pty?"))
        assertTrue(spec.webSocketUrl.contains("token=one-time-token"))
        assertTrue(spec.webSocketUrl.contains("session_id=session-1"))
        assertTrue(spec.webSocketUrl.contains("last_seq=42"))
        assertEquals("pty", JSONObject(transport.requests.single().body.orEmpty()).getString("scope"))
    }
}

private class RecordingStructuredToolsTransport(
    private val responses: ArrayDeque<CompanionHttpResponse>,
) : CompanionHttpTransport {
    val requests = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse = respond(request)

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse = respond(request)

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse = respond(request)

    private fun respond(request: CompanionHttpRequest): CompanionHttpResponse {
        requests += request
        return responses.removeFirst()
    }
}

private fun jsonResponse(body: String) = CompanionHttpResponse(
    statusCode = 200,
    body = body,
    headers = emptyMap(),
    contentType = "application/json",
)
