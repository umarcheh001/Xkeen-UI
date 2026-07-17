package io.xkeen.mobile.app

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

internal data class OutboundsFragmentIndex(
    val directory: String,
    val currentName: String,
    val items: List<OutboundsFragment>,
)

internal data class OutboundsSnapshot(
    val file: String,
    val path: String,
    val nodes: List<OutboundNode>,
)

internal data class ActiveOutboundSnapshot(
    val available: Boolean,
    val key: String?,
    val tag: String?,
    val message: String?,
)

internal data class OutboundLinkSnapshot(
    val file: String,
    val path: String,
    val url: String?,
    val outboundTag: String,
    val sourceFingerprint: String,
    val managedKind: String? = null,
)

internal data class OutboundLinkSaveRequest(
    val url: String,
    val outboundTag: String,
    val restart: Boolean,
)

internal data class OutboundLinkSaveResult(
    val file: String,
    val restartRequested: Boolean,
    val restarted: Boolean,
)

internal data class OutboundPoolSaveEntry(
    val tag: String,
    val url: String,
)

internal data class OutboundPoolSaveRequest(
    val entries: List<OutboundPoolSaveEntry>,
    val restart: Boolean,
    val replacePool: Boolean,
    val writeRaw: Boolean = true,
    val sockoptMark255: Boolean = false,
)

internal data class OutboundPoolSaveResult(
    val file: String,
    val updated: Int,
    val replacedPool: Boolean,
    val tags: List<String>,
    val restartRequested: Boolean,
    val restarted: Boolean,
)

internal interface OutboundsPort {
    suspend fun listFragments(baseUrl: String): OutboundsFragmentIndex

    suspend fun load(baseUrl: String, filename: String): OutboundsSnapshot

    suspend fun loadActive(baseUrl: String, filename: String): ActiveOutboundSnapshot

    suspend fun loadLink(baseUrl: String, filename: String): OutboundLinkSnapshot

    suspend fun saveLink(
        baseUrl: String,
        filename: String,
        request: OutboundLinkSaveRequest,
    ): OutboundLinkSaveResult

    suspend fun savePool(
        baseUrl: String,
        filename: String,
        request: OutboundPoolSaveRequest,
    ): OutboundPoolSaveResult

    suspend fun ping(baseUrl: String, filename: String, nodeKey: String): OutboundLatency

    suspend fun pingAll(
        baseUrl: String,
        filename: String,
        nodeKeys: List<String>,
    ): Map<String, OutboundLatency>
}

internal class WebPanelOutboundsPort(
    private val transport: CompanionHttpTransport,
) : OutboundsPort {
    override suspend fun listFragments(baseUrl: String): OutboundsFragmentIndex =
        parseOutboundsFragmentIndex(
            transport.get(
                CompanionHttpRequest(baseUrl = baseUrl, endpoint = "/api/outbounds/fragments"),
            ).body,
        )

    override suspend fun load(baseUrl: String, filename: String): OutboundsSnapshot =
        parseOutboundsSnapshot(
            transport.get(
                CompanionHttpRequest(
                    baseUrl = baseUrl,
                    endpoint = "/api/xray/outbounds/nodes?file=${filename.outboundsUrlEncoded()}",
                ),
            ).body,
        )

    override suspend fun loadActive(baseUrl: String, filename: String): ActiveOutboundSnapshot =
        parseActiveOutboundSnapshot(
            transport.get(
                CompanionHttpRequest(
                    baseUrl = baseUrl,
                    endpoint = "/api/xray/outbounds/active?all=1&file=${filename.outboundsUrlEncoded()}",
                ),
            ).body,
        )

    override suspend fun loadLink(baseUrl: String, filename: String): OutboundLinkSnapshot =
        parseOutboundLinkSnapshot(
            transport.get(
                CompanionHttpRequest(
                    baseUrl = baseUrl,
                    endpoint = "/api/outbounds?file=${filename.outboundsUrlEncoded()}",
                ),
            ).body,
        )

    override suspend fun saveLink(
        baseUrl: String,
        filename: String,
        request: OutboundLinkSaveRequest,
    ): OutboundLinkSaveResult = parseOutboundLinkSaveResult(
        body = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/outbounds?file=${filename.outboundsUrlEncoded()}",
                body = JSONObject()
                    .put("url", request.url.trim())
                    .put("outbound_tag", cleanOutboundTag(request.outboundTag))
                    .put("restart", request.restart)
                    .toString(),
            ),
        ).body,
        restartRequested = request.restart,
    )

    override suspend fun savePool(
        baseUrl: String,
        filename: String,
        request: OutboundPoolSaveRequest,
    ): OutboundPoolSaveResult = parseOutboundPoolSaveResult(
        body = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/xray/outbounds/proxies?file=${filename.outboundsUrlEncoded()}",
                body = JSONObject()
                    .put(
                        "entries",
                        JSONArray().apply {
                            request.entries.forEach { entry ->
                                put(
                                    JSONObject()
                                        .put("tag", cleanOutboundTag(entry.tag))
                                        .put("url", entry.url.trim()),
                                )
                            }
                        },
                    )
                    .put("restart", request.restart)
                    .put("replace_pool", request.replacePool)
                    .put("write_raw", request.writeRaw)
                    .put("sockopt_mark_255", request.sockoptMark255)
                    .toString(),
            ),
        ).body,
        restartRequested = request.restart,
    )

    override suspend fun ping(
        baseUrl: String,
        filename: String,
        nodeKey: String,
    ): OutboundLatency = parseSingleOutboundPing(
        transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/xray/outbounds/nodes/ping?file=${filename.outboundsUrlEncoded()}",
                body = JSONObject().put("node_key", nodeKey).toString(),
            ),
        ).body,
    )

    override suspend fun pingAll(
        baseUrl: String,
        filename: String,
        nodeKeys: List<String>,
    ): Map<String, OutboundLatency> = parseBulkOutboundPing(
        transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/xray/outbounds/nodes/ping-bulk?file=${filename.outboundsUrlEncoded()}",
                body = JSONObject()
                    .put("node_keys", JSONArray(nodeKeys))
                    .put("timeout_s", 8)
                    .toString(),
            ),
        ).body,
    )
}

internal class DemoOutboundsPort : OutboundsPort {
    private var link = "vless://00000000-0000-4000-8000-000000000000@nl.example.net:443?security=reality&pbk=demo-public-key#Amsterdam"
    private var tag = "proxy-nl"
    private val nodes = listOf(
        OutboundNode(
            key = "demo-nl",
            tag = "proxy-nl",
            name = "Нидерланды · Амстердам",
            protocol = "vless",
            transport = "xhttp",
            security = "reality",
            host = "nl.example.net",
            port = "443",
            sni = "cdn.example.net",
            detail = "",
            latency = OutboundLatency("ok", 47),
        ),
    )

    override suspend fun listFragments(baseUrl: String): OutboundsFragmentIndex =
        OutboundsFragmentIndex(
            directory = "/opt/etc/xray/configs",
            currentName = "04_outbounds.json",
            items = listOf(OutboundsFragment("04_outbounds.json")),
        )

    override suspend fun load(baseUrl: String, filename: String): OutboundsSnapshot =
        OutboundsSnapshot(filename, "/opt/etc/xray/configs/$filename", nodes)

    override suspend fun loadActive(baseUrl: String, filename: String): ActiveOutboundSnapshot =
        ActiveOutboundSnapshot(true, nodes.first().key, nodes.first().tag, "Активный outbound подтверждён Xray.")

    override suspend fun loadLink(baseUrl: String, filename: String): OutboundLinkSnapshot =
        OutboundLinkSnapshot(
            file = filename,
            path = "/opt/etc/xray/configs/$filename",
            url = link,
            outboundTag = tag,
            sourceFingerprint = link.outboundsFingerprint(),
        )

    override suspend fun saveLink(
        baseUrl: String,
        filename: String,
        request: OutboundLinkSaveRequest,
    ): OutboundLinkSaveResult {
        link = request.url
        tag = cleanOutboundTag(request.outboundTag)
        return OutboundLinkSaveResult(filename, request.restart, request.restart)
    }

    override suspend fun savePool(
        baseUrl: String,
        filename: String,
        request: OutboundPoolSaveRequest,
    ): OutboundPoolSaveResult = OutboundPoolSaveResult(
        file = filename,
        updated = request.entries.size,
        replacedPool = request.replacePool,
        tags = request.entries.map { cleanOutboundTag(it.tag) },
        restartRequested = request.restart,
        restarted = request.restart,
    )

    override suspend fun ping(baseUrl: String, filename: String, nodeKey: String): OutboundLatency =
        OutboundLatency("ok", 42)

    override suspend fun pingAll(
        baseUrl: String,
        filename: String,
        nodeKeys: List<String>,
    ): Map<String, OutboundLatency> = nodeKeys.associateWith { OutboundLatency("ok", 42) }
}

internal class OutboundsException(message: String, cause: Throwable? = null) : Exception(message, cause)

internal fun parseOutboundsFragmentIndex(body: String): OutboundsFragmentIndex {
    val payload = body.outboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw OutboundsException("Сервер не вернул список outbounds-фрагментов.")
    }
    val itemsJson = payload.optJSONArray("items")
    val items = buildList {
        if (itemsJson != null) {
            for (index in 0 until itemsJson.length()) {
                val item = itemsJson.optJSONObject(index) ?: continue
                val name = item.optString("name").trim()
                if (!name.lowercase().startsWith("04_outbounds") || !name.lowercase().endsWith(".json")) continue
                add(
                    OutboundsFragment(
                        name = name,
                        sizeBytes = item.outboundsOptLongOrNull("size"),
                        modifiedAtEpochSeconds = item.outboundsOptLongOrNull("mtime"),
                    ),
                )
            }
        }
    }.sortedBy { it.name.lowercase() }
    return OutboundsFragmentIndex(
        directory = payload.optString("dir").trim(),
        currentName = payload.optString("current").trim(),
        items = items,
    )
}

internal fun parseOutboundsSnapshot(body: String): OutboundsSnapshot {
    val payload = body.outboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw OutboundsException("Сервер не вернул proxy-узлы.")
    }
    val latency = parseOutboundLatencyMap(payload.optJSONObject("node_latency"))
    val nodesJson = payload.optJSONArray("nodes")
    val nodes = buildList {
        if (nodesJson != null) {
            for (index in 0 until nodesJson.length()) {
                val item = nodesJson.optJSONObject(index) ?: continue
                val key = item.optString("key").trim()
                val tag = item.optString("tag").trim()
                if (key.isBlank() || tag.isBlank()) continue
                add(
                    OutboundNode(
                        key = key,
                        tag = tag,
                        name = item.optString("name").trim(),
                        protocol = item.optString("protocol").trim(),
                        transport = item.optString("transport").trim(),
                        security = item.optString("security").trim(),
                        host = item.optString("host").trim(),
                        port = item.opt("port")?.toString()?.trim().orEmpty(),
                        sni = item.optString("sni").trim(),
                        detail = item.optString("detail").trim(),
                        subscriptionName = item.optString("subscription_node_name").trim().takeIf(String::isNotBlank),
                        latency = latency[key],
                    ),
                )
            }
        }
    }
    return OutboundsSnapshot(
        file = payload.optString("file").trim(),
        path = payload.optString("path").trim(),
        nodes = nodes,
    )
}

internal fun parseActiveOutboundSnapshot(body: String): ActiveOutboundSnapshot {
    val payload = body.outboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw OutboundsException("Сервер не вернул активный outbound.")
    }
    val active = payload.optJSONObject("active")
    return ActiveOutboundSnapshot(
        available = payload.optBoolean("available", false),
        key = active?.optString("key")?.trim()?.takeIf(String::isNotBlank),
        tag = active?.optString("tag")?.trim()?.takeIf(String::isNotBlank),
        message = payload.optString("message").trim().takeIf(String::isNotBlank),
    )
}

internal fun parseOutboundLinkSnapshot(body: String): OutboundLinkSnapshot {
    val payload = body.outboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw OutboundsException("Сервер не вернул редактор outbounds.")
    }
    val text = payload.optString("text").orEmpty()
    return OutboundLinkSnapshot(
        file = payload.optString("file").trim(),
        path = payload.optString("path").trim(),
        url = payload.optString("url").trim().takeIf(String::isNotBlank),
        outboundTag = cleanOutboundTag(payload.optString("outbound_tag", "proxy")),
        sourceFingerprint = text.outboundsFingerprint(),
        // JSONC comments are not ownership metadata: an old generated header
        // can remain after the main file becomes a normal editable fragment.
        // The backend resolves ownership from its subscription state instead.
        managedKind = payload.optString("managed_kind").trim().lowercase()
            .takeIf { it == "subscription" },
    )
}

internal fun parseOutboundLinkSaveResult(
    body: String,
    restartRequested: Boolean,
): OutboundLinkSaveResult {
    val payload = body.outboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw OutboundsException("Сервер не сохранил proxy-ссылку.")
    }
    return OutboundLinkSaveResult(
        file = payload.optString("file").trim(),
        restartRequested = restartRequested,
        restarted = payload.optBoolean("restarted", false),
    )
}

internal fun parseOutboundPoolSaveResult(
    body: String,
    restartRequested: Boolean,
): OutboundPoolSaveResult {
    val payload = body.outboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw OutboundsException("Сервер не сохранил пул proxy-ссылок.")
    }
    val tagsJson = payload.optJSONArray("tags")
    val tags = buildList {
        if (tagsJson != null) {
            for (index in 0 until tagsJson.length()) {
                tagsJson.optString(index).trim().takeIf(String::isNotBlank)?.let(::add)
            }
        }
    }
    return OutboundPoolSaveResult(
        file = payload.optString("file").trim(),
        updated = payload.optInt("updated", 0),
        replacedPool = payload.optBoolean("replaced_pool", false),
        tags = tags,
        restartRequested = restartRequested,
        restarted = payload.optBoolean("restarted", false),
    )
}

internal fun parseSingleOutboundPing(body: String): OutboundLatency {
    val payload = body.outboundsJsonObject()
    val entry = payload.optJSONObject("entry") ?: payload
    return parseOutboundLatency(entry).also {
        if (!payload.optBoolean("ok", false) && it.status != "error") {
            throw OutboundsException("Сервер не проверил задержку proxy-узла.")
        }
    }
}

internal fun parseBulkOutboundPing(body: String): Map<String, OutboundLatency> {
    val payload = body.outboundsJsonObject()
    if (!payload.optBoolean("ok", false)) {
        throw OutboundsException("Сервер не проверил задержку proxy-узлов.")
    }
    val direct = parseOutboundLatencyMap(payload.optJSONObject("node_latency"))
    if (direct.isNotEmpty()) return direct
    val results = payload.optJSONArray("results") ?: return emptyMap()
    return buildMap {
        for (index in 0 until results.length()) {
            val result = results.optJSONObject(index) ?: continue
            val key = result.optString("node_key").trim()
            val entry = result.optJSONObject("entry") ?: result
            if (key.isNotBlank()) put(key, parseOutboundLatency(entry))
        }
    }
}

private fun parseOutboundLatencyMap(payload: JSONObject?): Map<String, OutboundLatency> = buildMap {
    if (payload == null) return@buildMap
    val keys = payload.keys()
    while (keys.hasNext()) {
        val key = keys.next()
        val item = payload.optJSONObject(key) ?: continue
        put(key, parseOutboundLatency(item))
    }
}

private fun parseOutboundLatency(payload: JSONObject): OutboundLatency = OutboundLatency(
    status = payload.optString("status").trim().ifBlank {
        if (payload.has("delay_ms") && !payload.isNull("delay_ms")) "ok" else "unknown"
    },
    delayMillis = payload.outboundsOptLongOrNull("delay_ms"),
    message = payload.optString("error").trim().takeIf(String::isNotBlank),
)

private fun String.outboundsJsonObject(): JSONObject = try {
    JSONObject(this)
} catch (error: Exception) {
    throw OutboundsException("Xkeen UI вернул неожиданный ответ для outbounds.", error)
}

private fun String.outboundsUrlEncoded(): String =
    URLEncoder.encode(this, StandardCharsets.UTF_8.name())

private fun JSONObject.outboundsOptLongOrNull(name: String): Long? =
    if (has(name) && !isNull(name)) optLong(name) else null

private fun String.outboundsFingerprint(): String = MessageDigest.getInstance("SHA-256")
    .digest(toByteArray(StandardCharsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte) }
