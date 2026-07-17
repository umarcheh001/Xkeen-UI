package io.xkeen.mobile.app

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

private val reservedOutboundPoolTags = setOf(
    "direct",
    "block",
    "dns",
    "freedom",
    "blackhole",
    "reject",
    "bypass",
    "api",
    "xray-api",
    "metrics",
)

internal data class OutboundPoolParseResult(
    val entries: List<OutboundPoolEntryDraft>,
    val addedCount: Int,
)

internal fun isReservedOutboundPoolTag(tag: String): Boolean =
    tag.trim().lowercase() in reservedOutboundPoolTags

internal fun sanitizeOutboundPoolTag(value: String): String = value.trim()
    .replace(Regex("\\s+"), "_")
    .replace(Regex("[^A-Za-z0-9_.:-]+"), "_")
    .trim('_', '.', ':', '-')
    .take(64)
    .trim('_', '.', ':', '-')

internal fun mergeOutboundPoolInput(
    current: List<OutboundPoolEntryDraft>,
    input: String,
): OutboundPoolParseResult {
    val merged = current.toMutableList()
    var added = 0
    input.lineSequence()
        .map(String::trim)
        .filter(String::isNotBlank)
        .forEachIndexed { index, line ->
            val parsed = splitOutboundPoolLine(line)
            if (parsed.url.isBlank()) return@forEachIndexed

            val normalizedUrl = normalizeOutboundLink(parsed.url) ?: parsed.url.trim()
            val preview = previewOutboundLink(normalizedUrl)
            var tag = sanitizeOutboundPoolTag(parsed.tag)
            if (tag.isBlank()) tag = suggestOutboundPoolTag(normalizedUrl, preview, index + 1)

            val sameTagIndex = if (parsed.explicitTag) {
                merged.indexOfFirst { it.tag.equals(tag, ignoreCase = true) }
            } else {
                -1
            }
            if (sameTagIndex >= 0 && !isReservedOutboundPoolTag(tag)) {
                merged[sameTagIndex] = OutboundPoolEntryDraft(tag, normalizedUrl, preview)
                added += 1
                return@forEachIndexed
            }

            tag = uniqueOutboundPoolTag(tag, merged.mapTo(mutableSetOf()) { it.tag.lowercase() })
            merged += OutboundPoolEntryDraft(tag, normalizedUrl, preview)
            added += 1
        }
    return OutboundPoolParseResult(entries = merged, addedCount = added)
}

private data class ParsedOutboundPoolLine(
    val tag: String,
    val url: String,
    val explicitTag: Boolean,
)

private fun splitOutboundPoolLine(line: String): ParsedOutboundPoolLine {
    val pipeIndex = line.indexOf('|')
    val equalsIndex = line.indexOf('=')
    val schemeIndex = line.indexOf("://")
    return when {
        pipeIndex > 0 && (schemeIndex == -1 || pipeIndex < schemeIndex) -> ParsedOutboundPoolLine(
            tag = line.substring(0, pipeIndex).trim(),
            url = line.substring(pipeIndex + 1).trim(),
            explicitTag = true,
        )
        equalsIndex > 0 && (schemeIndex == -1 || equalsIndex < schemeIndex) &&
            line.substring(equalsIndex + 1).contains("://") -> ParsedOutboundPoolLine(
            tag = line.substring(0, equalsIndex).trim(),
            url = line.substring(equalsIndex + 1).trim(),
            explicitTag = true,
        )
        else -> ParsedOutboundPoolLine(tag = "", url = line, explicitTag = false)
    }
}

private fun suggestOutboundPoolTag(
    url: String,
    preview: OutboundLinkPreview,
    fallbackIndex: Int,
): String {
    val previewName = preview.fields.firstOrNull { it.label == "Название" }?.value.orEmpty()
    sanitizeOutboundPoolTag(previewName).takeIf(String::isNotBlank)?.let { return it }

    val fragment = url.substringAfter('#', "").decodePoolComponent()
    sanitizeOutboundPoolTag(fragment).takeIf(String::isNotBlank)?.let { return it }

    val previewHost = preview.fields.firstOrNull { it.label == "Сервер" }?.value.orEmpty()
    val previewPort = preview.fields.firstOrNull { it.label == "Порт" }?.value.orEmpty()
    val previewEndpoint = previewHost + previewPort.takeIf(String::isNotBlank)?.let { "_$it" }.orEmpty()
    sanitizeOutboundPoolTag(previewEndpoint).takeIf(String::isNotBlank)?.let { return it }

    try {
        val uri = URI(url.substringBefore('#'))
        val endpoint = uri.host.orEmpty() + uri.port.takeIf { it > 0 }?.let { "_$it" }.orEmpty()
        sanitizeOutboundPoolTag(endpoint).takeIf(String::isNotBlank)?.let { return it }
    } catch (_: Exception) {
        // The preview below will explain an invalid URL; a stable fallback tag still keeps the row editable.
    }
    return "p$fallbackIndex"
}

private fun uniqueOutboundPoolTag(baseValue: String, usedLowercase: Set<String>): String {
    val base = sanitizeOutboundPoolTag(baseValue).ifBlank { "proxy" }
    var candidate = base
    var suffix = 2
    while (candidate.lowercase() in usedLowercase || isReservedOutboundPoolTag(candidate)) {
        val ending = "-${suffix++}"
        candidate = base.take(64 - ending.length).trimEnd('_', '.', ':', '-') + ending
    }
    return candidate
}

private fun String.decodePoolComponent(): String = try {
    URLDecoder.decode(replace("+", "%2B"), StandardCharsets.UTF_8.name())
} catch (_: Exception) {
    this
}
