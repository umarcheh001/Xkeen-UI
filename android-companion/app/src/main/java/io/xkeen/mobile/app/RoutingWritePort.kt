package io.xkeen.mobile.app

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import org.json.JSONObject

internal data class RoutingServerDocument(
    val name: String,
    val publishedContent: String,
    val publishedRevision: String,
    val publishedAt: String,
    val usesJsonc: Boolean,
    val savedContent: String,
    val savedRevision: String,
    val draftBaseRevision: String,
    val savedAt: String,
    val hasSavedDraft: Boolean,
    val conflictCode: String? = null,
    val conflictMessage: String? = null,
)

internal class WebPanelRoutingWritePort(
    private val transport: CompanionHttpTransport,
) : RoutingWritePort {
    override suspend fun save(
        baseUrl: String,
        document: RoutingDocument,
    ): RoutingSaveResult {
        val server = postWrite(
            baseUrl = baseUrl,
            endpoint = "/api/mobile/v1/xray/routing/save",
            operation = "сохранение routing-черновика",
            document = document,
            includeContent = true,
            successFlag = "saved",
        )
        val updated = document.fromServer(server)
        return RoutingSaveResult(
            document = updated,
            validation = RoutingValidation(
                state = RoutingValidationState.Valid,
                message = "Сервер сохранил и повторно проверил routing-черновик без применения.",
            ),
            lastOperation = "Routing-черновик сохранён на сервере",
            logMessage = "Сервер сохранил draft ${document.title} revision ${server.savedRevision.shortRevision()}",
        )
    }

    override suspend fun apply(
        baseUrl: String,
        document: RoutingDocument,
    ): RoutingApplyResult {
        val server = postWrite(
            baseUrl = baseUrl,
            endpoint = "/api/mobile/v1/xray/routing/apply",
            operation = "применение routing-конфигурации",
            document = document,
            includeContent = false,
            successFlag = "applied",
        )
        val updated = document.fromServer(server)
        return RoutingApplyResult(
            document = updated,
            validation = RoutingValidation(
                state = RoutingValidationState.Valid,
                message = "Сервер применил routing и подтвердил перезапуск xkeen.",
            ),
            preview = buildRoutingPreview(updated).copy(headline = "Применено к ${updated.title}"),
            lastOperation = "Routing применён сервером",
            eventTitle = "Маршруты применены",
            eventSubtitle = "${updated.title}: ${server.publishedRevision.shortRevision()}",
            logMessage = "Сервер применил ${updated.title} revision ${server.publishedRevision.shortRevision()}",
        )
    }

    suspend fun load(baseUrl: String, document: String): RoutingServerDocument {
        val encoded = URLEncoder.encode(document, StandardCharsets.UTF_8.name())
        val response = transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/mobile/v1/xray/routing/document?document=$encoded",
            ),
        )
        return parseRoutingDocumentEnvelope(response.body)
    }

    private suspend fun postWrite(
        baseUrl: String,
        endpoint: String,
        operation: String,
        document: RoutingDocument,
        includeContent: Boolean,
        successFlag: String,
    ): RoutingServerDocument {
        val payload = JSONObject()
            .put("document", document.title)
            .put("published_revision", document.publishedRevision)
            .put("saved_revision", document.savedRevision)
        if (includeContent) payload.put("content", document.draftContent)

        val response = try {
            transport.post(
                CompanionHttpRequest(
                    baseUrl = baseUrl,
                    endpoint = endpoint,
                    body = payload.toString(),
                ),
            )
        } catch (error: CompanionTransportException) {
            if (error.failure.statusCode == 409) {
                val current = runCatching { load(baseUrl, document.title) }.getOrNull()
                throw RoutingWriteConflictException(
                    message = error.failure.userMessage,
                    conflictCode = error.failure.serverCode ?: "routing_revision_conflict",
                    serverDocument = current,
                    cause = error,
                )
            }
            if (error.failure.statusCode == 404) {
                throw RoutingWriteException(
                    "На роутере установлена версия Xkeen UI без API routing save/apply. " +
                        "Обновите Xkeen UI и повторите операцию.",
                    code = "routing_write_endpoint_unavailable",
                    cause = error,
                )
            }
            throw error
        }
        val root = parseRoutingWriteRoot(response.body, operation)
        if (!root.optBoolean(successFlag, false)) {
            throw RoutingWriteException("Сервер не подтвердил $operation.")
        }
        return parseRoutingServerDocument(
            root.optJSONObject("document") ?: throw RoutingWriteException(
                "В ответе сервера отсутствует routing-документ после операции.",
            ),
        )
    }
}

internal open class RoutingWriteException(
    message: String,
    val code: String = "routing_write_failed",
    cause: Throwable? = null,
) : Exception(message, cause)

internal class RoutingWriteConflictException(
    message: String,
    val conflictCode: String,
    val serverDocument: RoutingServerDocument?,
    cause: Throwable? = null,
) : RoutingWriteException(message, conflictCode, cause)

internal fun parseRoutingDocumentEnvelope(body: String): RoutingServerDocument {
    val root = try {
        JSONObject(body)
    } catch (error: Exception) {
        throw RoutingWriteException("Xkeen UI вернул некорректный routing document response.", cause = error)
    }
    if (!root.optBoolean("ok", false)) {
        throw RoutingWriteException("Xkeen UI не вернул routing-документ.")
    }
    val data = root.optJSONObject("data") ?: throw RoutingWriteException(
        "В ответе Xkeen UI отсутствует data.",
    )
    return parseRoutingServerDocument(
        data.optJSONObject("document") ?: throw RoutingWriteException(
            "В ответе Xkeen UI отсутствует routing-документ.",
        ),
    )
}

private fun parseRoutingWriteRoot(body: String, operation: String): JSONObject {
    val root = try {
        JSONObject(body)
    } catch (error: Exception) {
        throw RoutingWriteException("Xkeen UI вернул некорректный ответ на $operation.", cause = error)
    }
    if (!root.optBoolean("ok", false)) {
        throw RoutingWriteException("Xkeen UI не подтвердил $operation.")
    }
    return root.optJSONObject("data") ?: throw RoutingWriteException(
        "В ответе Xkeen UI отсутствует результат операции.",
    )
}

internal fun parseRoutingServerDocument(value: JSONObject): RoutingServerDocument {
    val published = value.optJSONObject("published") ?: throw RoutingWriteException(
        "В routing-документе отсутствует published state.",
    )
    val saved = value.optJSONObject("saved") ?: throw RoutingWriteException(
        "В routing-документе отсутствует saved state.",
    )
    val name = value.optString("document").trim()
    val publishedRevision = published.optString("revision").trim()
    val savedRevision = saved.optString("revision").trim()
    if (name.isBlank() || publishedRevision.isBlank() || savedRevision.isBlank()) {
        throw RoutingWriteException("Routing-документ не содержит обязательные revision metadata.")
    }
    val conflict = value.optJSONObject("conflict")
    return RoutingServerDocument(
        name = name,
        publishedContent = published.optString("content"),
        publishedRevision = publishedRevision,
        publishedAt = published.optString("modified_at").trim(),
        usesJsonc = published.optBoolean("uses_jsonc", false),
        savedContent = saved.optString("content"),
        savedRevision = savedRevision,
        draftBaseRevision = saved.optString("base_revision").trim(),
        savedAt = saved.optString("saved_at").trim(),
        hasSavedDraft = saved.optBoolean("present", false),
        conflictCode = conflict?.optString("code")?.trim()?.takeIf(String::isNotBlank),
        conflictMessage = conflict?.optString("message")?.trim()?.takeIf(String::isNotBlank),
    )
}

internal fun RoutingDocument.fromServer(server: RoutingServerDocument): RoutingDocument = copy(
    publishedContent = server.publishedContent,
    draftContent = server.savedContent,
    savedDraftContent = server.savedContent,
    lastSavedAt = server.savedAt.ifBlank { lastSavedAt },
    lastAppliedAt = server.publishedAt.ifBlank { lastAppliedAt },
    usesJsonc = server.usesJsonc,
    publishedRevision = server.publishedRevision,
    savedRevision = server.savedRevision,
    draftBaseRevision = server.draftBaseRevision,
    hasServerSavedDraft = server.hasSavedDraft,
)

private fun String.shortRevision(): String = substringAfter(':', this).take(8)
