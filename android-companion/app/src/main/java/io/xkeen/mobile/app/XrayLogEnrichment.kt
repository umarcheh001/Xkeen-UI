package io.xkeen.mobile.app

private const val MAX_DESTINATION_DOMAINS = 500
private const val MAX_CONNECTION_DOMAINS = 2_000

internal enum class XrayLogInlineHintKind {
    Device,
    Domain,
}

internal data class XrayLogInlineHint(
    val insertAfter: Int,
    val label: String,
    val kind: XrayLogInlineHintKind,
)

internal data class XrayLogDestination(
    val ip: String,
    val port: String = "",
) {
    val key: String
        get() = if (port.isBlank()) ip else "$ip:$port"
}

/** Session-scoped correlation cache equivalent to the web Xray-log domain helper. */
internal class XrayLogDomainResolver {
    private val domainsByIp = LinkedHashMap<String, String>()
    private val domainsByConnection = LinkedHashMap<String, String>()

    fun ingest(entries: List<LogEntry>): Map<String, String> {
        entries.sortedXrayLogsChronologically().forEach { entry -> ingest(entry.message) }
        return snapshot()
    }

    fun clear() {
        domainsByIp.clear()
        domainsByConnection.clear()
    }

    fun snapshot(): Map<String, String> = domainsByIp.toMap()

    private fun ingest(line: String) {
        val connectionId = extractXrayLogConnectionId(line)
        val firstDomain = collectXrayLogDomainCandidates(line).firstOrNull().orEmpty()
        if (connectionId.isNotBlank() && firstDomain.isNotBlank()) {
            domainsByConnection.putRecent(connectionId, firstDomain, MAX_CONNECTION_DOMAINS)
        }

        val destinations = collectXrayLogDestinationIpPorts(line)
        if (destinations.isEmpty()) return
        val domain = domainsByConnection[connectionId].orEmpty().ifBlank { firstDomain }
        if (domain.isBlank()) return
        destinations.forEach { destination ->
            domainsByIp.putRecent(destination.ip, domain, MAX_DESTINATION_DOMAINS)
        }
    }
}

internal fun xrayLogInlineHints(
    displayMessage: String,
    devicesByIp: Map<String, XrayLogDevice>,
    domainsByIp: Map<String, String>,
    showDeviceNames: Boolean,
    showDomains: Boolean,
): List<XrayLogInlineHint> {
    if ((!showDeviceNames || devicesByIp.isEmpty()) && (!showDomains || domainsByIp.isEmpty())) {
        return emptyList()
    }
    val destinations = collectXrayLogDestinationIpPorts(displayMessage)
    val destinationKeys = destinations.flatMap { destination -> listOf(destination.ip, destination.key) }.toSet()
    return buildList {
        ipv4TokenRegex.findAll(displayMessage).forEach { match ->
            val ip = normalizeXrayLogIp(match.groupValues[1])
            if (ip.isBlank()) return@forEach
            val port = match.groupValues.getOrNull(2).orEmpty().normalizeXrayLogPort()
            val tokenKey = if (port.isBlank()) ip else "$ip:$port"
            val insertAfter = match.range.last + 1

            if (showDeviceNames) {
                devicesByIp[ip]
                    ?.name
                    ?.trim()
                    ?.takeIf { it.isNotBlank() && !it.equals(ip, ignoreCase = true) }
                    ?.let { name ->
                        add(XrayLogInlineHint(insertAfter, name, XrayLogInlineHintKind.Device))
                    }
            }
            if (showDomains && (ip in destinationKeys || tokenKey in destinationKeys)) {
                domainsByIp[ip]
                    ?.let(::normalizeXrayLogDomain)
                    ?.takeIf(String::isNotBlank)
                    ?.let { domain ->
                        add(XrayLogInlineHint(insertAfter, "dns $domain", XrayLogInlineHintKind.Domain))
                    }
            }
        }
    }
}

internal fun collectXrayLogDestinationIpPorts(line: String): List<XrayLogDestination> {
    if (line.isBlank()) return emptyList()
    val seen = mutableSetOf<String>()
    return buildList {
        destinationPatterns.forEach { regex ->
            regex.findAll(line).forEach { match ->
                val ip = normalizeXrayLogIp(match.groupValues.getOrNull(1).orEmpty())
                if (ip.isBlank()) return@forEach
                val port = match.groupValues.getOrNull(2).orEmpty().normalizeXrayLogPort()
                val destination = XrayLogDestination(ip, port)
                if (seen.add(destination.key)) add(destination)
            }
        }
    }
}

internal fun collectXrayLogDomainCandidates(line: String): List<String> {
    if (line.isBlank()) return emptyList()
    val seen = mutableSetOf<String>()
    val result = mutableListOf<String>()

    sniffedDomainRegex.find(line)?.groupValues?.getOrNull(1)
        ?.let(::normalizeXrayLogDomain)
        ?.takeIf(String::isNotBlank)
        ?.let { domain ->
            if (seen.add(domain)) result += domain
        }

    // A transport endpoint is the proxy server, not the destination requested by the client.
    if (xrayOutboundEndpointDialRegex.containsMatchIn(line)) return result

    domainTargetPatterns.forEach { regex ->
        regex.findAll(line).forEach { match ->
            val domain = normalizeXrayLogDomain(match.groupValues.getOrNull(1).orEmpty())
            if (domain.isNotBlank() && seen.add(domain)) result += domain
        }
    }
    return result
}

internal fun extractXrayLogConnectionId(line: String): String =
    connectionIdRegex.find(line)?.groupValues?.getOrNull(1).orEmpty()

internal fun normalizeXrayLogIp(raw: String): String {
    val parts = raw.trim().split('.')
    if (parts.size != 4) return ""
    val normalized = parts.map { part ->
        if (part.length !in 1..3 || part.any { !it.isDigit() }) return ""
        val number = part.toIntOrNull()?.takeIf { it in 0..255 } ?: return ""
        number.toString()
    }
    if (normalized.all { it == "0" }) return ""
    return normalized.joinToString(".")
}

internal fun normalizeXrayLogDomain(raw: String): String {
    var value = raw.trim()
    if (value.isBlank()) return ""
    value = value.replace(schemePrefixRegex, "")
        .substringBefore('/')
        .substringBefore('?')
        .substringBefore('#')
        .trimEnd(')', ']', ',', ';', '\'', '"', '`', '.')
    if (value.startsWith('[') && value.endsWith(']')) return ""
    if (normalizeXrayLogIp(value).isNotBlank()) return ""
    hostPortRegex.matchEntire(value)?.let { match ->
        value = match.groupValues[1]
    }
    value = value.lowercase()
    if (value in excludedDomains || value.length > 253 || ".." in value) return ""
    val labels = value.split('.')
    if (labels.size < 2) return ""
    val tld = labels.last()
    if (!tldRegex.matches(tld)) return ""
    if (labels.any { label ->
            label.isBlank() || label.length > 63 || label.startsWith('-') || label.endsWith('-') ||
                label.any { character -> character !in 'a'..'z' && !character.isDigit() && character != '-' }
        }
    ) {
        return ""
    }
    return value
}

private fun String.normalizeXrayLogPort(): String {
    if (isBlank() || length > 5 || any { !it.isDigit() }) return ""
    return toIntOrNull()?.takeIf { it in 1..65_535 }?.toString().orEmpty()
}

private fun <K, V> LinkedHashMap<K, V>.putRecent(key: K, value: V, maxSize: Int) {
    remove(key)
    put(key, value)
    while (size > maxSize) {
        remove(keys.first())
    }
}

private val destinationPatterns = listOf(
    Regex("""\baccepted\s+(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?""", RegexOption.IGNORE_CASE),
    Regex("""\btunneling request to\s+(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?""", RegexOption.IGNORE_CASE),
    Regex("""\bprocessing from\s+(?:tcp|udp):\S+\s+to\s+(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?""", RegexOption.IGNORE_CASE),
    Regex("""\bdialing\s+(?:tcp|udp)\s+to\s+(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?""", RegexOption.IGNORE_CASE),
    Regex("""\bfor\s+\[(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?]""", RegexOption.IGNORE_CASE),
)
private val domainTargetPatterns = listOf(
    Regex("""\b(?:accepted|to|for)\s+\[(?:tcp|udp):([A-Za-z0-9.-]+\.[A-Za-z0-9-]+)(?::\d{1,5})?]""", RegexOption.IGNORE_CASE),
    Regex("""\b(?:accepted|to|for)\s+(?:tcp|udp):([A-Za-z0-9.-]+\.[A-Za-z0-9-]+)(?::\d{1,5})?""", RegexOption.IGNORE_CASE),
)
private val ipv4TokenRegex = Regex("""\b((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?\b""")
private val sniffedDomainRegex = Regex(
    """\bsniffed domain:\s*([A-Za-z0-9.-]+\.[A-Za-z0-9-]+)(?=$|[\s,]])""",
    RegexOption.IGNORE_CASE,
)
private val xrayOutboundEndpointDialRegex = Regex(
    """\btransport/internet(?:/[A-Za-z0-9_.-]+)?:\s+dialing(?:\s+(?:tcp|udp))?\s+to\s+(?:tcp|udp):""",
    RegexOption.IGNORE_CASE,
)
private val connectionIdRegex = Regex(
    """\[(?:debug|info|warning|error)]\s+\[([0-9]{3,})]""",
    RegexOption.IGNORE_CASE,
)
private val schemePrefixRegex = Regex("""^[a-z][a-z0-9+.-]*://""", RegexOption.IGNORE_CASE)
private val hostPortRegex = Regex("""^(.+):(\d{1,5})$""")
private val tldRegex = Regex("""^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$""")
private val excludedDomains = setOf("access.log", "error.log", "localhost")
