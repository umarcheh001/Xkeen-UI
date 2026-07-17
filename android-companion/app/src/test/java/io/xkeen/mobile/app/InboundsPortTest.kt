package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InboundsPortTest {
    @Test
    fun fragmentAndSnapshotResponsesMapWebPanelContract() {
        val index = parseInboundsFragmentIndex(
            """
                {"ok":true,"dir":"/opt/etc/xray/configs","current":"03_inbounds.json",
                 "items":[{"name":"03_inbounds.json","size":120,"mtime":1000},
                          {"name":"05_routing.json","size":240}]}
            """.trimIndent(),
        )
        val snapshot = parseInboundsSnapshot(
            """{"ok":true,"mode":"mixed","file":"03_inbounds.json","path":"/opt/etc/xray/configs/03_inbounds.json"}""",
        )

        assertEquals(listOf("03_inbounds.json"), index.items.map(InboundsFragment::name))
        assertEquals(InboundsMode.Hybrid, snapshot.mode)
        assertEquals("Hybrid", snapshot.mode?.displayName)
    }

    @Test
    fun applySendsMixedForHybridAndPreservesExtraInbounds() = runTest {
        val transport = RecordingInboundsTransport(
            postResponse = CompanionHttpResponse(
                statusCode = 200,
                body = """{"ok":true,"file":"03_inbounds.json","mode":"mixed","restarted":true}""",
                headers = emptyMap(),
                contentType = "application/json",
            ),
        )
        val port = WebPanelInboundsPort(transport)

        val result = port.apply(
            baseUrl = "https://router.lan",
            filename = "03_inbounds.json",
            mode = InboundsMode.Hybrid,
            restart = true,
        )

        val request = transport.lastPost ?: throw AssertionError("POST was not called")
        val body = JSONObject(request.body.orEmpty())
        assertEquals("/api/inbounds?file=03_inbounds.json", request.endpoint)
        assertEquals("mixed", body.getString("mode"))
        assertTrue(body.getBoolean("restart"))
        assertTrue(body.getBoolean("preserve_extras"))
        assertFalse(body.getBoolean("add_socks"))
        assertEquals(InboundsMode.Hybrid, result.mode)
        assertTrue(result.restarted)
    }
}

private class RecordingInboundsTransport(
    private val postResponse: CompanionHttpResponse,
) : CompanionHttpTransport {
    var lastPost: CompanionHttpRequest? = null

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse =
        throw AssertionError("Unexpected GET ${request.endpoint}")

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        lastPost = request
        return postResponse
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
        throw AssertionError("Unexpected DELETE ${request.endpoint}")
}
