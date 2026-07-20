package io.xkeen.mobile.app

import org.json.JSONObject

internal data class PortsSaveResult(
    val restarted: Boolean,
)

internal interface PortsEditorPort {
    suspend fun load(baseUrl: String, document: PortsDocumentId): String

    suspend fun save(
        baseUrl: String,
        document: PortsDocumentId,
        content: String,
        restart: Boolean,
    ): PortsSaveResult
}

internal class WebPanelPortsEditorPort(
    private val transport: CompanionHttpTransport,
) : PortsEditorPort {
    override suspend fun load(baseUrl: String, document: PortsDocumentId): String {
        val response = transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = document.endpoint,
            ),
        )
        val root = response.body.asPortsJson("загрузку ${document.fileName}")
        if (!root.has("content") || root.isNull("content")) {
            throw PortsEditorException("Сервер не вернул содержимое ${document.fileName}.")
        }
        return root.optString("content")
    }

    override suspend fun save(
        baseUrl: String,
        document: PortsDocumentId,
        content: String,
        restart: Boolean,
    ): PortsSaveResult {
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = document.endpoint,
                body = JSONObject()
                    .put("content", content)
                    .put("restart", restart)
                    .toString(),
            ),
        )
        val root = response.body.asPortsJson("сохранение ${document.fileName}")
        if (!root.optBoolean("ok", false)) {
            throw PortsEditorException("Сервер не подтвердил сохранение ${document.fileName}.")
        }
        return PortsSaveResult(restarted = root.optBoolean("restarted", false))
    }
}

internal class DemoPortsEditorPort : PortsEditorPort {
    private val content = PortsDocumentId.entries.associateWith { document ->
        if (document.isJson) "{}\n" else "# ${document.fileName}\n"
    }.toMutableMap()

    override suspend fun load(baseUrl: String, document: PortsDocumentId): String =
        content.getValue(document)

    override suspend fun save(
        baseUrl: String,
        document: PortsDocumentId,
        content: String,
        restart: Boolean,
    ): PortsSaveResult {
        this.content[document] = content
        return PortsSaveResult(restarted = restart)
    }
}

internal class PortsEditorException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

private fun String.asPortsJson(operation: String): JSONObject = try {
    JSONObject(this)
} catch (error: Exception) {
    throw PortsEditorException("Xkeen UI вернул некорректный ответ на $operation.", error)
}
