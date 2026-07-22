package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class MihomoTemplatesPortTest {
    @Test
    fun listLoadsAndSortsYamlTemplates() = runTest {
        val transport = RecordingMihomoTemplatesTransport()
        val templates = WebPanelMihomoTemplatesPort(transport).list("https://router.example")

        assertEquals(listOf("alpha.yaml", "Router.yml"), templates.map { it.name })
        assertEquals("/api/mihomo-templates", transport.gets.single().endpoint)
    }

    @Test
    fun loadEncodesTemplateName() = runTest {
        val transport = RecordingMihomoTemplatesTransport()
        val content = WebPanelMihomoTemplatesPort(transport).load(
            "https://router.example",
            "home router.yaml",
        )

        assertEquals("mixed-port: 7890\n", content)
        assertEquals("/api/mihomo-template?name=home%20router.yaml", transport.gets.single().endpoint)
    }

    @Test
    fun zashboardUrlUsesCurrentXkeenBasePath() {
        assertEquals(
            "https://router.example/mihomo_panel/ui/",
            mihomoZashboardUrl("https://router.example/xkeen/"),
        )
    }
}

private class RecordingMihomoTemplatesTransport : CompanionHttpTransport {
    val gets = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse {
        gets += request
        return when {
            request.endpoint == "/api/mihomo-templates" -> jsonResponse(
                JSONObject()
                    .put("ok", true)
                    .put(
                        "templates",
                        JSONArray()
                            .put(JSONObject().put("name", "Router.yml"))
                            .put(JSONObject().put("name", "alpha.yaml")),
                    )
                    .toString(),
            )

            request.endpoint.startsWith("/api/mihomo-template?") -> jsonResponse(
                JSONObject()
                    .put("ok", true)
                    .put("name", "home router.yaml")
                    .put("content", "mixed-port: 7890\n")
                    .toString(),
            )

            else -> error("Unexpected GET ${request.endpoint}")
        }
    }

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        error("POST is not used by the mobile Mihomo templates screen")
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
        error("DELETE is not used by Mihomo templates")
}

private fun jsonResponse(body: String): CompanionHttpResponse = CompanionHttpResponse(
    statusCode = 200,
    body = body,
    headers = emptyMap(),
    contentType = "application/json",
)
