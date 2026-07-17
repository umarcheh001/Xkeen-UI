package io.xkeen.mobile.app

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import org.json.JSONObject

internal data class InboundsFragmentIndex(
    val directory: String,
    val currentName: String,
    val items: List<InboundsFragment>,
)

internal data class InboundsSnapshot(
    val file: String,
    val path: String,
    val rawMode: String?,
    val mode: InboundsMode?,
)

internal data class InboundsApplyResult(
    val file: String,
    val rawMode: String,
    val mode: InboundsMode,
    val restartRequested: Boolean,
    val restarted: Boolean,
)

internal interface InboundsPort {
    suspend fun listFragments(baseUrl: String): InboundsFragmentIndex

    suspend fun load(baseUrl: String, filename: String): InboundsSnapshot

    suspend fun apply(
        baseUrl: String,
        filename: String,
        mode: InboundsMode,
        restart: Boolean,
    ): InboundsApplyResult
}

internal class WebPanelInboundsPort(
    private val transport: CompanionHttpTransport,
) : InboundsPort {
    override suspend fun listFragments(baseUrl: String): InboundsFragmentIndex {
        val response = transport.get(
            CompanionHttpRequest(baseUrl = baseUrl, endpoint = "/api/inbounds/fragments"),
        )
        return parseInboundsFragmentIndex(response.body)
    }

    override suspend fun load(baseUrl: String, filename: String): InboundsSnapshot {
        val response = transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/inbounds?file=${filename.urlEncoded()}",
            ),
        )
        return parseInboundsSnapshot(response.body)
    }

    override suspend fun apply(
        baseUrl: String,
        filename: String,
        mode: InboundsMode,
        restart: Boolean,
    ): InboundsApplyResult {
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/inbounds?file=${filename.urlEncoded()}",
                body = JSONObject()
                    .put("mode", mode.apiValue)
                    .put("restart", restart)
                    .put("preserve_extras", true)
                    .put("add_socks", false)
                    .toString(),
            ),
        )
        return parseInboundsApplyResult(response.body, mode, restart)
    }
}

internal class DemoInboundsPort : InboundsPort {
    private var mode = InboundsMode.Hybrid

    override suspend fun listFragments(baseUrl: String): InboundsFragmentIndex =
        InboundsFragmentIndex(
            directory = "/opt/etc/xray/configs",
            currentName = "03_inbounds.json",
            items = listOf(InboundsFragment("03_inbounds.json")),
        )

    override suspend fun load(baseUrl: String, filename: String): InboundsSnapshot =
        InboundsSnapshot(
            file = filename,
            path = "/opt/etc/xray/configs/$filename",
            rawMode = mode.apiValue,
            mode = mode,
        )

    override suspend fun apply(
        baseUrl: String,
        filename: String,
        mode: InboundsMode,
        restart: Boolean,
    ): InboundsApplyResult {
        this.mode = mode
        return InboundsApplyResult(
            file = filename,
            rawMode = mode.apiValue,
            mode = mode,
            restartRequested = restart,
            restarted = restart,
        )
    }
}

internal class InboundsException(message: String, cause: Throwable? = null) : Exception(message, cause)

internal fun parseInboundsFragmentIndex(body: String): InboundsFragmentIndex {
    val payload = body.inboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw InboundsException("Сервер не вернул список inbound-фрагментов.")
    }
    val itemsJson = payload.optJSONArray("items")
    val items = buildList {
        if (itemsJson != null) {
            for (index in 0 until itemsJson.length()) {
                val item = itemsJson.optJSONObject(index) ?: continue
                val name = item.optString("name").trim()
                if (!name.lowercase().startsWith("03_inbounds") || !name.lowercase().endsWith(".json")) continue
                add(
                    InboundsFragment(
                        name = name,
                        sizeBytes = item.optLongOrNull("size"),
                        modifiedAtEpochSeconds = item.optLongOrNull("mtime"),
                    ),
                )
            }
        }
    }.sortedBy { it.name.lowercase() }
    return InboundsFragmentIndex(
        directory = payload.optString("dir").trim(),
        currentName = payload.optString("current").trim(),
        items = items,
    )
}

internal fun parseInboundsSnapshot(body: String): InboundsSnapshot {
    val payload = body.inboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw InboundsException("Сервер не вернул состояние inbounds.")
    }
    val rawMode = payload.optString("mode").trim().takeIf(String::isNotBlank)
    return InboundsSnapshot(
        file = payload.optString("file").trim(),
        path = payload.optString("path").trim(),
        rawMode = rawMode,
        mode = InboundsMode.fromApiValue(rawMode),
    )
}

internal fun parseInboundsApplyResult(
    body: String,
    requestedMode: InboundsMode,
    restartRequested: Boolean,
): InboundsApplyResult {
    val payload = body.inboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw InboundsException("Сервер не применил режим inbounds.")
    }
    val rawMode = payload.optString("mode").trim().ifBlank { requestedMode.apiValue }
    val confirmedMode = InboundsMode.fromApiValue(rawMode)
        ?: throw InboundsException("Сервер вернул неизвестный режим inbounds: $rawMode.")
    return InboundsApplyResult(
        file = payload.optString("file").trim(),
        rawMode = rawMode,
        mode = confirmedMode,
        restartRequested = restartRequested,
        restarted = payload.optBoolean("restarted", false),
    )
}

private fun String.inboundsJsonObject(): JSONObject = try {
    JSONObject(this)
} catch (error: Exception) {
    throw InboundsException("Xkeen UI вернул неожиданный ответ для режима inbounds.", error)
}

private fun String.urlEncoded(): String =
    URLEncoder.encode(this, StandardCharsets.UTF_8.name())

private fun JSONObject.optLongOrNull(name: String): Long? =
    if (has(name) && !isNull(name)) optLong(name) else null
