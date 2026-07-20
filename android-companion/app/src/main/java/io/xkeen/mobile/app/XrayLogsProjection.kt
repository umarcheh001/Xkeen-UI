package io.xkeen.mobile.app

import com.google.re2j.Pattern

private val xrayTimestampPrefix = Regex(
    """^\d{4}/\d{2}/\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*""",
)
private const val MAX_SAFE_REGEX_LENGTH = 120
internal const val MAX_XRAY_LOG_CLIPBOARD_CHARS = 200_000

internal data class XrayLogsProjection(
    /** Entries are chronological: the live tail is the last item. */
    val entries: List<LogEntry>,
    val totalXrayEntries: Int,
    val regexError: String? = null,
)

internal fun LogsState.projectXrayLogs(): XrayLogsProjection {
    val devicesByIp = devices.associateBy(XrayLogDevice::ip)
    val xrayEntries = entries.filter(LogEntry::isXrayLogEntry)
    val sourceEntries = xrayEntries.filter { entry ->
        when (streamFilter) {
            XrayLogStreamFilter.All -> true
            XrayLogStreamFilter.Access -> entry.source.equals("xray-access", ignoreCase = true)
            XrayLogStreamFilter.Error -> entry.source.equals("xray-error", ignoreCase = true)
        }
    }
    val leveledEntries = sourceEntries.filter { entry ->
        when (levelFilter) {
            XrayLogLevelFilter.All -> true
            XrayLogLevelFilter.Info -> entry.level == LogLevel.Info
            XrayLogLevelFilter.Warning -> entry.level == LogLevel.Warning
            XrayLogLevelFilter.Error -> entry.level == LogLevel.Error
        }
    }

    val query = searchQuery.trim()
    if (query.isBlank()) {
        return XrayLogsProjection(
            entries = leveledEntries.sortedXrayLogsChronologically(),
            totalXrayEntries = xrayEntries.size,
        )
    }

    val matcher: (LogEntry) -> Boolean = if (useRegex) {
        query.regexSafetyError()?.let { error ->
            return XrayLogsProjection(
                entries = emptyList(),
                totalXrayEntries = xrayEntries.size,
                regexError = error,
            )
        }
        val regex = try {
            Pattern.compile(query, Pattern.CASE_INSENSITIVE)
        } catch (_: RuntimeException) {
            return XrayLogsProjection(
                entries = emptyList(),
                totalXrayEntries = xrayEntries.size,
                regexError = "Некорректное или неподдерживаемое регулярное выражение",
            )
        }
        { entry -> regex.matcher(entry.searchableText(this, devicesByIp)).find() }
    } else {
        { entry -> entry.searchableText(this, devicesByIp).contains(query, ignoreCase = true) }
    }

    val matchedEntries = leveledEntries.filter(matcher)
    return XrayLogsProjection(
        entries = if (matchedEntries.isEmpty()) {
            emptyList()
        } else {
            val contextEntries = matchedEntries.flatMap { matched ->
                matched.withContinuationContext(leveledEntries)
            }
            contextEntries.distinctBy { entry -> entry.id.ifBlank { "${entry.time}:${entry.message}" } }
                .sortedXrayLogsChronologically()
        },
        totalXrayEntries = xrayEntries.size,
    )
}

internal fun LogEntry.displayMessage(): String =
    message.replaceFirst(xrayTimestampPrefix, "").ifBlank { message }.let { display ->
        if (message.firstOrNull()?.isWhitespace() == true) "↳ ${display.trimStart()}" else display
    }

internal fun LogEntry.isXrayLogEntry(): Boolean =
    source.equals("xray", ignoreCase = true) || source.startsWith("xray-", ignoreCase = true)

internal fun LogEntry.xrayViewerIdentity(): String =
    id.ifBlank { "$source:$time:${message.hashCode()}" }

internal fun List<LogEntry>.unseenXrayEntriesAfter(lastSeenIdentity: String?): Int {
    if (isEmpty() || lastSeenIdentity == null) return 0
    val seenIndex = indexOfLast { entry -> entry.xrayViewerIdentity() == lastSeenIdentity }
    return if (seenIndex >= 0) lastIndex - seenIndex else size
}

internal data class XrayLogsClipboardPayload(
    val text: String,
    val entryCount: Int,
    val totalEntries: Int,
)

internal fun List<LogEntry>.toXrayLogsClipboardPayload(
    maxChars: Int = MAX_XRAY_LOG_CLIPBOARD_CHARS,
): XrayLogsClipboardPayload {
    if (isEmpty() || maxChars <= 0) return XrayLogsClipboardPayload("", 0, size)
    val newestThatFit = mutableListOf<String>()
    var usedChars = 0
    for (entry in asReversed()) {
        val separatorSize = if (newestThatFit.isEmpty()) 0 else 1
        if (usedChars + separatorSize + entry.message.length > maxChars) break
        newestThatFit += entry.message
        usedChars += separatorSize + entry.message.length
    }
    return XrayLogsClipboardPayload(
        text = newestThatFit.asReversed().joinToString("\n"),
        entryCount = newestThatFit.size,
        totalEntries = size,
    )
}

private fun LogEntry.searchableText(
    logs: LogsState,
    devicesByIp: Map<String, XrayLogDevice>,
): String {
    val enrichment = xrayLogInlineHints(
        displayMessage = displayMessage(),
        devicesByIp = devicesByIp,
        domainsByIp = logs.destinationDomainsByIp,
        showDeviceNames = logs.showDeviceNames,
        showDomains = logs.showDomains,
    ).joinToString(separator = " ") { hint -> hint.label }
    return "$time $source $message $enrichment"
}

private fun String.regexSafetyError(): String? = when {
    length > MAX_SAFE_REGEX_LENGTH -> "Регулярное выражение слишком длинное"
    else -> null
}

/**
 * Xray access logs can continue a request over adjacent physical lines (route/domain details).
 * A plain-text match keeps those neighboring lines together so a mobile search stays readable.
 */
private fun LogEntry.withContinuationContext(entries: List<LogEntry>): List<LogEntry> {
    val index = entries.indexOf(this)
    if (index < 0) return listOf(this)
    val result = mutableListOf(this)
    var previous = index - 1
    while (previous >= 0 && entries[previous].isContinuationOf(this)) {
        result += entries[previous]
        previous -= 1
    }
    var next = index + 1
    while (next < entries.size && entries[next].isContinuationOf(this)) {
        result += entries[next]
        next += 1
    }
    return result
}

private fun LogEntry.isContinuationOf(previous: LogEntry): Boolean =
    source == previous.source &&
        message.firstOrNull()?.isWhitespace() == true &&
        (time == previous.time || time == "—")

internal fun List<LogEntry>.sortedXrayLogsChronologically(): List<LogEntry> {
    val latestDate = mapNotNull { entry -> entry.fullTimestamp()?.take(10) }.maxOrNull().orEmpty()
    val sortKeys = indices.associateWith { index ->
        val entry = this[index]
        entry.fullTimestamp()
            ?: entry.nearestContextTimestamp(this, index)
            ?: "$latestDate ${entry.time.trim()}"
    }
    return withIndex()
        .sortedWith(
            compareBy<IndexedValue<LogEntry>>(
                { indexed -> sortKeys.getValue(indexed.index) },
                { indexed -> if (indexed.value.message.firstOrNull()?.isWhitespace() == true) 1 else 0 },
                { indexed -> indexed.index },
            ),
        )
        .map { indexed -> indexed.value }
}

private fun LogEntry.fullTimestamp(): String? =
    xrayTimestampPrefix.find(message)?.value?.trim()?.takeIf(String::isNotBlank)

private fun LogEntry.nearestContextTimestamp(entries: List<LogEntry>, index: Int): String? {
    if (message.firstOrNull()?.isWhitespace() != true) return null
    for (distance in 1 until entries.size) {
        val before = index - distance
        if (before >= 0) {
            entries[before].takeIf { it.source == source }?.fullTimestamp()?.let { return it }
        }
        val after = index + distance
        if (after < entries.size) {
            entries[after].takeIf { it.source == source }?.fullTimestamp()?.let { return it }
        }
    }
    return null
}
