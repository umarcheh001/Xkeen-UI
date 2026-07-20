package io.xkeen.mobile.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

internal const val MOBILE_LOGS_PATH = "/api/mobile/v1/logs"

/** A page from one server-side log file.  The cursor is opaque to the client. */
internal data class RemoteLogStream(
    val source: String,
    val entries: List<LogEntry>,
    val cursor: String,
    val mode: String,
    val available: Boolean,
)

internal data class LogsTransportUpdate(
    val streams: List<RemoteLogStream>,
    val domainHintEntries: List<LogEntry> = emptyList(),
    val domainHintsSeeded: Boolean = false,
)

/**
 * Cursor polling is intentionally used instead of a second WebSocket stack.  It works through
 * the same authenticated HTTP seam as the rest of the companion and makes reconnect/rotation
 * explicit: a server can return a full snapshot whenever an old cursor is no longer valid.
 */
internal interface LogsTransportPort {
    suspend fun read(
        baseUrl: String,
        cursors: Map<String, String>,
        limit: Int = 200,
    ): LogsTransportUpdate

    suspend fun read(
        baseUrl: String,
        cursors: Map<String, String>,
        limit: Int = 200,
        includeDomainHintsSeed: Boolean,
    ): LogsTransportUpdate = read(baseUrl, cursors, limit)
}

internal class WebPanelLogsTransport(
    private val transport: CompanionHttpTransport,
) : LogsTransportPort {
    override suspend fun read(
        baseUrl: String,
        cursors: Map<String, String>,
        limit: Int,
    ): LogsTransportUpdate = read(
        baseUrl = baseUrl,
        cursors = cursors,
        limit = limit,
        includeDomainHintsSeed = false,
    )

    override suspend fun read(
        baseUrl: String,
        cursors: Map<String, String>,
        limit: Int,
        includeDomainHintsSeed: Boolean,
    ): LogsTransportUpdate {
        val cursorQuery = cursors
            .filterKeys { it in mobileLogSources }
            .mapNotNull { (source, cursor) ->
                cursor.takeIf { it.isNotBlank() }?.let {
                    "$source-cursor=${URLEncoder.encode(it, StandardCharsets.UTF_8.name())}"
                }
            }
        val query = buildList {
            if (limit != 200) add("limit=${limit.coerceIn(50, 500)}")
            if (includeDomainHintsSeed) add("include-domain-seed=1")
            addAll(cursorQuery)
        }.joinToString("&")
        val response = transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = if (query.isBlank()) MOBILE_LOGS_PATH else "$MOBILE_LOGS_PATH?$query",
            ),
        )
        val update = parseLogsTransportEnvelope(response.body)
        // Older servers safely ignore the additive query flag. Mark the one-shot attempt as
        // complete and continue with their ordinary error snapshot as a smaller fallback.
        return if (includeDomainHintsSeed && !update.domainHintsSeeded) {
            update.copy(domainHintsSeeded = true)
        } else {
            update
        }
    }
}

internal val mobileLogSources: Set<String> = setOf("error", "access")

internal fun parseLogsTransportEnvelope(body: String): LogsTransportUpdate {
    val root = JSONObject(body)
    if (!root.optBoolean("ok", false)) {
        val error = root.optJSONObject("error")
        throw IllegalStateException(
            error?.optString("message")?.takeIf(String::isNotBlank)
                ?: "Xkeen UI вернул некорректный ответ логов.",
        )
    }
    val data = root.optJSONObject("data")
        ?: throw IllegalStateException("В ответе Xkeen UI отсутствуют данные логов.")
    val contractVersion = data.optInt("contract_version", 1)
    if (contractVersion != 1) {
        throw IllegalStateException("Версия контракта логов $contractVersion пока не поддерживается.")
    }
    val streams = data.optJSONArray("streams")
        ?: throw IllegalStateException("В ответе Xkeen UI отсутствуют потоки логов.")
    val domainSeed = data.optJSONObject("domain_seed")
    return LogsTransportUpdate(
        streams = buildList {
            for (index in 0 until streams.length()) {
                val item = streams.optJSONObject(index) ?: continue
                val source = item.optString("source").trim()
                if (source !in mobileLogSources) continue
                add(
                    RemoteLogStream(
                        source = source,
                        entries = item.optJSONArray("entries").toLogEntries(),
                        cursor = item.optString("cursor").trim(),
                        mode = item.optString("mode", "append").trim().ifBlank { "append" },
                        available = item.optBoolean("available", false),
                    ),
                )
            }
        },
        domainHintEntries = domainSeed?.optJSONArray("entries").toLogEntries(),
        domainHintsSeeded = domainSeed != null,
    )
}

private fun JSONArray?.toLogEntries(): List<LogEntry> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) {
            val item = optJSONObject(index) ?: continue
            val message = item.optString("message").trimEnd()
            if (message.isBlank()) continue
            add(
                LogEntry(
                    id = item.optString("id").trim(),
                    time = item.optString("time").trim().ifBlank { "—" },
                    source = item.optString("source").trim().ifBlank { "xray" },
                    level = item.optString("level").toLogLevel(),
                    message = message,
                ),
            )
        }
    }
}

private fun String?.toLogLevel(): LogLevel =
    when (this?.trim()?.lowercase()) {
        "error" -> LogLevel.Error
        "warning", "warn" -> LogLevel.Warning
        else -> LogLevel.Info
    }
