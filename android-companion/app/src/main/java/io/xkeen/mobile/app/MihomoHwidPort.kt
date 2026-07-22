package io.xkeen.mobile.app

import java.net.URLEncoder
import org.json.JSONArray
import org.json.JSONObject

data class MihomoHwidDeviceInfo(
    val hwid: String,
    val source: String,
    val format: String,
    val mac: String,
    val macHwid: String,
    val hasManualOverride: Boolean,
    val matchesRouterMac: Boolean,
    val overrideDiffersFromRouter: Boolean,
    val deviceModel: String,
    val osRelease: String,
    val mihomoVersion: String,
    val userAgent: String,
    val headers: Map<String, String>,
    val warning: String?,
)

data class MihomoHwidProbeResult(
    val profileTitle: String?,
    val suggestedName: String?,
    val httpStatus: Int?,
    val method: String?,
    val timingMillis: Int?,
    val resolvedUrl: String?,
    val headersUsed: Map<String, String>,
    val responseHeaders: Map<String, String>,
    val deviceLimitSummary: String?,
    val nodeCount: Int?,
    val hasNodes: Boolean?,
    val regularProviderHasNodes: Boolean?,
    val placeholderReason: String?,
    val providerAcceptedHwid: String?,
    val warnings: List<String>,
    val noHeadersRequired: Boolean,
)

internal data class MihomoHwidApplyResult(
    val providerName: String,
    val activeProfile: String,
    val restartQueued: Boolean,
    val restartJobId: String?,
)

internal interface MihomoHwidPort {
    suspend fun loadDevice(baseUrl: String): MihomoHwidDeviceInfo

    suspend fun probe(baseUrl: String, url: String, insecure: Boolean): MihomoHwidProbeResult

    suspend fun applyAndRestart(
        baseUrl: String,
        url: String,
        providerName: String,
        insecure: Boolean,
    ): MihomoHwidApplyResult
}

internal class WebPanelMihomoHwidPort(
    private val transport: CompanionHttpTransport,
) : MihomoHwidPort {
    override suspend fun loadDevice(baseUrl: String): MihomoHwidDeviceInfo {
        val response = transport.get(
            CompanionHttpRequest(baseUrl = baseUrl, endpoint = "/api/mihomo/hwid/device"),
        )
        val root = response.requireMihomoHwidJson("Xkeen UI вернул некорректные данные HWID устройства.")
        root.requireMihomoHwidSuccess("Xkeen UI не подтвердил данные HWID устройства.")
        return MihomoHwidDeviceInfo(
            hwid = root.optString("hwid").trim(),
            source = root.optString("hwid_source").trim(),
            format = root.optString("hwid_format").trim(),
            mac = root.optString("mac").trim(),
            macHwid = root.optString("mac_hwid").trim(),
            hasManualOverride = root.optBoolean("has_env_override", false),
            matchesRouterMac = root.optBoolean("hwid_matches_router_mac", false),
            overrideDiffersFromRouter = root.optBoolean("override_differs_from_router", false),
            deviceModel = root.optString("device_model").trim(),
            osRelease = root.optString("os_release").trim(),
            mihomoVersion = root.optString("mihomo_version").trim(),
            userAgent = root.optString("user_agent").trim(),
            headers = root.optJSONObject("headers").toMihomoStringMap(),
            warning = root.optString("hwid_warning").trim().ifBlank { null },
        )
    }

    override suspend fun probe(
        baseUrl: String,
        url: String,
        insecure: Boolean,
    ): MihomoHwidProbeResult {
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/mihomo/hwid/probe",
                body = JSONObject()
                    .put("url", url.trim())
                    .put("insecure", insecure)
                    .toString(),
            ),
        )
        val root = response.requireMihomoHwidJson("Xkeen UI вернул некорректный результат проверки HWID-подписки.")
        root.requireMihomoHwidSuccess("Xkeen UI не подтвердил HWID-подписку.")
        val profile = root.optJSONObject("profile") ?: JSONObject()
        val probe = root.optJSONObject("probe") ?: JSONObject()
        val limit = root.optJSONObject("hwid_limit_info")
        val provider = root.optJSONObject("provider_payload")
        val regularProvider = root.optJSONObject("regular_provider_payload")
        val accepted = root.optString("provider_hwid").trim().ifBlank {
            root.optJSONObject("provider_hwid_diagnostics")
                ?.optString("accepted_value")
                ?.trim()
                .orEmpty()
        }
        return MihomoHwidProbeResult(
            profileTitle = profile.optString("profile_title").trim().ifBlank { null },
            suggestedName = profile.optString("suggested_name").trim().ifBlank { null },
            httpStatus = probe.optNullableInt("http_status"),
            method = probe.optString("method").trim().ifBlank { null },
            timingMillis = probe.optNullableInt("timing_ms"),
            resolvedUrl = probe.optString("resolved_url").trim().ifBlank { null },
            headersUsed = root.optJSONObject("headers_used").toMihomoStringMap(),
            responseHeaders = root.optJSONObject("hwid_response_headers").toMihomoStringMap(),
            deviceLimitSummary = limit?.optString("summary")?.trim()?.ifBlank { null }
                ?: limit?.deviceLimitFraction(),
            nodeCount = provider?.optNullableInt("node_count"),
            hasNodes = provider?.optNullableBoolean("has_nodes"),
            regularProviderHasNodes = regularProvider?.optNullableBoolean("has_nodes"),
            placeholderReason = provider?.optString("hwid_placeholder_reason")?.trim()?.ifBlank { null },
            providerAcceptedHwid = accepted.ifBlank { null },
            warnings = root.optJSONArray("warnings").toMihomoWarnings(),
            noHeadersRequired = root.optBoolean("no_headers_ok", false),
        )
    }

    override suspend fun applyAndRestart(
        baseUrl: String,
        url: String,
        providerName: String,
        insecure: Boolean,
    ): MihomoHwidApplyResult {
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/mihomo/hwid/apply",
                body = JSONObject()
                    .put("url", url.trim())
                    .put("insecure", insecure)
                    .put("mode", "add")
                    .put("name", providerName.trim())
                    .put("restart", true)
                    .toString(),
            ),
        )
        val root = response.requireMihomoHwidJson("Xkeen UI вернул некорректный результат применения HWID-подписки.")
        root.requireMihomoHwidSuccess("Xkeen UI не подтвердил применение HWID-подписки.")
        return MihomoHwidApplyResult(
            providerName = root.optString("provider_name").trim().ifBlank { providerName.trim() },
            activeProfile = root.optString("active_profile").trim().ifBlank { "config.yaml" },
            restartQueued = root.optBoolean("restart_queued", false),
            restartJobId = root.optString("restart_job_id").trim().ifBlank { null },
        )
    }
}

internal class DemoMihomoHwidPort : MihomoHwidPort {
    override suspend fun loadDevice(baseUrl: String): MihomoHwidDeviceInfo = MihomoHwidDeviceInfo(
        hwid = "A1B2C3D4E5F6",
        source = "mac",
        format = "mac12",
        mac = "a1:b2:c3:d4:e5:f6",
        macHwid = "A1B2C3D4E5F6",
        hasManualOverride = false,
        matchesRouterMac = true,
        overrideDiffersFromRouter = false,
        deviceModel = "Keenetic",
        osRelease = "4.3",
        mihomoVersion = "1.19.25",
        userAgent = "ClashMeta/1.19.25; mihomo/1.19.25",
        headers = mapOf("x-hwid" to "A1B2C3D4E5F6"),
        warning = null,
    )

    override suspend fun probe(baseUrl: String, url: String, insecure: Boolean): MihomoHwidProbeResult =
        MihomoHwidProbeResult(
            profileTitle = "Mobile Premium",
            suggestedName = "Mobile_Premium",
            httpStatus = 200,
            method = "HEAD",
            timingMillis = 86,
            resolvedUrl = url,
            headersUsed = mapOf("x-hwid" to "A1B2C3D4E5F6"),
            responseHeaders = mapOf("x-hwid-active" to "true"),
            deviceLimitSummary = "1/3",
            nodeCount = 12,
            hasNodes = true,
            regularProviderHasNodes = null,
            placeholderReason = null,
            providerAcceptedHwid = null,
            warnings = emptyList(),
            noHeadersRequired = false,
        )

    override suspend fun applyAndRestart(
        baseUrl: String,
        url: String,
        providerName: String,
        insecure: Boolean,
    ): MihomoHwidApplyResult = MihomoHwidApplyResult(
        providerName = sanitizeMihomoHwidProviderName(providerName),
        activeProfile = "config.yaml",
        restartQueued = true,
        restartJobId = "demo-hwid-restart",
    )
}

internal class MihomoHwidException(message: String, cause: Throwable? = null) : Exception(message, cause)

internal data class MihomoHwidDraftPatch(
    val content: String,
    val start: Int,
    val end: Int,
)

internal fun sanitizeMihomoHwidProviderName(value: String): String = value
    .trim()
    .replace(Regex("\\s+"), "_")
    .replace(Regex("[^A-Za-z0-9._-]+"), "_")
    .replace(Regex("_+"), "_")
    .trim('.', '_', '-')
    .take(64)

internal fun buildMihomoHwidProviderSnippet(
    baseUrl: String,
    providerName: String,
    subscriptionUrl: String,
    insecure: Boolean,
): String {
    val name = sanitizeMihomoHwidProviderName(providerName)
    if (name.isBlank()) return ""
    val base = normalizeCompanionBaseUrl(baseUrl)
    val port = base.port.takeIf { it >= 0 } ?: if (base.scheme.equals("https", true)) 443 else 80
    val encodedUrl = URLEncoder.encode(subscriptionUrl.trim(), "UTF-8")
    val adapterUrl = "http://127.0.0.1:$port/mihomo/hwid/provider.yaml?url=$encodedUrl&insecure=${if (insecure) 1 else 0}"
    return buildString {
        appendLine("  $name:")
        appendLine("    type: http")
        appendLine("    url: ${adapterUrl.yamlQuoted()}")
        appendLine("    interval: 43200")
        appendLine("    path: ${"./proxy_providers/$name.yaml".yamlQuoted()}")
        appendLine("    health-check:")
        appendLine("      enable: true")
        appendLine("      url: \"https://www.gstatic.com/generate_204\"")
        appendLine("      interval: 300")
        appendLine("      expected-status: 204")
        appendLine("    override:")
        appendLine("      udp: true")
        appendLine("      tfo: true")
    }
}

internal fun insertMihomoHwidProvider(
    content: String,
    providerName: String,
    snippet: String,
): MihomoHwidDraftPatch {
    val name = sanitizeMihomoHwidProviderName(providerName)
    if (name.isBlank() || snippet.isBlank()) throw MihomoHwidException("Укажите имя provider.")
    if (Regex("(?m)^  ${Regex.escape(name)}\\s*:").containsMatchIn(content)) {
        throw MihomoHwidException("Provider '$name' уже есть в config.yaml. Выберите другое имя.")
    }

    var source = content.replace("\r\n", "\n").replace('\r', '\n').trimEnd() + "\n"
    val sectionHeader = Regex("(?m)^proxy-providers\\s*:\\s*(.*)$")
    var match = sectionHeader.find(source)
    if (match == null) {
        val prefix = source.trimEnd().let { existing ->
            if (existing.isBlank()) "proxy-providers:\n" else "$existing\n\nproxy-providers:\n"
        }
        val start = prefix.length
        val next = prefix + snippet.trimEnd() + "\n"
        return MihomoHwidDraftPatch(next, start, next.length)
    }

    val tail = match.groupValues[1].trim()
    val inlineValue = tail.substringBefore('#').trim()
    if (inlineValue in setOf("[]", "{}", "null", "~")) {
        val comment = tail.substringAfter('#', "").trim().takeIf(String::isNotBlank)?.let { " #$it" }.orEmpty()
        source = source.replaceRange(match.range, "proxy-providers:$comment")
        match = sectionHeader.find(source) ?: throw MihomoHwidException("Не удалось подготовить proxy-providers.")
    }

    val lineEnd = source.indexOf('\n', match.range.first).let { if (it < 0) source.length else it + 1 }
    val nextSection = Regex("(?m)^(?!\\s)(?!#)[A-Za-z0-9_.-]+\\s*:").find(source, lineEnd)
    val bodyEnd = nextSection?.range?.first ?: source.length
    var before = source.substring(0, bodyEnd)
    if (!before.endsWith('\n')) before += "\n"
    val inserted = snippet.trimEnd() + "\n"
    val start = before.length
    val next = before + inserted + source.substring(bodyEnd)
    return MihomoHwidDraftPatch(next, start, start + inserted.length)
}

private fun String.yamlQuoted(): String = buildString {
    append('"')
    this@yamlQuoted.forEach { char ->
        when (char) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            else -> append(char)
        }
    }
    append('"')
}

private fun CompanionHttpResponse.requireMihomoHwidJson(message: String): JSONObject = try {
    JSONObject(body)
} catch (error: Exception) {
    throw MihomoHwidException(message, error)
}

private fun JSONObject.requireMihomoHwidSuccess(fallback: String) {
    if (optBoolean("ok", false)) return
    val errorObject = optJSONObject("error") ?: optJSONObject("probe")?.optJSONObject("error")
    val message = errorObject?.optString("message")?.trim().orEmpty()
    val hint = errorObject?.optString("hint")?.trim().orEmpty()
    throw MihomoHwidException(listOf(message, hint).filter(String::isNotBlank).joinToString(" ").ifBlank { fallback })
}

private fun JSONObject?.toMihomoStringMap(): Map<String, String> {
    if (this == null) return emptyMap()
    return buildMap {
        keys().forEach { key ->
            optString(key).trim().takeIf(String::isNotBlank)?.let { value -> put(key, value) }
        }
    }
}

private fun JSONArray?.toMihomoWarnings(): List<String> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) {
            when (val item = opt(index)) {
                is JSONObject -> item.optString("hint").trim().takeIf(String::isNotBlank)?.let(::add)
                is String -> item.trim().takeIf(String::isNotBlank)?.let(::add)
            }
        }
    }
}

private fun JSONObject.optNullableInt(key: String): Int? =
    takeIf { has(key) && !isNull(key) }?.optInt(key)

private fun JSONObject.optNullableBoolean(key: String): Boolean? =
    takeIf { has(key) && !isNull(key) }?.optBoolean(key)

private fun JSONObject.deviceLimitFraction(): String? {
    val used = optNullableInt("used") ?: return null
    val limit = optNullableInt("limit") ?: return null
    return "$used/$limit"
}
