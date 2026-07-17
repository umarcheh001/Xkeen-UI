package io.xkeen.mobile.app

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import org.json.JSONObject

enum class XrayDatKind(
    val apiValue: String,
    val displayName: String,
) {
    GeoSite("geosite", "GeoSite"),
    GeoIp("geoip", "GeoIP"),
}

data class XrayDatFile(
    val kind: XrayDatKind,
    val name: String,
    val path: String,
    val sizeBytes: Long? = null,
    val modifiedAtEpochSeconds: Long? = null,
)

data class XrayDatTag(
    val name: String,
    val count: Int? = null,
)

data class XrayDatItem(
    val type: String,
    val value: String,
)

internal data class XrayDatCatalog(
    val files: List<XrayDatFile>,
    val geodatInstalled: Boolean?,
    val geodatMessage: String? = null,
)

internal data class XrayDatTagsSnapshot(
    val file: XrayDatFile,
    val tags: List<XrayDatTag>,
)

internal data class XrayDatItemsPage(
    val file: XrayDatFile,
    val tag: String,
    val items: List<XrayDatItem>,
    val offset: Int,
    val limit: Int,
    val total: Int? = null,
)

internal data class XrayDatSearchPage(
    val file: XrayDatFile,
    val tag: String,
    val query: String,
    val items: List<XrayDatItem>,
    val cursor: Int,
    val nextCursor: Int?,
    val viewed: Int,
    val total: Int? = null,
    val mode: String? = null,
)

internal data class XrayDatLookupResult(
    val file: XrayDatFile,
    val value: String,
    val matches: List<XrayDatTag>,
)

data class XrayDatState(
    val files: List<XrayDatFile> = emptyList(),
    val selectedKind: XrayDatKind = XrayDatKind.GeoSite,
    val selectedFilePath: String = "",
    val geodatInstalled: Boolean? = null,
    val geodatMessage: String? = null,
    val tags: List<XrayDatTag> = emptyList(),
    val tagQuery: String = "",
    val valueQuery: String = "",
    val lookupMatches: List<XrayDatTag>? = null,
    val isLookingUpValue: Boolean = false,
    val lookupError: String? = null,
    val selectedTag: String? = null,
    val items: List<XrayDatItem> = emptyList(),
    val itemQuery: String = "",
    val itemOffset: Int = 0,
    val itemLimit: Int = XRAY_DAT_PAGE_SIZE,
    val itemTotal: Int? = null,
    val searchCursor: Int = 0,
    val searchNextCursor: Int? = null,
    val searchViewed: Int = 0,
    val searchMode: String? = null,
    val isLoadingCatalog: Boolean = false,
    val isLoadingTags: Boolean = false,
    val isLoadingItems: Boolean = false,
    val hasLoadedCatalog: Boolean = false,
    val catalogError: String? = null,
    val tagsError: String? = null,
    val itemsError: String? = null,
) {
    val selectedFile: XrayDatFile?
        get() = files.firstOrNull { it.path == selectedFilePath }

    val visibleTags: List<XrayDatTag>
        get() {
            val query = tagQuery.trim().lowercase()
            return if (query.isBlank()) tags else tags.filter { query in it.name.lowercase() }
        }

    val isItemSearch: Boolean
        get() = itemQuery.isNotBlank()

    val canLoadPreviousPage: Boolean
        get() = !isItemSearch && itemOffset > 0

    val canLoadNextPage: Boolean
        get() = if (isItemSearch) {
            searchNextCursor != null
        } else {
            itemTotal?.let { itemOffset + items.size < it } ?: (items.size >= itemLimit)
        }
}

internal interface XrayDatPort {
    suspend fun loadCatalog(baseUrl: String): XrayDatCatalog

    suspend fun loadTags(baseUrl: String, file: XrayDatFile): XrayDatTagsSnapshot

    suspend fun loadTagPage(
        baseUrl: String,
        file: XrayDatFile,
        tag: String,
        offset: Int,
        limit: Int,
    ): XrayDatItemsPage

    suspend fun searchTag(
        baseUrl: String,
        file: XrayDatFile,
        tag: String,
        query: String,
        cursor: Int,
        limit: Int,
    ): XrayDatSearchPage

    suspend fun lookupValue(
        baseUrl: String,
        file: XrayDatFile,
        value: String,
    ): XrayDatLookupResult
}

internal class WebPanelXrayDatPort(
    private val transport: CompanionHttpTransport,
) : XrayDatPort {
    override suspend fun loadCatalog(baseUrl: String): XrayDatCatalog {
        val status = loadGeodatStatus(baseUrl)
        val files = buildList {
            addAll(loadDirectory(baseUrl, XRAY_DAT_DIRECTORY))
            addAll(loadDirectory(baseUrl, XRAY_DIRECTORY))
        }.distinctBy { it.path.lowercase() }
            .sortedWith(compareBy<XrayDatFile>({ it.kind.ordinal }, { it.name.lowercase() }))
        return XrayDatCatalog(
            files = files,
            geodatInstalled = status.first,
            geodatMessage = status.second,
        )
    }

    override suspend fun loadTags(baseUrl: String, file: XrayDatFile): XrayDatTagsSnapshot =
        parseXrayDatTags(
            body = transport.get(
                CompanionHttpRequest(
                    baseUrl = baseUrl,
                    endpoint = "/api/routing/dat/tags?kind=${file.kind.apiValue}&path=${file.path.datUrlEncoded()}",
                ),
            ).body,
            file = file,
        )

    override suspend fun loadTagPage(
        baseUrl: String,
        file: XrayDatFile,
        tag: String,
        offset: Int,
        limit: Int,
    ): XrayDatItemsPage = parseXrayDatItemsPage(
        body = transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = buildString {
                    append("/api/routing/dat/tag?kind=").append(file.kind.apiValue)
                    append("&path=").append(file.path.datUrlEncoded())
                    append("&tag=").append(tag.datUrlEncoded())
                    append("&offset=").append(offset.coerceAtLeast(0))
                    append("&limit=").append(limit.coerceIn(1, XRAY_DAT_PAGE_LIMIT))
                },
            ),
        ).body,
        file = file,
    )

    override suspend fun searchTag(
        baseUrl: String,
        file: XrayDatFile,
        tag: String,
        query: String,
        cursor: Int,
        limit: Int,
    ): XrayDatSearchPage = parseXrayDatSearchPage(
        body = transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = buildString {
                    append("/api/routing/dat/search?kind=").append(file.kind.apiValue)
                    append("&path=").append(file.path.datUrlEncoded())
                    append("&tag=").append(tag.datUrlEncoded())
                    append("&q=").append(query.trim().datUrlEncoded())
                    append("&cursor=").append(cursor.coerceAtLeast(0))
                    append("&limit=").append(limit.coerceIn(1, XRAY_DAT_PAGE_LIMIT))
                },
            ),
        ).body,
        file = file,
    )

    override suspend fun lookupValue(
        baseUrl: String,
        file: XrayDatFile,
        value: String,
    ): XrayDatLookupResult = parseXrayDatLookupResult(
        body = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/routing/dat/lookup",
                body = JSONObject()
                    .put("kind", file.kind.apiValue)
                    .put("path", file.path)
                    .put("value", value.trim())
                    .toString(),
            ),
        ).body,
        file = file,
    )

    private suspend fun loadGeodatStatus(baseUrl: String): Pair<Boolean?, String?> = try {
        parseXrayDatToolStatus(
            transport.get(
                CompanionHttpRequest(baseUrl, "/api/routing/geodat/status"),
            ).body,
        )
    } catch (error: CompanionTransportException) {
        if (error.failure.statusCode == 404) null to "Статус xk-geodat недоступен на этой версии Xkeen UI."
        else throw error
    }

    private suspend fun loadDirectory(baseUrl: String, directory: String): List<XrayDatFile> = try {
        parseXrayDatDirectory(
            body = transport.get(
                CompanionHttpRequest(
                    baseUrl,
                    "/api/fs/list?target=local&path=${directory.datUrlEncoded()}",
                ),
            ).body,
        )
    } catch (error: CompanionTransportException) {
        if (error.failure.statusCode == 404) emptyList() else throw error
    }
}

internal class DemoXrayDatPort : XrayDatPort {
    private val files = listOf(
        XrayDatFile(XrayDatKind.GeoSite, "geosite_v2fly.dat", "$XRAY_DAT_DIRECTORY/geosite_v2fly.dat", 2_254_112, 1_721_000_000),
        XrayDatFile(XrayDatKind.GeoSite, "zkeen.dat", "$XRAY_DAT_DIRECTORY/zkeen.dat", 1_410_048, 1_721_000_100),
        XrayDatFile(XrayDatKind.GeoIp, "geoip_v2fly.dat", "$XRAY_DAT_DIRECTORY/geoip_v2fly.dat", 408_678, 1_721_000_200),
        XrayDatFile(XrayDatKind.GeoIp, "zkeenip.dat", "$XRAY_DAT_DIRECTORY/zkeenip.dat", 399_104, 1_721_000_300),
    )

    override suspend fun loadCatalog(baseUrl: String): XrayDatCatalog =
        XrayDatCatalog(files = files, geodatInstalled = true)

    override suspend fun loadTags(baseUrl: String, file: XrayDatFile): XrayDatTagsSnapshot {
        val names = if (file.kind == XrayDatKind.GeoSite) {
            listOf("CATEGORY-ADS-ALL", "DISCORD", "GITHUB", "GOOGLE", "INSTAGRAM", "NETFLIX", "TELEGRAM", "YOUTUBE")
        } else {
            listOf("PRIVATE", "RU", "DE", "NL", "US", "CLOUDFLARE", "GOOGLE")
        }
        return XrayDatTagsSnapshot(file, names.mapIndexed { index, name -> XrayDatTag(name, 28 + index * 17) })
    }

    override suspend fun loadTagPage(
        baseUrl: String,
        file: XrayDatFile,
        tag: String,
        offset: Int,
        limit: Int,
    ): XrayDatItemsPage {
        val all = demoItems(file.kind, tag)
        return XrayDatItemsPage(file, tag, all.drop(offset).take(limit), offset, limit, all.size)
    }

    override suspend fun searchTag(
        baseUrl: String,
        file: XrayDatFile,
        tag: String,
        query: String,
        cursor: Int,
        limit: Int,
    ): XrayDatSearchPage {
        val matches = demoItems(file.kind, tag).filter { query.lowercase() in it.value.lowercase() }
        return XrayDatSearchPage(file, tag, query, matches.drop(cursor).take(limit), cursor, null, matches.size, matches.size)
    }

    override suspend fun lookupValue(
        baseUrl: String,
        file: XrayDatFile,
        value: String,
    ): XrayDatLookupResult {
        val query = value.trim().lowercase()
        val tags = loadTags(baseUrl, file).tags.filter { tag ->
            query in tag.name.lowercase() || demoItems(file.kind, tag.name).any { query in it.value.lowercase() }
        }
        return XrayDatLookupResult(file, value.trim(), tags)
    }

    private fun demoItems(kind: XrayDatKind, tag: String): List<XrayDatItem> =
        if (kind == XrayDatKind.GeoIp) {
            List(72) { index -> XrayDatItem("cidr", "10.${index / 255}.${index % 255}.0/24") }
        } else {
            listOf(
                "discord.com", "discord.gg", "discordapp.com", "discordapp.net",
                "discord.media", "discord.gift", "discord.design", "discord.new",
            ).map { value -> XrayDatItem("domain", if (tag == "DISCORD") value else "${tag.lowercase()}.$value") }
        }
}

internal fun parseXrayDatToolStatus(body: String): Pair<Boolean?, String?> {
    val root = body.datJsonObject("Xkeen UI вернул неожиданный статус xk-geodat.")
    if (!root.optBoolean("ok", false)) return false to root.datErrorMessage()
    val installed = root.optBoolean("installed", false)
    val message = if (installed) null else {
        root.optString("reason").trim().takeIf(String::isNotBlank)
            ?: "xk-geodat не установлен. Просмотр содержимого доступен после установки через веб-панель."
    }
    return installed to message
}

internal fun parseXrayDatDirectory(body: String): List<XrayDatFile> {
    val root = body.datJsonObject("Xkeen UI вернул неожиданный список DAT-файлов.")
    if (!root.optBoolean("ok", false)) throw XrayDatException(root.datErrorMessage())
    val directory = root.optString("path").trim().trimEnd('/')
    val items = root.optJSONArray("items") ?: return emptyList()
    return buildList {
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val type = item.optString("type").trim().lowercase()
            if (type !in setOf("file", "link")) continue
            val name = item.optString("name").trim()
            val kind = name.datKindOrNull() ?: continue
            add(
                XrayDatFile(
                    kind = kind,
                    name = name,
                    path = if (directory.isBlank()) name else "$directory/$name",
                    sizeBytes = item.optLongOrNull("size"),
                    modifiedAtEpochSeconds = item.optLongOrNull("mtime"),
                ),
            )
        }
    }
}

internal fun parseXrayDatTags(body: String, file: XrayDatFile): XrayDatTagsSnapshot {
    val root = body.datJsonObject("Xkeen UI вернул неожиданный список DAT-тегов.")
    root.requireDatSuccess()
    val tagsJson = root.optJSONArray("tags")
    val tags = buildList {
        if (tagsJson != null) {
            for (index in 0 until tagsJson.length()) {
                val raw = tagsJson.opt(index)
                val name: String
                val count: Int?
                if (raw is JSONObject) {
                    name = raw.optString("tag").trim().ifBlank { raw.optString("t").trim() }
                    count = raw.optIntOrNull("count") ?: raw.optIntOrNull("c")
                } else {
                    name = raw?.toString()?.trim().orEmpty()
                    count = null
                }
                if (name.isNotBlank()) add(XrayDatTag(name, count))
            }
        }
    }.distinctBy { it.name.lowercase() }
        .sortedBy { it.name.lowercase() }
    return XrayDatTagsSnapshot(file, tags)
}

internal fun parseXrayDatItemsPage(body: String, file: XrayDatFile): XrayDatItemsPage {
    val root = body.datJsonObject("Xkeen UI вернул неожиданное содержимое DAT-тега.")
    root.requireDatSuccess()
    return XrayDatItemsPage(
        file = file,
        tag = root.optString("tag").trim(),
        items = root.datItems(),
        offset = root.optInt("offset", 0).coerceAtLeast(0),
        limit = root.optInt("limit", XRAY_DAT_PAGE_SIZE).coerceAtLeast(1),
        total = root.optIntOrNull("total"),
    )
}

internal fun parseXrayDatSearchPage(body: String, file: XrayDatFile): XrayDatSearchPage {
    val root = body.datJsonObject("Xkeen UI вернул неожиданный результат поиска DAT.")
    root.requireDatSuccess()
    return XrayDatSearchPage(
        file = file,
        tag = root.optString("tag").trim(),
        query = root.optString("q").trim(),
        items = root.datItems(),
        cursor = root.optInt("cursor", 0).coerceAtLeast(0),
        nextCursor = root.optIntOrNull("next_cursor"),
        viewed = root.optInt("viewed", 0).coerceAtLeast(0),
        total = root.optIntOrNull("total"),
        mode = root.optString("mode").trim().takeIf(String::isNotBlank),
    )
}

internal fun parseXrayDatLookupResult(body: String, file: XrayDatFile): XrayDatLookupResult {
    val root = body.datJsonObject("Xkeen UI вернул неожиданный результат поиска по DAT-файлу.")
    root.requireDatSuccess()
    val matchesJson = root.optJSONArray("matches")
    val matches = buildList {
        if (matchesJson != null) {
            for (index in 0 until matchesJson.length()) {
                val raw = matchesJson.opt(index)
                val name: String
                val count: Int?
                if (raw is JSONObject) {
                    name = raw.optString("tag").trim().ifBlank { raw.optString("t").trim() }
                    count = raw.optIntOrNull("count") ?: raw.optIntOrNull("c")
                } else {
                    name = raw?.toString()?.trim().orEmpty()
                    count = null
                }
                if (name.isNotBlank()) add(XrayDatTag(name, count))
            }
        }
    }.distinctBy { it.name.lowercase() }
        .sortedBy { it.name.lowercase() }
    return XrayDatLookupResult(
        file = file,
        value = root.optString("value").trim(),
        matches = matches,
    )
}

internal const val XRAY_DAT_PAGE_SIZE = 100
private const val XRAY_DAT_PAGE_LIMIT = 500
private const val XRAY_DAT_DIRECTORY = "/opt/etc/xray/dat"
private const val XRAY_DIRECTORY = "/opt/etc/xray"

private fun String.datKindOrNull(): XrayDatKind? {
    val value = lowercase()
    if (!value.endsWith(".dat")) return null
    return when {
        value.startsWith("geosite") || value == "zkeen.dat" -> XrayDatKind.GeoSite
        value.startsWith("geoip") || value == "zkeenip.dat" -> XrayDatKind.GeoIp
        else -> null
    }
}

private fun String.datUrlEncoded(): String = URLEncoder.encode(this, StandardCharsets.UTF_8.name())

private fun String.datJsonObject(message: String): JSONObject = try {
    JSONObject(this)
} catch (error: Exception) {
    throw XrayDatException(message, error)
}

private fun JSONObject.requireDatSuccess() {
    if (!optBoolean("ok", false)) throw XrayDatException(datErrorMessage())
}

private fun JSONObject.datErrorMessage(): String {
    val hint = optString("hint").trim()
    if (hint.isNotBlank()) return hint
    val code = optString("code").trim().ifBlank { optString("error").trim() }
    return when (code) {
        "missing_xk_geodat" -> "Для просмотра содержимого нужен xk-geodat. Установите его через веб-панель."
        "missing_dat_file" -> "DAT-файл не найден на роутере."
        "xk_geodat_timeout" -> "xk-geodat не ответил вовремя. Повторите запрос."
        "xk_geodat_failed" -> "xk-geodat не смог прочитать DAT-файл."
        else -> code.takeIf(String::isNotBlank) ?: "Не удалось прочитать DAT-файл."
    }
}

private fun JSONObject.datItems(): List<XrayDatItem> {
    val array = optJSONArray("items") ?: return emptyList()
    return buildList {
        for (index in 0 until array.length()) {
            val raw = array.opt(index)
            val type: String
            val value: String
            if (raw is JSONObject) {
                type = raw.optString("t").trim().ifBlank { raw.optString("type").trim() }
                value = raw.optString("v").trim().ifBlank { raw.optString("value").trim() }
            } else {
                type = ""
                value = raw?.toString()?.trim().orEmpty()
            }
            if (value.isNotBlank()) add(XrayDatItem(type, value))
        }
    }
}

private fun JSONObject.optLongOrNull(name: String): Long? =
    if (has(name) && !isNull(name)) optLong(name) else null

private fun JSONObject.optIntOrNull(name: String): Int? =
    if (has(name) && !isNull(name)) optInt(name) else null

internal class XrayDatException(message: String, cause: Throwable? = null) : Exception(message, cause)
