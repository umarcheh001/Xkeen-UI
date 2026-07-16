package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionTransportSeamTest {
    @Test
    fun webPanelSourcesShareTransportSeamAndExpectedEndpoints() = runTest {
        val transport = FakeCompanionHttpTransport(
            responses = mapOf(
                "/api/xkeen/core" to CompanionHttpResponse(
                    statusCode = 200,
                    body = "<html>login</html>",
                    headers = emptyMap(),
                    contentType = "text/html",
                ),
                "/api/routing/fragments" to CompanionHttpResponse(
                    statusCode = 200,
                    body = "<html>login</html>",
                    headers = emptyMap(),
                    contentType = "text/html",
                ),
                "/api/mobile/v1/xray/routing/document?document=05_routing.json" to CompanionHttpResponse(
                    statusCode = 200,
                    body = """
                        {
                          "ok": true,
                          "data": {
                            "document": {
                              "document": "05_routing.json",
                              "published": {
                                "content": "// from server\n{\"routing\":{\"rules\":[]}}",
                                "revision": "sha256:published",
                                "modified_at": "2026-07-16T18:00:00Z",
                                "uses_jsonc": true
                              },
                              "saved": {
                                "content": "// from server\n{\"routing\":{\"rules\":[]}}",
                                "revision": "sha256:published",
                                "base_revision": "sha256:published",
                                "saved_at": "2026-07-16T18:00:00Z",
                                "present": false
                              },
                              "conflict": null
                            }
                          }
                        }
                    """.trimIndent(),
                    headers = emptyMap(),
                    contentType = "application/json",
                ),
            ),
        )
        val coreSource = WebPanelCoreStatusSource(transport)
        val routingSource = WebPanelXrayConfigSource(transport)

        val coreError = assertThrowsSuspend<CompanionTransportException> {
            coreSource.load("https://lab.lan:8443")
        }
        val routingError = assertThrowsSuspend<CompanionTransportException> {
            routingSource.listFragments("https://lab.lan:8443")
        }
        val fragment = routingSource.loadFragment("https://lab.lan:8443", "05_routing.json")

        assertEquals(
            CompanionTransportFailureKind.AuthenticationRequired,
            coreError.failure.kind,
        )
        assertEquals(
            CompanionTransportFailureKind.AuthenticationRequired,
            routingError.failure.kind,
        )
        assertEquals("// from server\n{\"routing\":{\"rules\":[]}}", fragment.text)
        assertTrue(fragment.hasJsoncSidecar)
        assertTrue(fragment.usesJsoncSidecar)

        assertEquals(
            listOf(
                "/api/xkeen/core",
                "/api/routing/fragments",
                "/api/mobile/v1/xray/routing/document?document=05_routing.json",
            ),
            transport.requests.map { it.endpoint },
        )
        assertTrue(transport.requests.all { it.baseUrl == "https://lab.lan:8443" })
        assertTrue(transport.requests.all { it.headers.isEmpty() })
    }
}

private suspend inline fun <reified T : Throwable> assertThrowsSuspend(
    crossinline block: suspend () -> Unit,
): T =
    try {
        block()
        throw AssertionError("Expected ${T::class.java.simpleName} to be thrown.")
    } catch (error: Throwable) {
        if (error is T) {
            error
        } else {
            throw AssertionError(
                "Expected ${T::class.java.simpleName}, but got ${error::class.java.simpleName}.",
                error,
            )
        }
    }

private class FakeCompanionHttpTransport(
    private val responses: Map<String, CompanionHttpResponse>,
) : CompanionHttpTransport {
    val requests = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse {
        requests += request
        return requireSuccessfulCompanionResponse(
            responses[request.endpoint]
                ?: error("No fake transport response configured for ${request.endpoint}"),
        )
    }

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse =
        error("POST is not configured for this read-only seam test")

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
        error("DELETE is not configured for this read-only seam test")
}
