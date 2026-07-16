package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebPanelRoutingWritePortTest {
    @Test
    fun `save posts both revisions and adopts only server document state`() = runTest {
        val transport = RoutingWriteFakeTransport(
            postResponses = mapOf(
                "/api/mobile/v1/xray/routing/save" to response(
                    writeEnvelope(flag = "saved", server = savedServerDocument()),
                ),
            ),
        )
        val source = sourceDocument()

        val result = WebPanelRoutingWritePort(transport).save("https://node.lan", source)

        val request = transport.posts.single()
        val body = JSONObject(request.body.orEmpty())
        assertEquals(source.title, body.getString("document"))
        assertEquals(source.draftContent, body.getString("content"))
        assertEquals("sha256:published-1", body.getString("published_revision"))
        assertEquals("sha256:saved-1", body.getString("saved_revision"))
        assertEquals("sha256:saved-2", result.document.savedRevision)
        assertEquals("// server saved\n{}", result.document.draftContent)
        assertEquals(source.publishedContent, result.document.publishedContent)
        assertTrue(result.document.hasServerSavedDraft)
    }

    @Test
    fun `apply references exact saved revision without resending editor content`() = runTest {
        val applied = savedServerDocument()
            .replace("// server saved\\n{}", "// applied\\n{}")
            .replace("sha256:published-1", "sha256:applied-3")
            .replace("sha256:saved-2", "sha256:applied-3")
            .replace("\"present\":true", "\"present\":false")
        val transport = RoutingWriteFakeTransport(
            postResponses = mapOf(
                "/api/mobile/v1/xray/routing/apply" to response(
                    writeEnvelope(flag = "applied", server = applied),
                ),
            ),
        )

        val result = WebPanelRoutingWritePort(transport).apply("https://node.lan", sourceDocument())

        val body = JSONObject(transport.posts.single().body.orEmpty())
        assertFalse(body.has("content"))
        assertEquals("sha256:saved-1", body.getString("saved_revision"))
        assertEquals("sha256:applied-3", result.document.publishedRevision)
        assertFalse(result.document.hasServerSavedDraft)
    }

    @Test
    fun `409 becomes typed conflict with freshly loaded server revisions`() = runTest {
        val transport = RoutingWriteFakeTransport(
            postResponses = mapOf(
                "/api/mobile/v1/xray/routing/save" to response(
                    """
                        {
                          "ok": false,
                          "error": {
                            "code": "published_revision_conflict",
                            "message": "Файл изменён извне."
                          }
                        }
                    """.trimIndent(),
                    status = 409,
                ),
            ),
            getResponses = mapOf(
                "/api/mobile/v1/xray/routing/document?document=05_routing.json" to response(
                    documentEnvelope(savedServerDocument()),
                ),
            ),
        )

        val error = try {
            WebPanelRoutingWritePort(transport).save("https://node.lan", sourceDocument())
            throw AssertionError("Expected RoutingWriteConflictException")
        } catch (error: RoutingWriteConflictException) {
            error
        }

        assertEquals("published_revision_conflict", error.conflictCode)
        assertEquals("sha256:saved-2", error.serverDocument?.savedRevision)
        assertEquals(1, transport.gets.size)
    }

    @Test
    fun `document parser keeps saved and published states separate`() {
        val parsed = parseRoutingDocumentEnvelope(documentEnvelope(savedServerDocument()))

        assertEquals("// published\n{}", parsed.publishedContent)
        assertEquals("// server saved\n{}", parsed.savedContent)
        assertEquals("sha256:published-1", parsed.draftBaseRevision)
        assertTrue(parsed.hasSavedDraft)
    }
}

private fun sourceDocument(): RoutingDocument = demoRoutingState().documents.first().copy(
    title = "05_routing.json",
    publishedContent = "// published\n{}",
    draftContent = "// local draft\n{}",
    savedDraftContent = "// prior saved\n{}",
    publishedRevision = "sha256:published-1",
    savedRevision = "sha256:saved-1",
    draftBaseRevision = "sha256:published-1",
    hasServerSavedDraft = true,
)

private fun savedServerDocument(): String =
    """
        {
          "document": "05_routing.json",
          "published": {
            "content": "// published\n{}",
            "revision": "sha256:published-1",
            "modified_at": "2026-07-16T18:00:00Z",
            "uses_jsonc": true
          },
          "saved": {
            "content": "// server saved\n{}",
            "revision": "sha256:saved-2",
            "base_revision": "sha256:published-1",
            "saved_at": "2026-07-16T18:01:00Z",
            "present":true
          },
          "conflict": null
        }
    """.trimIndent()

private fun writeEnvelope(flag: String, server: String): String =
    """{"ok":true,"data":{"$flag":true,"document":$server}}"""

private fun documentEnvelope(server: String): String =
    """{"ok":true,"data":{"document":$server}}"""

private fun response(body: String, status: Int = 200): CompanionHttpResponse = CompanionHttpResponse(
    statusCode = status,
    body = body,
    headers = emptyMap(),
    contentType = "application/json",
)

private class RoutingWriteFakeTransport(
    private val postResponses: Map<String, CompanionHttpResponse> = emptyMap(),
    private val getResponses: Map<String, CompanionHttpResponse> = emptyMap(),
) : CompanionHttpTransport {
    val posts = mutableListOf<CompanionHttpRequest>()
    val gets = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse {
        gets += request
        return requireSuccessfulCompanionResponse(
            getResponses[request.endpoint] ?: error("No GET response for ${request.endpoint}"),
        )
    }

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        posts += request
        return requireSuccessfulCompanionResponse(
            postResponses[request.endpoint] ?: error("No POST response for ${request.endpoint}"),
        )
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
        error("DELETE is not expected")
}
