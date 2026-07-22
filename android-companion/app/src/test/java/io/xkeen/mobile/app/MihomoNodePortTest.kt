package io.xkeen.mobile.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class MihomoNodePortTest {
    @Test
    fun importDraftUsesSingleBackendPatchContract() = kotlinx.coroutines.test.runTest {
        val transport = RecordingMihomoNodeTransport()
        val result = WebPanelMihomoNodePort(transport).importDraft(
            "https://router.example",
            MihomoNodeImportRequest(
                content = "proxies: []\n",
                source = "vless://node",
                mode = MihomoNodeImportMode.Proxy,
                groups = listOf("Main", "Video"),
                autoUpdateSubscriptions = true,
                intervalHours = 24,
            ),
        )

        val request = transport.posts.single()
        assertEquals("/api/mihomo/node/import-draft", request.endpoint)
        val body = JSONObject(request.body)
        assertEquals("proxy", body.getString("mode"))
        assertEquals("vless://node", body.getString("source"))
        assertEquals(listOf("Main", "Video"), body.getJSONArray("groups").toStrings())
        assertEquals(true, body.getBoolean("auto_update_subscriptions"))
        assertEquals(24, body.getInt("interval_hours"))
        assertEquals(listOf("Mobile"), result.insertedNames)
        assertEquals(12, result.highlightStart)
        assertEquals(42, result.highlightEnd)
        assertEquals(1, result.registeredSubscriptions)
    }

    @Test
    fun proxyGroupsAreReadFromCurrentYamlOnly() {
        val content = """
            proxies:
              - name: Node
                type: direct
            proxy-groups:
              - name: Main
                type: select
                proxies: [DIRECT]
              - name: "Video services"
                type: select
            rules:
              - MATCH,Main
        """.trimIndent()

        assertEquals(listOf("Main", "Video services"), mihomoProxyGroupNames(content))
    }
}

private class RecordingMihomoNodeTransport : CompanionHttpTransport {
    val posts = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse =
        error("GET is not used by Mihomo node import")

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        posts += request
        return CompanionHttpResponse(
            statusCode = 200,
            body = JSONObject()
                .put("ok", true)
                .put("content", "proxies:\n  - name: Mobile\n    type: vless\n")
                .put("inserted_names", JSONArray().put("Mobile"))
                .put("inserted_kind", "proxy")
                .put("skipped_count", 0)
                .put("highlight", JSONObject().put("start", 12).put("end", 44))
                .put("registered_subscriptions", 1)
                .toString(),
            headers = emptyMap(),
            contentType = "application/json",
        )
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
        error("DELETE is not used by Mihomo node import")
}

private fun JSONArray.toStrings(): List<String> = buildList {
    for (index in 0 until length()) add(getString(index))
}
