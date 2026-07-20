package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PortsEditorPortTest {
    @Test
    fun loadUsesWebPanelEndpointsForAllManagedFiles() = runTest {
        val transport = RecordingPortsTransport()
        val port = WebPanelPortsEditorPort(transport)

        PortsDocumentId.entries.forEach { document ->
            assertEquals("content:${document.fileName}", port.load("https://router.lan", document))
        }

        assertEquals(PortsDocumentId.entries.map { it.endpoint }, transport.gets.map { it.endpoint })
        assertTrue(transport.gets.all { it.baseUrl == "https://router.lan" })
    }

    @Test
    fun saveSendsContentAndRestartFlag() = runTest {
        val transport = RecordingPortsTransport(restarted = true)
        val result = WebPanelPortsEditorPort(transport).save(
            baseUrl = "https://router.lan",
            document = PortsDocumentId.PortExclude,
            content = "22\n25\n",
            restart = true,
        )

        assertTrue(result.restarted)
        val request = transport.posts.single()
        assertEquals("/api/xkeen/port-exclude", request.endpoint)
        val body = JSONObject(request.body.orEmpty())
        assertEquals("22\n25\n", body.getString("content"))
        assertTrue(body.getBoolean("restart"))
    }

    @Test
    fun saveKeepsUnconfirmedRestartVisibleToCaller() = runTest {
        val result = WebPanelPortsEditorPort(RecordingPortsTransport(restarted = false)).save(
            baseUrl = "https://router.lan",
            document = PortsDocumentId.IpExclude,
            content = "192.168.0.0/16\n",
            restart = true,
        )

        assertFalse(result.restarted)
    }
}

private class RecordingPortsTransport(
    private val restarted: Boolean = true,
) : CompanionHttpTransport {
    val gets = mutableListOf<CompanionHttpRequest>()
    val posts = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse {
        gets += request
        val document = PortsDocumentId.entries.first { it.endpoint == request.endpoint }
        return jsonResponse(JSONObject().put("content", "content:${document.fileName}").toString())
    }

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        posts += request
        return jsonResponse(
            JSONObject()
                .put("ok", true)
                .put("restarted", restarted)
                .toString(),
        )
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
        error("DELETE is not used by ports editor")
}

private fun jsonResponse(body: String): CompanionHttpResponse = CompanionHttpResponse(
    statusCode = 200,
    body = body,
    headers = emptyMap(),
    contentType = "application/json",
)
