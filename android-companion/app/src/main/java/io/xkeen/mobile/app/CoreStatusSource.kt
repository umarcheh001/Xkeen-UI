package io.xkeen.mobile.app

import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal data class CoreStatus(
    val availableCores: List<String>,
    val currentCore: String?,
)

internal interface CoreStatusSource {
    suspend fun load(baseUrl: String): CoreStatus
}

internal class WebPanelCoreStatusSource : CoreStatusSource {
    override suspend fun load(baseUrl: String): CoreStatus = withContext(Dispatchers.IO) {
        val connection = resolveCoreEndpoint(baseUrl).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 5_000
            connection.readTimeout = 10_000
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-cache")

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                throw CoreStatusException("HTTP $status при загрузке списка ядер.")
            }
            if (connection.contentType.orEmpty().contains("text/html", ignoreCase = true)) {
                throw CoreStatusException(
                    "Xkeen UI вернул страницу входа. Подключите авторизованную сессию.",
                )
            }

            parseCoreStatus(body)
        } finally {
            connection.disconnect()
        }
    }
}

internal class CoreStatusException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

internal fun parseCoreStatus(body: String): CoreStatus {
    val payload = try {
        JSONObject(body)
    } catch (error: Exception) {
        throw CoreStatusException(
            "Xkeen UI вернул неожиданный ответ при загрузке списка ядер.",
            error,
        )
    }
    if (!payload.optBoolean("ok", false)) {
        throw CoreStatusException("Сервер не вернул список доступных ядер.")
    }

    val coresJson = payload.optJSONArray("cores")
        ?: throw CoreStatusException("В ответе сервера отсутствует список ядер.")
    val cores = buildList {
        for (index in 0 until coresJson.length()) {
            canonicalCoreName(coresJson.optString(index))?.let(::add)
        }
    }.distinctBy(String::lowercase)
    if (cores.isEmpty()) {
        throw CoreStatusException("На сервере не найдены поддерживаемые ядра Xray или Mihomo.")
    }

    return CoreStatus(
        availableCores = cores,
        currentCore = canonicalCoreName(payload.optString("currentCore")),
    )
}

internal fun canonicalCoreName(value: String): String? =
    when (value.trim().lowercase()) {
        "xray" -> "Xray"
        "mihomo" -> "Mihomo"
        else -> null
    }

private fun resolveCoreEndpoint(baseUrl: String): URI {
    val normalizedBase = baseUrl.trim().trimEnd('/')
    if (normalizedBase.isBlank()) {
        throw CoreStatusException("Не указан адрес Xkeen UI.")
    }
    return try {
        URI.create("$normalizedBase/api/xkeen/core")
    } catch (error: IllegalArgumentException) {
        throw CoreStatusException("Некорректный адрес Xkeen UI.", error)
    }
}
