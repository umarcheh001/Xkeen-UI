package io.xkeen.mobile.app

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import org.json.JSONObject

internal data class XrayFragmentInfo(
    val name: String,
    val sizeBytes: Long?,
    val modifiedAtEpochSeconds: Long?,
    val sensitive: Boolean,
)

internal data class XrayFragmentIndex(
    val directory: String,
    val currentName: String,
    val items: List<XrayFragmentInfo>,
)

internal data class XrayFragmentContent(
    /** Compatibility view for callers that only need the editor text. */
    val text: String,
    val hasJsoncSidecar: Boolean,
    val usesJsoncSidecar: Boolean,
    val publishedText: String = text,
    val savedText: String = text,
    val publishedRevision: String = "test:published",
    val savedRevision: String = publishedRevision,
    val draftBaseRevision: String = publishedRevision,
    val hasSavedDraft: Boolean = false,
    val publishedAt: String = "",
    val savedAt: String = "",
    val conflictCode: String? = null,
    val conflictMessage: String? = null,
)

internal interface XrayConfigSource {
    suspend fun listFragments(baseUrl: String): XrayFragmentIndex

    suspend fun loadFragment(baseUrl: String, filename: String): XrayFragmentContent
}

internal class WebPanelXrayConfigSource(
    private val transport: CompanionHttpTransport = HttpUrlConnectionCompanionTransport(),
) : XrayConfigSource {
    override suspend fun listFragments(baseUrl: String): XrayFragmentIndex {
        val response = request(baseUrl, "/api/routing/fragments")
        val payload = try {
            JSONObject(response.body)
        } catch (error: Exception) {
            throw XrayConfigException(
                "Xkeen UI вернул неожиданный ответ. Возможно, требуется авторизация.",
                error,
            )
        }
        if (!payload.optBoolean("ok", false)) {
            throw XrayConfigException("Сервер не вернул список конфигураций Xray.")
        }

        val itemsJson = payload.optJSONArray("items")
        val items = buildList {
            if (itemsJson != null) {
                for (index in 0 until itemsJson.length()) {
                    val item = itemsJson.optJSONObject(index) ?: continue
                    val name = item.optString("name").trim()
                    if (!name.isXrayConfigFilename()) continue
                    add(
                        XrayFragmentInfo(
                            name = name,
                            sizeBytes = item.optLongOrNull("size"),
                            modifiedAtEpochSeconds = item.optLongOrNull("mtime"),
                            sensitive = item.optBoolean("sensitive", false),
                        ),
                    )
                }
            }
        }.sortedBy { it.name.lowercase() }

        return XrayFragmentIndex(
            directory = payload.optString("dir"),
            currentName = payload.optString("current"),
            items = items,
        )
    }

    override suspend fun loadFragment(baseUrl: String, filename: String): XrayFragmentContent =
        run {
            require(filename.isXrayConfigFilename()) { "Unsupported Xray config filename" }
            val encoded = URLEncoder.encode(filename, StandardCharsets.UTF_8.name())
            val response = try {
                request(baseUrl, "/api/mobile/v1/xray/routing/document?document=$encoded")
            } catch (error: CompanionTransportException) {
                if (error.failure.statusCode == 404) {
                    throw XrayConfigException(
                        "На роутере установлена версия Xkeen UI без revision API. " +
                            "Обновите Xkeen UI для routing save/apply.",
                        error,
                    )
                }
                throw error
            }
            val server = parseRoutingDocumentEnvelope(response.body)
            XrayFragmentContent(
                text = server.savedContent,
                publishedText = server.publishedContent,
                savedText = server.savedContent,
                hasJsoncSidecar = server.usesJsonc,
                usesJsoncSidecar = server.usesJsonc,
                publishedRevision = server.publishedRevision,
                savedRevision = server.savedRevision,
                draftBaseRevision = server.draftBaseRevision,
                hasSavedDraft = server.hasSavedDraft,
                publishedAt = server.publishedAt,
                savedAt = server.savedAt,
                conflictCode = server.conflictCode,
                conflictMessage = server.conflictMessage,
            )
        }

    private suspend fun request(baseUrl: String, endpoint: String): CompanionHttpResponse =
        transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = endpoint,
            ),
        )
}

internal class XrayConfigException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

private fun String.isXrayConfigFilename(): Boolean {
    val normalized = trim().lowercase()
    return normalized.endsWith(".json") || normalized.endsWith(".jsonc")
}

private fun JSONObject.optLongOrNull(name: String): Long? =
    if (has(name) && !isNull(name)) optLong(name) else null
