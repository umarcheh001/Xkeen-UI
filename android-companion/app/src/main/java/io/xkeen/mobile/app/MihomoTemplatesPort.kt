package io.xkeen.mobile.app

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import org.json.JSONObject

data class MihomoTemplate(
    val name: String,
)

internal interface MihomoTemplatesPort {
    suspend fun list(baseUrl: String): List<MihomoTemplate>

    suspend fun load(baseUrl: String, name: String): String
}

internal class WebPanelMihomoTemplatesPort(
    private val transport: CompanionHttpTransport,
) : MihomoTemplatesPort {
    override suspend fun list(baseUrl: String): List<MihomoTemplate> {
        val response = transport.get(
            CompanionHttpRequest(baseUrl = baseUrl, endpoint = "/api/mihomo-templates"),
        )
        val root = response.requireMihomoTemplatesJson("списка шаблонов Mihomo")
        if (!root.optBoolean("ok", false)) {
            throw MihomoTemplatesException("Xkeen UI не подтвердил загрузку шаблонов Mihomo.")
        }
        val templates = root.optJSONArray("templates")
            ?: throw MihomoTemplatesException("Xkeen UI не вернул список шаблонов Mihomo.")
        return buildList {
            for (index in 0 until templates.length()) {
                val name = templates.optJSONObject(index)?.optString("name").orEmpty().trim()
                if (name.isNotEmpty()) add(MihomoTemplate(name))
            }
        }.distinctBy { it.name }.sortedBy { it.name.lowercase() }
    }

    override suspend fun load(baseUrl: String, name: String): String {
        val encodedName = URLEncoder.encode(name, StandardCharsets.UTF_8.toString()).replace("+", "%20")
        val response = transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/mihomo-template?name=$encodedName",
            ),
        )
        val root = response.requireMihomoTemplatesJson("шаблона Mihomo")
        if (!root.optBoolean("ok", false) || !root.has("content")) {
            throw MihomoTemplatesException("Xkeen UI не вернул содержимое шаблона $name.")
        }
        return root.optString("content")
    }
}

internal class DemoMihomoTemplatesPort : MihomoTemplatesPort {
    private val content = linkedMapOf(
        "default.yaml" to "mixed-port: 7890\n",
        "router.yaml" to "mode: rule\n",
    )

    override suspend fun list(baseUrl: String): List<MihomoTemplate> =
        content.keys.map(::MihomoTemplate)

    override suspend fun load(baseUrl: String, name: String): String =
        content[name] ?: throw MihomoTemplatesException("Шаблон $name не найден.")
}

internal class MihomoTemplatesException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

private fun CompanionHttpResponse.requireMihomoTemplatesJson(operation: String): JSONObject = try {
    JSONObject(body)
} catch (error: Exception) {
    throw MihomoTemplatesException("Xkeen UI вернул некорректный ответ $operation.", error)
}
