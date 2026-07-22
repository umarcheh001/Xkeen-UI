package io.xkeen.mobile.app

import org.json.JSONArray
import org.json.JSONObject

enum class MihomoNodeImportMode(
    val wireValue: String,
    val displayName: String,
    val inputLabel: String,
) {
    Auto("auto", "Авто", "Ссылка, подписка или конфиг"),
    Proxy("proxy", "Ссылка", "Ссылка узла"),
    Subscription("subscription", "Подписка", "HTTP(S) или Happ-ссылка"),
    WireGuard("wireguard", "WireGuard", "Конфигурация WireGuard / AmneziaWG"),
    OpenVpn("openvpn", "OpenVPN", "Содержимое .ovpn"),
    Tailscale("tailscale", "Tailscale", "Параметры или tailscale:// ссылка"),
}

internal data class MihomoNodeImportRequest(
    val content: String,
    val source: String,
    val mode: MihomoNodeImportMode,
    val groups: List<String>,
    val autoUpdateSubscriptions: Boolean,
    val intervalHours: Int,
)

internal data class MihomoNodeImportResult(
    val content: String,
    val insertedNames: List<String>,
    val insertedKind: String,
    val skippedCount: Int,
    val highlightStart: Int,
    val highlightEnd: Int,
    val registeredSubscriptions: Int,
    val subscriptionWarning: String?,
)

internal interface MihomoNodePort {
    suspend fun importDraft(baseUrl: String, request: MihomoNodeImportRequest): MihomoNodeImportResult
}

internal class WebPanelMihomoNodePort(
    private val transport: CompanionHttpTransport,
) : MihomoNodePort {
    override suspend fun importDraft(
        baseUrl: String,
        request: MihomoNodeImportRequest,
    ): MihomoNodeImportResult {
        val body = JSONObject()
            .put("content", request.content)
            .put("source", request.source)
            .put("mode", request.mode.wireValue)
            .put("groups", JSONArray(request.groups))
            .put("auto_update_subscriptions", request.autoUpdateSubscriptions)
            .put("interval_hours", request.intervalHours.coerceIn(1, 168))
            .toString()
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/mihomo/node/import-draft",
                body = body,
            ),
        )
        val root = response.requireMihomoNodeJson()
        if (!root.optBoolean("ok", false)) {
            throw MihomoNodeException(
                root.optString("error").trim().ifBlank { "Xkeen UI не подтвердил импорт узла Mihomo." },
            )
        }
        val content = root.optString("content")
        if (content.isBlank()) throw MihomoNodeException("Xkeen UI вернул пустой config.yaml.")
        val highlight = root.optJSONObject("highlight") ?: JSONObject()
        val start = highlight.optInt("start", 0).coerceIn(0, content.length)
        val end = highlight.optInt("end", start).coerceIn(start, content.length)
        return MihomoNodeImportResult(
            content = content,
            insertedNames = root.optJSONArray("inserted_names").toStringList(),
            insertedKind = root.optString("inserted_kind").trim().ifBlank { "proxy" },
            skippedCount = root.optInt("skipped_count", 0).coerceAtLeast(0),
            highlightStart = start,
            highlightEnd = end,
            registeredSubscriptions = root.optInt("registered_subscriptions", 0).coerceAtLeast(0),
            subscriptionWarning = root.optString("subscription_warning").trim().ifBlank { null },
        )
    }
}

internal class DemoMihomoNodePort : MihomoNodePort {
    override suspend fun importDraft(
        baseUrl: String,
        request: MihomoNodeImportRequest,
    ): MihomoNodeImportResult {
        val name = "Mobile-Demo"
        val snippet = "\nproxies:\n  - name: $name\n    type: direct\n"
        val content = request.content.trimEnd() + snippet
        val start = content.lastIndexOf("  - name: $name")
        return MihomoNodeImportResult(
            content = content,
            insertedNames = listOf(name),
            insertedKind = "proxy",
            skippedCount = 0,
            highlightStart = start.coerceAtLeast(0),
            highlightEnd = content.length,
            registeredSubscriptions = 0,
            subscriptionWarning = null,
        )
    }
}

internal class MihomoNodeException(message: String, cause: Throwable? = null) : Exception(message, cause)

internal fun mihomoProxyGroupNames(content: String): List<String> {
    val names = mutableListOf<String>()
    var inGroups = false
    content.replace("\r\n", "\n").replace('\r', '\n').lineSequence().forEach { line ->
        val stripped = line.trimStart()
        val indent = line.length - stripped.length
        if (indent == 0 && stripped.startsWith("proxy-groups:")) {
            inGroups = true
        } else {
            if (inGroups && indent == 0 && stripped.isNotBlank() && !stripped.startsWith('#')) {
                inGroups = false
            }
            if (inGroups) {
                Regex("^-\\s+name\\s*:\\s*(.+?)\\s*$").matchEntire(stripped)?.groupValues?.get(1)
                    ?.substringBefore(" #")
                    ?.trim()
                    ?.removeSurrounding("\"")
                    ?.removeSurrounding("'")
                    ?.takeIf(String::isNotBlank)
                    ?.let { name -> if (name !in names) names += name }
            }
        }
    }
    return names
}

private fun CompanionHttpResponse.requireMihomoNodeJson(): JSONObject = try {
    JSONObject(body)
} catch (error: Exception) {
    throw MihomoNodeException("Xkeen UI вернул некорректный ответ импорта узла Mihomo.", error)
}

private fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) {
            optString(index).trim().takeIf(String::isNotBlank)?.let(::add)
        }
    }
}
