package io.xkeen.mobile.app

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import org.json.JSONArray
import org.json.JSONObject

private const val XRAY_LOGS_STATUS_PATH = "/api/xray-logs/status"
private const val XRAY_LOGS_ENABLE_PATH = "/api/xray-logs/enable"
private const val XRAY_LOGS_DISABLE_PATH = "/api/xray-logs/disable"
private const val XRAY_LOGS_DEVICES_PATH = "/api/xray-logs/devices"

internal data class XrayLogsControlSnapshot(
    val logLevel: String,
)

internal data class XrayLogsControlResult(
    val logLevel: String,
    val xrayRestarted: Boolean,
    val detail: String,
)

internal data class XrayLogDevicesSnapshot(
    val devices: List<XrayLogDevice>,
    val routerError: String? = null,
)

internal interface XrayLogsControlPort {
    suspend fun loadStatus(baseUrl: String): XrayLogsControlSnapshot

    suspend fun enable(baseUrl: String, logLevel: String): XrayLogsControlResult

    suspend fun disable(baseUrl: String): XrayLogsControlResult

    suspend fun loadDevices(baseUrl: String, refreshRouter: Boolean = true): XrayLogDevicesSnapshot

    suspend fun saveDevice(baseUrl: String, ip: String, name: String): XrayLogDevicesSnapshot

    suspend fun deleteDevice(baseUrl: String, ip: String): XrayLogDevicesSnapshot
}

internal class WebPanelXrayLogsControlPort(
    private val transport: CompanionHttpTransport,
) : XrayLogsControlPort {
    override suspend fun loadStatus(baseUrl: String): XrayLogsControlSnapshot {
        val response = transport.get(
            CompanionHttpRequest(baseUrl = baseUrl, endpoint = XRAY_LOGS_STATUS_PATH),
        )
        val root = response.body.asXrayLogsJson("состояние логирования")
        return XrayLogsControlSnapshot(
            logLevel = root.optString("loglevel", "none").normalizedXrayLogLevel(),
        )
    }

    override suspend fun enable(baseUrl: String, logLevel: String): XrayLogsControlResult {
        val normalized = logLevel.normalizedEnabledXrayLogLevel()
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = XRAY_LOGS_ENABLE_PATH,
                body = JSONObject().put("loglevel", normalized).toString(),
            ),
        )
        return response.body.parseXrayLogsControlResult(
            operation = "включение логов Xray",
            fallbackLevel = normalized,
        )
    }

    override suspend fun disable(baseUrl: String): XrayLogsControlResult {
        val response = transport.post(
            CompanionHttpRequest(baseUrl = baseUrl, endpoint = XRAY_LOGS_DISABLE_PATH),
        )
        return response.body.parseXrayLogsControlResult(
            operation = "остановку логов Xray",
            fallbackLevel = "none",
        )
    }

    override suspend fun loadDevices(
        baseUrl: String,
        refreshRouter: Boolean,
    ): XrayLogDevicesSnapshot {
        val response = transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "$XRAY_LOGS_DEVICES_PATH?refresh=${if (refreshRouter) 1 else 0}",
            ),
        )
        return response.body.parseXrayLogDevices("загрузку имён устройств")
    }

    override suspend fun saveDevice(
        baseUrl: String,
        ip: String,
        name: String,
    ): XrayLogDevicesSnapshot {
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = XRAY_LOGS_DEVICES_PATH,
                body = JSONObject()
                    .put("ip", ip.trim())
                    .put("name", name.trim())
                    .toString(),
            ),
        )
        return response.body.parseXrayLogDevices("сохранение имени устройства")
    }

    override suspend fun deleteDevice(baseUrl: String, ip: String): XrayLogDevicesSnapshot {
        val encodedIp = URLEncoder.encode(ip.trim(), StandardCharsets.UTF_8.name())
        val response = transport.delete(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "$XRAY_LOGS_DEVICES_PATH/$encodedIp",
            ),
        )
        return response.body.parseXrayLogDevices("удаление имени устройства")
    }
}

internal class DemoXrayLogsControlPort(
    initialLogLevel: String = "info",
    initialDevices: List<XrayLogDevice> = emptyList(),
) : XrayLogsControlPort {
    private var logLevel = initialLogLevel.normalizedXrayLogLevel()
    private val devices = initialDevices.associateBy(XrayLogDevice::ip).toMutableMap()

    override suspend fun loadStatus(baseUrl: String): XrayLogsControlSnapshot =
        XrayLogsControlSnapshot(logLevel)

    override suspend fun enable(baseUrl: String, logLevel: String): XrayLogsControlResult {
        this.logLevel = logLevel.normalizedEnabledXrayLogLevel()
        return XrayLogsControlResult(this.logLevel, xrayRestarted = true, detail = "")
    }

    override suspend fun disable(baseUrl: String): XrayLogsControlResult {
        logLevel = "none"
        return XrayLogsControlResult(logLevel, xrayRestarted = true, detail = "")
    }

    override suspend fun loadDevices(
        baseUrl: String,
        refreshRouter: Boolean,
    ): XrayLogDevicesSnapshot = XrayLogDevicesSnapshot(devices.values.sortedBy(XrayLogDevice::ip))

    override suspend fun saveDevice(
        baseUrl: String,
        ip: String,
        name: String,
    ): XrayLogDevicesSnapshot {
        val normalizedIp = ip.trim()
        require(normalizedIp.isNotBlank()) { "Введите IP-адрес устройства." }
        val normalizedName = name.trim()
        require(normalizedName.isNotBlank()) { "Введите имя устройства." }
        devices[normalizedIp] = XrayLogDevice(normalizedIp, normalizedName, "manual")
        return loadDevices(baseUrl)
    }

    override suspend fun deleteDevice(baseUrl: String, ip: String): XrayLogDevicesSnapshot {
        devices.remove(ip.trim())
        return loadDevices(baseUrl)
    }
}

private fun String.parseXrayLogsControlResult(
    operation: String,
    fallbackLevel: String,
): XrayLogsControlResult {
    val root = asXrayLogsJson(operation)
    if (!root.optBoolean("ok", false)) {
        throw XrayLogsControlException("Xkeen UI не подтвердил $operation.")
    }
    return XrayLogsControlResult(
        logLevel = root.optString("loglevel", fallbackLevel).normalizedXrayLogLevel(),
        xrayRestarted = root.optBoolean("xray_restarted", true),
        detail = root.optString("detail").trim(),
    )
}

private fun String.parseXrayLogDevices(operation: String): XrayLogDevicesSnapshot {
    val root = asXrayLogsJson(operation)
    if (!root.optBoolean("ok", false)) {
        throw XrayLogsControlException("Xkeen UI не подтвердил $operation.")
    }
    return XrayLogDevicesSnapshot(
        devices = root.optJSONArray("devices").toXrayLogDevices(),
        routerError = root.optString("router_error").trim().takeIf(String::isNotBlank),
    )
}

private fun JSONArray?.toXrayLogDevices(): List<XrayLogDevice> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) {
            val item = optJSONObject(index) ?: continue
            val ip = item.optString("ip").trim()
            val name = item.optString("name").trim()
            if (ip.isBlank() || name.isBlank()) continue
            add(
                XrayLogDevice(
                    ip = ip,
                    name = name,
                    source = item.optString("source", "router").trim().ifBlank { "router" },
                    routerName = item.optionalString("router_name"),
                    mac = item.optionalString("mac"),
                    hostname = item.optionalString("hostname"),
                ),
            )
        }
    }.sortedWith(compareBy<XrayLogDevice>({ it.ip.ipv4SortKey() }, { it.ip }, { it.name }))
}

private fun JSONObject.optionalString(key: String): String? =
    optString(key).trim().takeIf { it.isNotBlank() && !it.equals("null", ignoreCase = true) }

private fun String.normalizedXrayLogLevel(): String =
    trim().lowercase().takeIf { it in setOf("none", "error", "warning", "info", "debug") } ?: "none"

private fun String.normalizedEnabledXrayLogLevel(): String =
    normalizedXrayLogLevel().takeUnless { it == "none" } ?: "info"

private fun String.ipv4SortKey(): Long = split('.')
    .takeIf { it.size == 4 }
    ?.mapNotNull(String::toIntOrNull)
    ?.takeIf { parts -> parts.size == 4 && parts.all { it in 0..255 } }
    ?.fold(0L) { result, part -> (result shl 8) + part }
    ?: Long.MAX_VALUE

private fun String.asXrayLogsJson(operation: String): JSONObject = try {
    JSONObject(this)
} catch (error: Exception) {
    throw XrayLogsControlException("Xkeen UI вернул некорректный ответ на $operation.", error)
}

internal class XrayLogsControlException(message: String, cause: Throwable? = null) :
    Exception(message, cause)
