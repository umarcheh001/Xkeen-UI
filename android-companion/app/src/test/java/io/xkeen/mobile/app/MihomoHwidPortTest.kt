package io.xkeen.mobile.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MihomoHwidPortTest {
    @Test
    fun webPortReadsDeviceProbesAndAppliesProvider() = kotlinx.coroutines.test.runTest {
        val transport = RecordingMihomoHwidTransport()
        val port = WebPanelMihomoHwidPort(transport)

        val device = port.loadDevice("https://router.example:8443")
        val probe = port.probe("https://router.example:8443", "https://provider.example/sub", false)
        val applied = port.applyAndRestart(
            "https://router.example:8443",
            "https://provider.example/sub",
            "Mobile Premium",
            false,
        )

        assertEquals("AABBCCDDEEFF", device.hwid)
        assertEquals("MAC роутера", device.source.hwidSourceForTest())
        assertEquals(12, probe.nodeCount)
        assertEquals("1/3", probe.deviceLimitSummary)
        assertEquals(listOf("Привязка подтверждена"), probe.warnings)
        assertEquals("Mobile_Premium", applied.providerName)
        assertTrue(applied.restartQueued)

        assertEquals("/api/mihomo/hwid/probe", transport.posts[0].endpoint)
        val probeBody = JSONObject(transport.posts[0].body)
        assertEquals("https://provider.example/sub", probeBody.getString("url"))
        assertFalse(probeBody.getBoolean("insecure"))
        assertEquals("/api/mihomo/hwid/apply", transport.posts[1].endpoint)
        val applyBody = JSONObject(transport.posts[1].body)
        assertEquals("add", applyBody.getString("mode"))
        assertTrue(applyBody.getBoolean("restart"))
    }

    @Test
    fun previewUsesLoopbackPortAndDraftInsertionPreservesFollowingSections() {
        val snippet = buildMihomoHwidProviderSnippet(
            baseUrl = "https://router.example:8443/xkeen",
            providerName = "My Premium",
            subscriptionUrl = "https://provider.example/sub?a=1&b=два",
            insecure = true,
        )

        assertTrue(snippet.contains("  My_Premium:"))
        assertTrue(snippet.contains("http://127.0.0.1:8443/mihomo/hwid/provider.yaml?"))
        assertTrue(snippet.contains("insecure=1"))

        val patch = insertMihomoHwidProvider(
            content = "proxy-providers: {}\nproxy-groups:\n  - name: Main\n",
            providerName = "My Premium",
            snippet = snippet,
        )
        assertTrue(patch.content.startsWith("proxy-providers:\n  My_Premium:"))
        assertTrue(patch.content.contains("\nproxy-groups:\n"))
        assertEquals("  My_Premium:", patch.content.substring(patch.start).lineSequence().first())
    }

    @Test(expected = MihomoHwidException::class)
    fun duplicateProviderIsRejected() {
        insertMihomoHwidProvider(
            content = "proxy-providers:\n  Premium:\n    type: http\n",
            providerName = "Premium",
            snippet = "  Premium:\n    type: http\n",
        )
    }
}

private class RecordingMihomoHwidTransport : CompanionHttpTransport {
    val posts = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse = response(
        JSONObject()
            .put("ok", true)
            .put("hwid", "AABBCCDDEEFF")
            .put("hwid_source", "mac")
            .put("hwid_format", "mac12")
            .put("mac", "aa:bb:cc:dd:ee:ff")
            .put("mac_hwid", "AABBCCDDEEFF")
            .put("hwid_matches_router_mac", true)
            .put("device_model", "Keenetic")
            .put("os_release", "4.3")
            .put("mihomo_version", "1.19.25")
            .put("headers", JSONObject().put("x-hwid", "AABBCCDDEEFF")),
    )

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        posts += request
        return if (request.endpoint.endsWith("/probe")) {
            response(
                JSONObject()
                    .put("ok", true)
                    .put("profile", JSONObject().put("profile_title", "Mobile Premium").put("suggested_name", "Mobile_Premium"))
                    .put("probe", JSONObject().put("http_status", 200).put("method", "HEAD").put("timing_ms", 47))
                    .put("headers_used", JSONObject().put("x-hwid", "AABBCCDDEEFF"))
                    .put("hwid_response_headers", JSONObject().put("x-hwid-active", "true"))
                    .put("hwid_limit_info", JSONObject().put("summary", "1/3"))
                    .put("provider_payload", JSONObject().put("has_nodes", true).put("node_count", 12))
                    .put("warnings", JSONArray().put(JSONObject().put("hint", "Привязка подтверждена"))),
            )
        } else {
            response(
                JSONObject()
                    .put("ok", true)
                    .put("provider_name", "Mobile_Premium")
                    .put("active_profile", "config.yaml")
                    .put("restart_queued", true)
                    .put("restart_job_id", "job-1"),
            )
        }
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
        error("DELETE is not used by Mihomo HWID")

    private fun response(json: JSONObject) = CompanionHttpResponse(
        statusCode = 200,
        body = json.toString(),
        headers = emptyMap(),
        contentType = "application/json",
    )
}

private fun String.hwidSourceForTest(): String = if (this == "mac") "MAC роутера" else this
