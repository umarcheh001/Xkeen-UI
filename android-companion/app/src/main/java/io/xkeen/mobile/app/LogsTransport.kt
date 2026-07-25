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
                        entries = item.optJSONArray("entries").toLogEntries(
                            defaultSource = if (source.equals("access", ignoreCase = true)) {
                                "xray-access"
                            } else {
                                "xray-error"
                            },
                        ),
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

private fun JSONArray?.toLogEntries(defaultSource: String = "xray"): List<LogEntry> {
    if (this == null) return emptyList()
    return buildList {
        var previousLevel = LogLevel.Info
        for (index in 0 until length()) {
            val item = optJSONObject(index) ?: continue
            val message = item.optString("message").trimEnd()
            if (message.isBlank()) continue
            val source = item.optString("source").trim().ifBlank { defaultSource }
            val isAccess = source.equals("xray-access", ignoreCase = true) ||
                source.equals("access", ignoreCase = true)
            val rawLevel = item.optString("level")
            val isContinuation = message.firstOrNull()?.isWhitespace() == true
            // Xray access.log has no logger severity. Keep a neutral value even when the
            // payload happens to contain words such as "ERROR" or "failed"; the viewer also
            // bypasses level thresholds for this stream.
            val level = if (isAccess) {
                LogLevel.Info
            } else if (isContinuation && rawLevel.isBlank() && !xrayLevelMarkerRegex.containsMatchIn(message)) {
                // Continuation records belong to the preceding physical Xray record. Older
                // servers omitted the inherited level, so retain it here instead of inspecting
                // arbitrary payload words on the continuation line.
                previousLevel
            } else {
                parseXrayLogLevel(rawLevel = rawLevel, message = message)
            }
            if (!isContinuation && !isAccess) previousLevel = level
            add(
                LogEntry(
                    id = item.optString("id").trim(),
                    time = item.optString("time").trim().ifBlank { "—" },
                    source = source,
                    // The mobile endpoint normally sends a normalized level, but older
                    // servers only exposed the raw Xray line. Re-run the semantic detector
                    // here so marker severity remains authoritative on every client.
                    level = level,
                    message = message,
                ),
            )
        }
    }
}

/**
 * Converts the server level plus the line itself into the level used by the Xray viewer.
 *
 * Xray often prefixes a record with `[Info]` while the actual operation failed later in the
 * message (`stream ERROR`, `failed`, ...). The logger marker is the source of truth: payload
 * words must never override it. If a legacy/unstructured record has no marker, use the server
 * level when available and retain a narrow keyword fallback for compatibility. `trace` is
 * treated as DEBUG because Xray's public loglevel vocabulary starts at debug.
 */
internal fun parseXrayLogLevel(rawLevel: String?, message: String): LogLevel {
    val lower = message.lowercase()
    val marker = xrayLevelMarkerRegex.find(message)
    val markerToken = marker?.groupValues
        ?.drop(1)
        ?.firstOrNull(String::isNotBlank)
        ?.lowercase()
    val rawToken = rawLevel.normalizedXrayLevelToken()
    return when {
        markerToken != null -> markerToken.toLogLevelValue()
        rawToken != null -> rawToken.toLogLevelValue()
        xrayErrorSignalRegex.containsMatchIn(lower) -> LogLevel.Error
        xrayWarningSignalRegex.containsMatchIn(lower) -> LogLevel.Warning
        else -> LogLevel.Info
    }
}

private fun String?.normalizedXrayLevelToken(): String? =
    this?.trim()?.lowercase()?.takeIf { it in XRAY_LEVEL_TOKENS }

private fun String.toLogLevelValue(): LogLevel = when (this) {
    "debug", "trace" -> LogLevel.Debug
    "warning", "warn" -> LogLevel.Warning
    "error", "fatal", "panic" -> LogLevel.Error
    else -> LogLevel.Info
}

private val XRAY_LEVEL_TOKENS = setOf(
    "debug",
    "trace",
    "info",
    "warning",
    "warn",
    "error",
    "fatal",
    "panic",
)

private val xrayErrorSignalRegex = Regex(
    "\\b(?:error|fail(?:ed|ure)?|fatal|panic)\\b",
    RegexOption.IGNORE_CASE,
)
private val xrayWarningSignalRegex = Regex(
    "\\b(?:warning|warn)\\b",
    RegexOption.IGNORE_CASE,
)
private val xrayLevelMarkerRegex = Regex(
    "(?:\\[(debug|trace|info|warning|warn|error|fatal|panic)]|\\blevel\\s*[:=]\\s*(debug|trace|info|warning|warn|error|fatal|panic)\\b)",
    RegexOption.IGNORE_CASE,
)
