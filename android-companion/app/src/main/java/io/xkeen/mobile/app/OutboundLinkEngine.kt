package io.xkeen.mobile.app

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Base64
import org.json.JSONObject

internal fun previewOutboundLink(raw: String): OutboundLinkPreview {
    val value = raw.trim()
    if (value.isBlank()) return OutboundLinkPreview()
    val scheme = value.substringBefore("://", "").lowercase()
    return when (scheme) {
        "vless", "trojan" -> previewVlessOrTrojan(value, scheme)
        "vmess" -> previewVmess(value)
        "ss" -> previewShadowsocks(value)
        "hy2", "hysteria2", "hysteria" -> previewHysteria(value)
        else -> OutboundLinkPreview(
            scheme = scheme,
            errors = listOf("Поддерживаются vless://, trojan://, vmess://, ss:// и hy2://."),
        )
    }
}

internal fun normalizeOutboundLink(raw: String): String? {
    val value = raw.trim()
    return when (value.substringBefore("://", "").lowercase()) {
        "vless", "trojan" -> normalizeVlessOrTrojan(value)
        "vmess" -> normalizeVmess(value)
        "ss" -> normalizeShadowsocks(value)
        "hy2", "hysteria2", "hysteria" -> value.takeIf(String::isNotBlank)
        else -> null
    }
}

internal fun cleanOutboundTag(value: String): String {
    val normalized = value.trim()
        .replace(Regex("\\s+"), "_")
        .replace(Regex("[^A-Za-z0-9_.:-]+"), "_")
        .trim('_', '.', ':', '-')
        .take(64)
        .trim('_', '.', ':', '-')
    return normalized.ifBlank { "proxy" }
}

private fun previewVlessOrTrojan(value: String, scheme: String): OutboundLinkPreview {
    val uri = value.toProxyUri() ?: return invalidPreview(scheme, "Ссылка не похожа на корректный URL.")
    val query = uri.rawQuery.parseProxyQuery()
    val user = uri.rawUserInfo.orEmpty().substringBefore(':').decodedPercentComponent()
    val host = uri.host.orEmpty()
    val port = uri.port.takeIf { it > 0 }?.toString().orEmpty()
    val transport = (query.firstValue("type", "net") ?: "tcp").lowercase()
    val security = (query.firstValue("security") ?: if (scheme == "trojan") "tls" else "reality").lowercase()
    val sni = query.firstValue("sni", "serverName").orEmpty()
    val publicKey = query.firstValue("pbk", "publicKey").orEmpty()
    val shortId = query.firstValue("sid", "shortId").orEmpty()
    val path = query.firstValue("path").orEmpty()
    val serviceName = query.firstValue("serviceName").orEmpty()
    val errors = buildList {
        if (host.isBlank()) add("Не указан сервер.")
        if (!port.isValidProxyPort()) add("Не указан корректный порт.")
        if (user.isBlank()) add(if (scheme == "vless") "Не указан UUID." else "Не указан пароль.")
        if (security == "reality" && publicKey.isBlank()) add("Reality: отсутствует public key (pbk).")
    }
    val warnings = buildList {
        if (scheme == "vless" && user.isNotBlank() && !user.looksLikeUuid()) add("UUID имеет необычный формат.")
        if (security == "reality" && shortId.isBlank()) add("Для Reality рекомендуется short id (sid).")
        if (security == "reality" && sni.isBlank()) add("Для Reality рекомендуется SNI.")
        if (transport in setOf("ws", "httpupgrade") && path.isBlank()) add("Для $transport обычно требуется path.")
        if (transport == "grpc" && serviceName.isBlank()) add("Для gRPC обычно требуется serviceName.")
    }
    return OutboundLinkPreview(
        isValid = errors.isEmpty(),
        scheme = scheme,
        transport = transport,
        security = security,
        fields = previewFields(
            "Название" to uri.rawFragment.decodedPercentComponent(),
            "Сервер" to host,
            "Порт" to port,
            (if (scheme == "vless") "UUID" else "Пароль") to user.maskProxySecret(),
            "SNI" to sni,
            "Public key" to publicKey.maskProxySecret(),
            "Short ID" to shortId.maskProxySecret(),
            "Path" to path,
            "Service" to serviceName,
        ),
        errors = errors,
        warnings = warnings,
    )
}

private fun previewVmess(value: String): OutboundLinkPreview {
    val encoded = value.substringAfter("vmess://", "")
    val decoded = encoded.decodeProxyBase64()
        ?: return invalidPreview("vmess", "Не удалось декодировать vmess base64.")
    val payload = try {
        JSONObject(decoded)
    } catch (_: Exception) {
        return invalidPreview("vmess", "vmess payload не содержит корректный JSON.")
    }
    val host = payload.optString("add").trim()
    val port = payload.opt("port")?.toString()?.trim().orEmpty()
    val uuid = payload.optString("id").trim()
    val transport = payload.optString("net", "tcp").trim().lowercase().ifBlank { "tcp" }
    val security = if (payload.optString("tls").equals("tls", true)) "tls" else "none"
    val errors = buildList {
        if (host.isBlank()) add("vmess: отсутствует сервер (add).")
        if (!port.isValidProxyPort()) add("vmess: некорректный порт.")
        if (uuid.isBlank()) add("vmess: отсутствует UUID.")
    }
    val warnings = buildList {
        if (uuid.isNotBlank() && !uuid.looksLikeUuid()) add("UUID имеет необычный формат.")
    }
    return OutboundLinkPreview(
        isValid = errors.isEmpty(),
        scheme = "vmess",
        transport = transport,
        security = security,
        fields = previewFields(
            "Название" to payload.optString("ps").trim(),
            "Сервер" to host,
            "Порт" to port,
            "UUID" to uuid.maskProxySecret(),
            "SNI / Host" to payload.optString("sni", payload.optString("host")).trim(),
            "Path" to payload.optString("path").trim(),
        ),
        errors = errors,
        warnings = warnings,
    )
}

private fun previewShadowsocks(value: String): OutboundLinkPreview {
    val parsed = parseShadowsocks(value)
        ?: return invalidPreview("ss", "Не удалось распознать формат ss://.")
    val errors = buildList {
        if (parsed.method.isBlank()) add("Не указан cipher.")
        if (parsed.password.isBlank()) add("Не указан пароль.")
        if (parsed.host.isBlank()) add("Не указан сервер.")
        if (!parsed.port.isValidProxyPort()) add("Не указан корректный порт.")
    }
    return OutboundLinkPreview(
        isValid = errors.isEmpty(),
        scheme = "ss",
        transport = "tcp",
        security = "none",
        fields = previewFields(
            "Название" to parsed.tag,
            "Сервер" to parsed.host,
            "Порт" to parsed.port,
            "Cipher" to parsed.method,
            "Plugin" to parsed.plugin,
        ),
        errors = errors,
    )
}

private fun previewHysteria(value: String): OutboundLinkPreview {
    val uri = value.toProxyUri() ?: return invalidPreview("hy2", "Ссылка не похожа на корректный URL.")
    val query = uri.rawQuery.parseProxyQuery()
    val auth = uri.rawUserInfo.decodedPercentComponent()
    val host = uri.host.orEmpty()
    val port = uri.port.takeIf { it > 0 }?.toString().orEmpty()
    val obfs = query.firstValue("obfs").orEmpty()
    val errors = buildList {
        if (host.isBlank()) add("Не указан сервер.")
        if (port.isNotBlank() && !port.isValidProxyPort()) add("Некорректный порт.")
        if (auth.isBlank()) add("Не указан auth.")
    }
    val warnings = buildList {
        if (obfs.isNotBlank() && !obfs.equals("salamander", true)) {
            add("Этот obfs может не поддерживаться ядром Xray.")
        }
    }
    return OutboundLinkPreview(
        isValid = errors.isEmpty(),
        scheme = "hy2",
        transport = "udp",
        security = "tls",
        fields = previewFields(
            "Название" to uri.rawFragment.decodedPercentComponent(),
            "Сервер" to host,
            "Порт" to port.ifBlank { "443" },
            "Auth" to auth.maskProxySecret(),
            "SNI" to query.firstValue("sni").orEmpty(),
            "Obfs" to obfs,
        ),
        errors = errors,
        warnings = warnings,
    )
}

private fun normalizeVlessOrTrojan(value: String): String? {
    val uri = value.toProxyUri() ?: return null
    val scheme = uri.scheme?.lowercase()?.takeIf { it == "vless" || it == "trojan" } ?: return null
    val host = uri.host.orEmpty().takeIf(String::isNotBlank) ?: return null
    val userInfo = uri.rawUserInfo.orEmpty().takeIf(String::isNotBlank) ?: return null
    val query = uri.rawQuery.parseProxyQuery().toMutableList()

    query.useCanonicalAlias("pbk", "publicKey")
    query.useCanonicalAlias("sid", "shortId")
    query.useCanonicalAlias("sni", "serverName")
    query.useCanonicalAlias("type", "net")

    val transport = query.firstValue("type")?.lowercase().orEmpty().ifBlank { "tcp" }
    val security = query.firstValue("security")?.lowercase().orEmpty()
        .ifBlank { if (scheme == "trojan") "tls" else "reality" }
    query.removeAll { it.first in setOf("type", "security") }
    if (transport != "tcp") query += "type" to transport
    if (security != "none") query += "security" to security
    if (transport in setOf("ws", "httpupgrade")) {
        val path = query.firstValue("path").orEmpty().normalizeProxyPath()
        query.removeAll { it.first == "path" }
        query += "path" to path
    }
    query.removeAll { it.second.isBlank() }
    val sorted = query.sortedWith(proxyQueryComparator)
    val port = uri.port.takeIf { it > 0 } ?: 443
    val authorityHost = if (':' in host && !host.startsWith("[")) "[$host]" else host
    val suffix = sorted.toEncodedProxyQuery().takeIf(String::isNotBlank)?.let { "?$it" }.orEmpty()
    val fragment = uri.rawFragment.decodedPercentComponent().takeIf(String::isNotBlank)
        ?.let { "#${it.encodedUrlComponent()}" }
        .orEmpty()
    return "$scheme://$userInfo@$authorityHost:$port$suffix$fragment"
}

private fun normalizeVmess(value: String): String? {
    val decoded = value.substringAfter("vmess://", "").decodeProxyBase64() ?: return null
    val payload = try {
        JSONObject(decoded)
    } catch (_: Exception) {
        return null
    }
    if (!payload.has("v") || payload.optString("v").isBlank()) payload.put("v", "2")
    if (!payload.has("aid") || payload.optString("aid").isBlank()) payload.put("aid", "0")
    if (!payload.has("port") || payload.optString("port").isBlank()) payload.put("port", "443")
    val transport = payload.optString("net", "tcp").lowercase().ifBlank { "tcp" }
    payload.put("net", transport)
    if (transport in setOf("ws", "httpupgrade")) {
        payload.put("path", payload.optString("path").normalizeProxyPath())
    }
    if (payload.optString("tls").equals("tls", true) && payload.optString("sni").isBlank()) {
        payload.optString("host").takeIf(String::isNotBlank)?.let { payload.put("sni", it) }
    }
    val encoded = Base64.getEncoder().encodeToString(payload.toString().toByteArray(StandardCharsets.UTF_8))
    return "vmess://$encoded"
}

private fun normalizeShadowsocks(value: String): String? {
    val parsed = parseShadowsocks(value) ?: return null
    if (parsed.method.isBlank() || parsed.password.isBlank() || parsed.host.isBlank() || !parsed.port.isValidProxyPort()) {
        return null
    }
    val credentials = Base64.getEncoder().encodeToString(
        "${parsed.method}:${parsed.password}".toByteArray(StandardCharsets.UTF_8),
    )
    val host = if (':' in parsed.host && !parsed.host.startsWith("[")) "[${parsed.host}]" else parsed.host
    val plugin = parsed.plugin.takeIf(String::isNotBlank)?.let { "?plugin=${it.encodedUrlComponent()}" }.orEmpty()
    val tag = parsed.tag.takeIf(String::isNotBlank)?.let { "#${it.encodedUrlComponent()}" }.orEmpty()
    return "ss://$credentials@$host:${parsed.port}$plugin$tag"
}

private data class ShadowsocksParts(
    val method: String,
    val password: String,
    val host: String,
    val port: String,
    val plugin: String,
    val tag: String,
)

private fun parseShadowsocks(value: String): ShadowsocksParts? {
    if (!value.startsWith("ss://", true)) return null
    var body = value.substring(5).trim()
    val hashIndex = body.indexOf('#')
    val tag = if (hashIndex >= 0) body.substring(hashIndex + 1).decodedPercentComponent() else ""
    if (hashIndex >= 0) body = body.substring(0, hashIndex)
    val queryIndex = body.indexOf('?')
    val query = if (queryIndex >= 0) body.substring(queryIndex + 1) else ""
    if (queryIndex >= 0) body = body.substring(0, queryIndex)
    val plugin = query.parseProxyQuery().firstValue("plugin").orEmpty()

    if ('@' !in body) body = body.decodeProxyBase64() ?: return null
    if ('@' !in body) return null
    var credentials = body.substringBeforeLast('@')
    val hostPort = body.substringAfterLast('@')
    if (':' !in credentials) credentials = credentials.decodeProxyBase64() ?: credentials
    credentials = credentials.decodedPercentComponent()
    val method = credentials.substringBefore(':', "")
    val password = credentials.substringAfter(':', "")
    val host: String
    val port: String
    if (hostPort.startsWith("[")) {
        val match = Regex("^\\[([^]]+)]:(\\d+)$").matchEntire(hostPort) ?: return null
        host = match.groupValues[1]
        port = match.groupValues[2]
    } else {
        val separator = hostPort.lastIndexOf(':')
        if (separator <= 0) return null
        host = hostPort.substring(0, separator)
        port = hostPort.substring(separator + 1)
    }
    return ShadowsocksParts(method, password, host, port, plugin, tag)
}

private fun String.toProxyUri(): URI? = try {
    val hashIndex = indexOf('#')
    val source = if (hashIndex >= 0) substring(0, hashIndex) else this
    val fragment = if (hashIndex >= 0) substring(hashIndex + 1).decodedPercentComponent().encodedUrlComponent() else ""
    URI(source + if (hashIndex >= 0) "#$fragment" else "")
} catch (_: Exception) {
    null
}

private fun String?.parseProxyQuery(): List<Pair<String, String>> {
    if (this.isNullOrBlank()) return emptyList()
    return split('&').mapNotNull { item ->
        val key = item.substringBefore('=').decodedUrlComponent()
        if (key.isBlank()) null else key to item.substringAfter('=', "").decodedUrlComponent()
    }
}

private fun List<Pair<String, String>>.firstValue(vararg keys: String): String? =
    keys.firstNotNullOfOrNull { key -> firstOrNull { it.first == key }?.second }

private fun MutableList<Pair<String, String>>.useCanonicalAlias(canonical: String, alias: String) {
    val existing = firstValue(canonical)
    val aliasValue = firstValue(alias)
    removeAll { it.first == alias }
    if (existing.isNullOrBlank() && !aliasValue.isNullOrBlank()) add(canonical to aliasValue)
}

private val proxyQueryOrder = listOf(
    "type", "security", "encryption", "flow", "sni", "fp", "alpn", "pbk", "sid", "spx", "pqv",
    "path", "host", "serviceName", "authority", "mode", "allowInsecure", "insecure",
)

private val proxyQueryComparator = compareBy<Pair<String, String>>(
    { proxyQueryOrder.indexOf(it.first).takeIf { index -> index >= 0 } ?: Int.MAX_VALUE },
    { it.first },
    { it.second },
)

private fun List<Pair<String, String>>.toEncodedProxyQuery(): String =
    joinToString("&") { (key, value) -> "${key.encodedUrlComponent()}=${value.encodedUrlComponent()}" }

private fun String.encodedUrlComponent(): String =
    URLEncoder.encode(this, StandardCharsets.UTF_8.name()).replace("+", "%20")

private fun String?.decodedUrlComponent(): String = try {
    URLDecoder.decode(this.orEmpty(), StandardCharsets.UTF_8.name())
} catch (_: Exception) {
    this.orEmpty()
}

private fun String?.decodedPercentComponent(): String = try {
    URLDecoder.decode(this.orEmpty().replace("+", "%2B"), StandardCharsets.UTF_8.name())
} catch (_: Exception) {
    this.orEmpty()
}

private fun String.decodeProxyBase64(): String? {
    val compact = trim().substringBefore('#').replace('-', '+').replace('_', '/')
    val padded = compact + "=".repeat((4 - compact.length % 4) % 4)
    return try {
        String(Base64.getDecoder().decode(padded), StandardCharsets.UTF_8)
    } catch (_: Exception) {
        null
    }
}

private fun String.isValidProxyPort(): Boolean = toIntOrNull() in 1..65535

private fun String.looksLikeUuid(): Boolean =
    matches(Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"))

private fun String.normalizeProxyPath(): String = trim().let { path ->
    when {
        path.isBlank() -> "/"
        path.startsWith('/') -> path
        else -> "/$path"
    }
}

private fun String.maskProxySecret(): String = when {
    isBlank() -> ""
    length <= 8 -> "••••••"
    else -> "${take(4)}••••${takeLast(4)}"
}

private fun previewFields(vararg fields: Pair<String, String>): List<OutboundPreviewField> =
    fields.filter { it.second.isNotBlank() }.map { OutboundPreviewField(it.first, it.second) }

private fun invalidPreview(scheme: String, message: String) = OutboundLinkPreview(
    scheme = scheme,
    errors = listOf(message),
)
